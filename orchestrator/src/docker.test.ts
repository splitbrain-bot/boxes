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
  containerProcessesFromInside,
  createContainer,
  credentialEnv,
  killInContainer,
  resetPsFormatForTests,
  seedHomeFromImage,
  boxEnv,
  setDockerForTests,
  type CreateContainerSpec,
} from './docker.ts';
import { readSettings } from './settings.ts';

/** A real Claude token as the store holds it. */
const CLAUDE_TOKEN = 'sk-ant-oat01-the-real-claude-token';

/** A real Anthropic API key as the store holds it. */
const ANTHROPIC_KEY = 'sk-ant-api03-the-real-anthropic-key';

/** A real GitHub token as the store holds it. */
const GH_TOKEN = 'ghp_therealgithubtoken';

/** A real OpenAI API key as the store holds it. */
const OPENAI_KEY = 'sk-therealopenaiapikey';

/** A real GitLab token as the store holds it. */
const GITLAB_TOKEN = 'glpat-therealgitlabtoken';

/** A real Dev Tunnels token as the store holds it. */
const DEVTUNNELS_TOKEN = 'ghu_therealdevtunnelstoken';

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

/** The env of one box, as a map, for a given deployment. */
async function envFor(
  secrets: Partial<Record<CredentialId, string>> = {},
  over: Record<string, string> = {},
  methods: Partial<Record<CredentialId, CredentialMethod>> = {},
): Promise<Record<string, string>> {
  const { cfg, db, egress } = await deployment(secrets, over, methods);
  const settings = readSettings(db);
  const spec: CreateContainerSpec = {
    boxId: 'abcd1234',
    image: cfg.BOX_IMAGE,
    networkName: 'bn-abcd1234',
    subnet: '10.200.0.0/29',
    workspaceSource: '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234',
    agentConfigSource: '/var/lib/docker/volumes/boxes-data/_data/agents/abcd1234',
    homeSource: '/var/lib/docker/volumes/boxes-data/_data/homes/abcd1234',
    nixSource: '/var/lib/docker/volumes/boxes-data/_data/nix/abcd1234',
    env: credentialEnv(
      (id) => egress.placeholderFor(id),
      (id) => egress.methodFor(id),
      settings,
      cfg.GITLAB_HOST,
    ),
    caCertificate: egress.caCertificate(),
  };

  return Object.fromEntries(
    boxEnv(spec, cfg).map((entry) => {
      const eq = entry.indexOf('=');
      return [entry.slice(0, eq), entry.slice(eq + 1)];
    }),
  );
}

describe('boxEnv', () => {
  it('carries placeholders, and no real credential anywhere in it', async () => {
    const env = await envFor({ claude: CLAUDE_TOKEN, github: GH_TOKEN });

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toMatch(/^sk-ant-oat01-/);
    expect(env['GH_TOKEN']).toMatch(/^ghp_/);

    const everything = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    expect(everything).not.toContain(CLAUDE_TOKEN);
    expect(everything).not.toContain(GH_TOKEN);
  }, 30_000);

  it('carries a Claude API key as ANTHROPIC_API_KEY instead of the OAuth token', async () => {
    // Claude Code sends the API key as x-api-key, and it wins over a token.
    const env = await envFor({ claude: ANTHROPIC_KEY }, {}, { claude: 'api_key' });

    expect(env['ANTHROPIC_API_KEY']).toMatch(/^sk-ant-/);
    expect(env['ANTHROPIC_API_KEY']).not.toBe(ANTHROPIC_KEY);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  }, 30_000);

  it('carries no credential variable where nothing is configured', async () => {
    const env = await envFor();

    // A box holds a placeholder for a stored credential only. One entered
    // later reaches the box at its next restart.
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['CODEX_API_KEY']).toBeUndefined();
    // What each harness needs beside its credential still comes from the registry.
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/home/agent/.claude');
    expect(env['CODEX_HOME']).toBe('/home/agent/.codex');
  }, 30_000);

  it('carries the GitLab host always, and the token once one is stored', async () => {
    // glab reads the host, and the entrypoint points the credential helper at it.
    const env = await envFor();
    expect(env['GITLAB_TOKEN']).toBeUndefined();
    expect(env['GITLAB_HOST']).toBe('gitlab.com');

    const own = await envFor({ gitlab: GITLAB_TOKEN }, { GITLAB_HOST: 'gitlab.example.com' });
    expect(own['GITLAB_TOKEN']).toMatch(/^glpat-/);
    expect(own['GITLAB_TOKEN']).not.toBe(GITLAB_TOKEN);
    expect(own['GITLAB_HOST']).toBe('gitlab.example.com');
  }, 30_000);

  it('carries a Dev Tunnels placeholder for the share-app skill', async () => {
    const env = await envFor({ devtunnels: DEVTUNNELS_TOKEN });
    expect(env['DEVTUNNELS_TOKEN']).toMatch(/^ghu_/);
    expect(env['DEVTUNNELS_TOKEN']).not.toBe(DEVTUNNELS_TOKEN);
  }, 30_000);

  it('carries what Codex needs to log itself in from the environment', async () => {
    // The Codex app-server reads no key from its environment; `codex-acp` is
    // what reads CODEX_API_KEY, and it only does so when DEFAULT_AUTH_REQUEST
    // tells it to log in with the api-key method on the first `session/*` call.
    // The value has to reach the box as the JSON the adapter parses.
    const env = await envFor({ openai: OPENAI_KEY });

    expect(env['CODEX_API_KEY']).toMatch(/^sk-/);
    expect(env['CODEX_API_KEY']).not.toBe(OPENAI_KEY);
    expect(env['DEFAULT_AUTH_REQUEST']).toBe('{"methodId":"api-key"}');
    expect(JSON.parse(env['DEFAULT_AUTH_REQUEST']!)).toEqual({ methodId: 'api-key' });
    // A fresh Codex thread starts where the registry says, and the browser
    // method is hidden because nothing in a box can open one.
    expect(env['INITIAL_AGENT_MODE']).toBe('agent-full-access');
    expect(env['NO_BROWSER']).toBe('1');
  }, 30_000);

  it('points every client at the CA, whether or not anything is intercepted', async () => {
    const path = '/home/agent/.boxes/ca-bundle.crt';
    for (const env of [await envFor({ github: GH_TOKEN }), await envFor()]) {
      expect(env['BOXES_PROXY_CA']).toContain('BEGIN CERTIFICATE');
      expect(env['NODE_EXTRA_CA_CERTS']).toBe(path);
      expect(env['SSL_CERT_FILE']).toBe(path);
      expect(env['GIT_SSL_CAINFO']).toBe(path);
      expect(env['CURL_CA_BUNDLE']).toBe(path);
      // Codex reads this one before SSL_CERT_FILE.
      expect(env['CODEX_CA_CERTIFICATE']).toBe(path);
    }
  }, 30_000);

  it('still routes every client through the proxy', async () => {
    const env = await envFor();
    expect(env['HTTPS_PROXY']).toBe('http://proxy:3128');
    expect(env['NO_PROXY']).toBe('localhost,127.0.0.1');
  }, 30_000);

  it('carries the git identity from the settings, which is not a credential', async () => {
    const env = await envFor();
    expect(env['GIT_NAME']).toBe('boxes-bot');
    expect(env['GIT_EMAIL']).toBe('boxes-bot@users.noreply.github.com');
  }, 30_000);
});

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
          agentConfigSource: '/var/lib/docker/volumes/boxes-data/_data/agents/abcd1234',
          homeSource: '/var/lib/docker/volumes/boxes-data/_data/homes/abcd1234',
          nixSource: '/var/lib/docker/volumes/boxes-data/_data/nix/abcd1234',
          env: {},
          caCertificate: '',
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
      // Read-only, so the agent cannot change what the dashboard configured.
      '/var/lib/docker/volumes/boxes-data/_data/agents/abcd1234:/boxes/agent:ro',
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
 * conversation has anything still running in it.
 */
describe('reading what is running in a container', () => {
  afterEach(() => {
    setDockerForTests(null);
    resetPsFormatForTests();
  });

  /** A daemon whose `top` answers, or refuses, per format. */
  function fakeTop(answer: (args: string) => { Titles: string[]; Processes: string[][] }): {
    asked: string[];
  } {
    const asked: string[] = [];
    setDockerForTests({
      getContainer: () => ({
        top: async ({ ps_args }: { ps_args: string }) => {
          asked.push(ps_args);
          return answer(ps_args);
        },
      }),
    } as unknown as Docker);
    return { asked };
  }

  it('reads the columns by name and leaves the command whole', async () => {
    fakeTop(() => ({
      Titles: ['PID', 'PPID', 'ELAPSED', 'COMMAND'],
      Processes: [['200', '100', '154', "/bin/bash -c eval 'npm run build' < /dev/null"]],
    }));
    const [p] = await containerProcesses('c1');
    assert.equal(p?.pid, 200);
    assert.equal(p?.ppid, 100);
    assert.equal(p?.elapsedSeconds, 154);
    assert.equal(p?.command, "/bin/bash -c eval 'npm run build' < /dev/null");
  });

  it("asks again without the elapsed time where the host's ps will not take it", async () => {
    // A failed reading keeps every box on the host awake, so the format is
    // retried once and the fallback is remembered.
    const { asked } = fakeTop((args) => {
      if (args.includes('etimes')) throw new Error('ps: unknown user-defined format specifier');
      return { Titles: ['PID', 'PPID', 'COMMAND'], Processes: [['200', '100', 'sleep 300']] };
    });
    const [first] = await containerProcesses('c1');
    assert.equal(first?.command, 'sleep 300');
    // No age rather than a made-up one.
    assert.equal(first?.elapsedSeconds, null);
    await containerProcesses('c1');
    assert.deepEqual(asked, [
      '-eo pid,ppid,etimes,args',
      '-eo pid,ppid,args',
      '-eo pid,ppid,args',
    ]);
  });

  it('treats a table with no tree in it as no answer', async () => {
    // The caller reads this as "the box could not be asked", not as "nothing
    // is running". Only the first is safe to be wrong about.
    fakeTop(() => ({ Titles: ['USER', 'COMMAND'], Processes: [['agent', 'sleep 300']] }));
    await expect(containerProcesses('c1')).rejects.toThrow(/PID\/PPID/);
  });
});

/**
 * The same table from inside the box, which is the only numbering a kill in
 * there can be given.
 */
describe('reading and signalling from inside a container', () => {
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
        '    PID    PPID COMMAND',
        '      1       0 /sbin/docker-init',
        '  23490   23019 /bin/bash -c eval \'sleep 300; echo done\'',
      ].join('\n'),
    );
    const processes = await containerProcessesFromInside('c1');
    assert.deepEqual(ran, [['ps', '-eo', 'pid,ppid,args']]);
    assert.deepEqual(processes, [
      { pid: 1, ppid: 0, command: '/sbin/docker-init', elapsedSeconds: null },
      {
        pid: 23490,
        ppid: 23019,
        command: "/bin/bash -c eval 'sleep 300; echo done'",
        elapsedSeconds: null,
      },
    ]);
  });

  it('says so when the box has no ps to ask', async () => {
    // "Nothing is running" would make a stop look like its target was
    // already gone.
    fakeExec('ps: command not found', 127);
    await expect(containerProcessesFromInside('c1')).rejects.toThrow(/exited 127/);
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
