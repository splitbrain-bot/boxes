import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from './config.ts';
import { CredentialStore, type CredentialId, type CredentialMethod } from './credentials.ts';
import { openDb, type Db } from './db.ts';
import { EgressManager } from './egress.ts';
import {
  containerProcesses,
  createLoginContainer,
  createContainer,
  killInContainer,
  seedHomeFromImage,
  setDockerForTests,
} from './docker.ts';

let dirs: string[] = [];
let dbs: Db[] = [];

afterEach(() => {
  for (const d of dbs) d.close();
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Creates a temporary data directory that afterEach removes. */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-docker-'));
  dirs.push(dir);
  return dir;
}

/**
 * A deployment: a config, a credential store holding whatever was passed, and
 * a prepared egress manager over both.
 */
async function deployment(
  secrets: Partial<Record<CredentialId, string>> = {},
  over: Record<string, string> = {},
  methods: Partial<Record<CredentialId, CredentialMethod>> = {},
): Promise<{ cfg: Config; db: Db; egress: EgressManager }> {
  const cfg = loadConfig({ DATA_DIR: dataDir(), ...over });
  const db = openDb(cfg.DATA_DIR);
  dbs.push(db);
  const credentials = new CredentialStore(db, () => {}, cfg.credentialSet);
  for (const [id, secret] of Object.entries(secrets)) {
    credentials.put(id as CredentialId, methods[id as CredentialId] ?? 'token', secret);
  }
  const egress = new EgressManager(cfg, credentials, db);
  await egress.prepare();
  return { cfg, db, egress };
}

describe('the container template', () => {
  /** Captures what createContainer would ask the daemon for. */
  async function capture(): Promise<Record<string, unknown>> {
    const { cfg } = await deployment();

    let opts: Record<string, unknown> = {};
    setDockerForTests({
      createContainer: async (o: Record<string, unknown>) => {
        opts = o;
        return { id: 'deadbeef' };
      },
    } as unknown as Docker);
    try {
      await createContainer(
        {
          boxId: 'abcd1234',
          image: cfg.BOX_IMAGE,
          networkName: 'bn-abcd1234',
          subnet: '10.200.0.0/29',
          workspaceSource: '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234',
          homeSource: '/var/lib/docker/volumes/boxes-data/_data/homes/abcd1234',
          nixSource: '/var/lib/docker/volumes/boxes-data/_data/nix/abcd1234',
          env: {},
        },
        cfg,
      );
    } finally {
      setDockerForTests(null);
    }
    return opts;
  }

  it('binds the workspace, the home and the nix store from host paths', async () => {
    const opts = await capture();
    const host = opts['HostConfig'] as { Binds: string[] };
    // Paths, not volume names: the orchestrator reads these files itself, for
    // review and to measure the size of a box.
    assert.deepEqual(host.Binds, [
      '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234:/workspace',
      '/var/lib/docker/volumes/boxes-data/_data/homes/abcd1234:/home/agent',
      // At /nix and nowhere else: the binary cache is built against that
      // path, and nothing in it would substitute anywhere else.
      '/var/lib/docker/volumes/boxes-data/_data/nix/abcd1234:/nix',
    ]);
  }, 30_000);

  it('seeds a new home from the image, as root, and hands it to the agent', async () => {
    let opts: Record<string, unknown> = {};
    setDockerForTests({
      createContainer: async (o: Record<string, unknown>) => {
        opts = o;
        return {
          start: async () => {},
          wait: async () => ({ StatusCode: 0 }),
          remove: async () => {},
        };
      },
    } as unknown as Docker);
    try {
      await seedHomeFromImage(
        '/var/lib/docker/volumes/boxes-data/_data/homes/abcd1234',
        'boxes-box:latest',
        'abcd1234',
      );
    } finally {
      setDockerForTests(null);
    }

    const host = opts['HostConfig'] as { Binds: string[]; NetworkMode: string };
    assert.deepEqual(host.Binds, [
      '/var/lib/docker/volumes/boxes-data/_data/homes/abcd1234:/to',
    ]);
    // A bind mount hides what the image put in /home/agent, so the home is
    // copied from the image. Its skeleton .profile puts ~/.local/bin, where
    // `npm install -g` installs, on the PATH of a login shell.
    //
    // The chown is recursive: `cp -a` keeps the uid the image was built on,
    // which is not BOX_UID when the two were set apart.
    assert.deepEqual(opts['Cmd'], ['cp -a /home/agent/. /to/ && chown -R 1020:1020 /to']);
    // As root, so the copy and the chown both work. The orchestrator may not
    // run as root itself.
    assert.equal(opts['User'], 'root');
    assert.equal(host.NetworkMode, 'none');
  }, 30_000);

  it('runs as the configured uid and gid, not the image\'s user name', async () => {
    const opts = await capture();
    // Numbers, so BOX_UID alone decides who a box runs as. The default avoids
    // 1000, which on a host usually belongs to a person.
    assert.equal(opts['User'], '1020:1020');
  }, 30_000);

  it('tells an outside updater to leave box containers alone', async () => {
    const opts = await capture();
    const labels = opts['Labels'] as Record<string, string>;
    // The box id is how Boxes finds its own containers again.
    assert.equal(labels['boxes.box'], 'abcd1234');
    // This label tells an updater to leave the container alone. A recreated
    // container loses its id in the database and its proxy attachment, which
    // is the box's only way out. The orchestrator moves boxes onto a new image
    // itself, at start.
    assert.equal(labels['com.centurylinklabs.watchtower.enable'], 'false');
  }, 30_000);

  it('keeps the isolation the workspace change does not touch', async () => {
    const opts = await capture();
    const host = opts['HostConfig'] as Record<string, unknown>;
    assert.equal(opts['User'], '1020:1020');
    assert.equal(host['ReadonlyRootfs'], true);
    assert.deepEqual(host['CapDrop'], ['ALL']);
    assert.equal(host['Privileged'], false);
    assert.deepEqual(host['SecurityOpt'], ['no-new-privileges:true']);
  }, 30_000);

  // The box image drops Playwright's --disable-dev-shm-usage because of this
  // size. Without it, Chromium gets Docker's 64 MB /dev/shm and reports the
  // exhaustion as a closed target on a large page.
  it('gives the browser enough shared memory to not need the flag', async () => {
    const opts = await capture();
    const host = opts['HostConfig'] as Record<string, unknown>;
    assert.equal(host['ShmSize'], 512 * 1024 * 1024);
  }, 30_000);
});

describe('the login container', () => {
  /** What createLoginContainer would ask the daemon for. */
  async function capture(): Promise<Record<string, unknown>> {
    let opts: Record<string, unknown> = {};
    setDockerForTests({
      createContainer: async (o: Record<string, unknown>) => {
        opts = o;
        return { id: 'login1' };
      },
    } as unknown as Docker);
    try {
      await createLoginContainer({ image: 'boxes-box:latest', credentialId: 'openai' });
    } finally {
      setDockerForTests(null);
    }
    return opts;
  }

  it('is nobody\'s box: no bind, no credential, and a home it can write', async () => {
    const opts = await capture();
    const host = opts['HostConfig'] as Record<string, unknown>;

    // The CLI authenticates a person to their own service. The container
    // holds no deployment secret for an egress policy to protect.
    assert.equal(host['Binds'], undefined);
    assert.deepEqual(opts['Env'], []);
    // The rootfs is read-only, and both CLIs write their state under $HOME.
    const tmpfs = host['Tmpfs'] as Record<string, string>;
    assert.match(tmpfs['/home/agent'] ?? '', /rw/);
    assert.equal(host['ReadonlyRootfs'], true);
    assert.deepEqual(host['CapDrop'], ['ALL']);
    assert.equal(host['Privileged'], false);
    assert.equal(opts['User'], '1020:1020');
  }, 30_000);

  it('sits on the default bridge, which is the point of it', async () => {
    const opts = await capture();
    // The one container Boxes creates with a route out of its own: the login
    // hosts are the service's, not the deployment's, and it lives for minutes.
    assert.equal((opts['HostConfig'] as Record<string, unknown>)['NetworkMode'], 'bridge');
  }, 30_000);

  it('carries the credential it is for, so a crash mid-flow can be swept', async () => {
    const opts = await capture();
    const labels = opts['Labels'] as Record<string, string>;
    assert.equal(labels['boxes.login'], 'openai');
    // It is not a box, so nothing that reads the box label finds it.
    assert.equal(labels['boxes.box'], undefined);
  }, 30_000);
});

/**
 * How the box's process table is read, which is what says whether a
 * conversation has anything still running in it, and which pids a stop
 * signals.
 */
describe('reading and signalling what is running in a container', () => {
  afterEach(() => setDockerForTests(null));

  /** A daemon whose execs answer with `output` and record their commands. */
  function fakeExec(output: string, exitCode = 0): { ran: string[][] } {
    const ran: string[][] = [];
    const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;
    setDockerForTests({
      modem,
      getContainer: () => ({
        exec: async ({ Cmd }: { Cmd: string[] }) => {
          ran.push(Cmd);
          const payload = Buffer.from(output, 'utf8');
          const header = Buffer.alloc(8);
          header[0] = 1;
          header.writeUInt32BE(payload.length, 4);
          return {
            start: async () => Readable.from([Buffer.concat([header, payload])]),
            inspect: async () => ({ ExitCode: exitCode }),
          };
        },
      }),
    } as unknown as Docker);
    return { ran };
  }

  it('parses what the box\'s own ps prints, spaces and all', async () => {
    const { ran } = fakeExec(
      [
        '    PID    PPID ELAPSED COMMAND',
        '      1       0     900 /sbin/docker-init',
        '  23490   23019     154 /bin/bash -c eval \'sleep 300; echo done\'',
      ].join('\n'),
    );
    const processes = await containerProcesses('c1');
    assert.deepEqual(ran, [['ps', '-eo', 'pid,ppid,etimes,args']]);
    assert.deepEqual(processes, [
      { pid: 1, ppid: 0, command: '/sbin/docker-init', elapsedSeconds: 900 },
      {
        pid: 23490,
        ppid: 23019,
        command: "/bin/bash -c eval 'sleep 300; echo done'",
        elapsedSeconds: 154,
      },
    ]);
  });

  it('says so when the box has no ps to ask', async () => {
    // "Nothing is running" would make a stop look like its target was
    // already gone.
    fakeExec('ps: command not found', 127);
    await expect(containerProcesses('c1')).rejects.toThrow(/exited 127/);
  });

  it('signals pids as arguments, never as a line for a shell to take apart', async () => {
    const { ran } = fakeExec('');
    await killInContainer('c1', 'TERM', [15, 14]);
    assert.deepEqual(ran, [['kill', '-TERM', '15', '14']]);
  });

  it('has nothing to signal for an empty list', async () => {
    const { ran } = fakeExec('');
    await killInContainer('c1', 'KILL', []);
    assert.deepEqual(ran, []);
  });
});
