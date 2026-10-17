import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterEach, describe, it } from 'vitest';
import { ApiKeyStore } from './api-keys.ts';
import { loadConfig, type Config } from './config.ts';
import { CredentialStore, type CredentialId, type CredentialMethod } from './credentials.ts';
import { openDb, type Db } from './db.ts';
import { EgressManager } from './egress.ts';
import { createLoginContainer, createContainer, setDockerForTests } from './docker.ts';

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
  const egress = new EgressManager(cfg, credentials, new ApiKeyStore(db, () => {}), db);
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
