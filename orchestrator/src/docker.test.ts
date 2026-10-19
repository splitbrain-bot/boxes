import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Docker from 'dockerode';
import { afterEach, describe, it } from 'vitest';
import { ApiKeyStore } from './api-keys.ts';
import { type Config, loadConfig } from './config.ts';
import { type CredentialId, type CredentialMethod, CredentialStore } from './credentials.ts';
import { type Db, openDb } from './db.ts';
import { createContainer, createLoginContainer, setDockerForTests } from './docker.ts';
import { EgressManager } from './egress.ts';

/** The temporary data directories of the current test. */
let dirs: string[] = [];
/** The open databases of the current test. */
let dbs: Db[] = [];

afterEach(() => {
  for (const d of dbs) d.close();
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * Creates a temporary data directory that afterEach removes.
 *
 * @returns The path of the directory.
 */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-docker-'));
  dirs.push(dir);
  return dir;
}

/**
 * Creates a deployment with a config, a credential store with the given
 * secrets, and a prepared egress manager.
 *
 * @param secrets The secret of each stored credential.
 * @param over The config variables that replace the defaults.
 * @param methods The method of each stored credential. The default is a token.
 * @returns The config, the database and the egress manager.
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
    credentials.put('', id as CredentialId, methods[id as CredentialId] ?? 'token', secret);
  }
  const egress = new EgressManager(cfg, credentials, new ApiKeyStore(db, () => {}), db);
  await egress.prepare();
  return { cfg, db, egress };
}

describe('the container template', () => {
  /**
   * Captures the options that createContainer sends to the daemon.
   *
   * @returns The options of the create call.
   */
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
    const host = opts.HostConfig as { Binds: string[] };
    // The binds use paths and not volume names, because the workspace, the home
    // and the Nix store are directories on the data volume.
    assert.deepEqual(host.Binds, [
      '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234:/workspace',
      '/var/lib/docker/volumes/boxes-data/_data/homes/abcd1234:/home/agent',
      // The store must be at /nix, because the binary cache is built for that
      // path, and its content would not substitute at another path.
      '/var/lib/docker/volumes/boxes-data/_data/nix/abcd1234:/nix',
    ]);
  }, 30_000);

  it("runs as the configured uid and gid, not the image's user name", async () => {
    const opts = await capture();
    // The user is numbers, so only BOX_UID decides the user of a box. The default
    // avoids 1000, which on a host usually belongs to a person.
    assert.equal(opts.User, '1020:1020');
  }, 30_000);

  it('tells an outside updater to leave box containers alone', async () => {
    const opts = await capture();
    const labels = opts.Labels as Record<string, string>;
    // Boxes finds its containers again by the box id.
    assert.equal(labels['boxes.box'], 'abcd1234');
    // This label tells an updater to leave the container alone. A recreated
    // container loses its proxy attachment, which is the only way out of the
    // box. The orchestrator moves boxes to a new image itself, at start.
    assert.equal(labels['com.centurylinklabs.watchtower.enable'], 'false');
  }, 30_000);

  it('keeps the isolation the workspace change does not touch', async () => {
    const opts = await capture();
    const host = opts.HostConfig as Record<string, unknown>;
    assert.equal(opts.User, '1020:1020');
    assert.equal(host.ReadonlyRootfs, true);
    assert.deepEqual(host.CapDrop, ['ALL']);
    assert.equal(host.Privileged, false);
    assert.deepEqual(host.SecurityOpt, ['no-new-privileges:true']);
  }, 30_000);

  // The playwright-cli config of the box image drops the Playwright flag
  // --disable-dev-shm-usage because of this size. Without this size, Chromium gets the 64 MB /dev/shm of Docker and
  // reports the full memory as a closed target on a large page.
  it('gives the browser enough shared memory to not need the flag', async () => {
    const opts = await capture();
    const host = opts.HostConfig as Record<string, unknown>;
    assert.equal(host.ShmSize, 512 * 1024 * 1024);
  }, 30_000);
});

describe('the login container', () => {
  /**
   * Captures the options that createLoginContainer sends to the daemon.
   *
   * @returns The options of the create call.
   */
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

  it("is nobody's box: no bind, no credential, and a home it can write", async () => {
    const opts = await capture();
    const host = opts.HostConfig as Record<string, unknown>;

    // The CLI authenticates a person to their own service. The container
    // holds no deployment secret for an egress policy to protect.
    assert.equal(host.Binds, undefined);
    assert.deepEqual(opts.Env, []);
    // The rootfs is read-only, and both CLIs write their state under $HOME.
    const tmpfs = host.Tmpfs as Record<string, string>;
    assert.match(tmpfs['/home/agent'] ?? '', /rw/);
    assert.equal(host.ReadonlyRootfs, true);
    assert.deepEqual(host.CapDrop, ['ALL']);
    assert.equal(host.Privileged, false);
    assert.equal(opts.User, '1020:1020');
  }, 30_000);

  it('sits on the default bridge, which is the point of it', async () => {
    const opts = await capture();
    // It is the only container of Boxes with its own route out. The login hosts
    // belong to the service and not to the deployment, and the container lives
    // for minutes.
    assert.equal((opts.HostConfig as Record<string, unknown>).NetworkMode, 'bridge');
  }, 30_000);

  it('carries the credential it is for, so a crash mid-flow can be swept', async () => {
    const opts = await capture();
    const labels = opts.Labels as Record<string, string>;
    assert.equal(labels['boxes.login'], 'openai');
    // It is not a box, so nothing that reads the box label finds it.
    assert.equal(labels['boxes.box'], undefined);
  }, 30_000);
});
