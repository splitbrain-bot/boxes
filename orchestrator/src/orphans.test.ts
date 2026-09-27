import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb, type Db } from './db.ts';
import * as dk from './docker.ts';
import * as ws from './workspaces.ts';

/** The daemon this suite pretends to talk to. */
interface Fake {
  /** Box containers by id. */
  containers: Map<string, { boxId: string; running: boolean }>;
  /** Login containers, which belong to a credential rather than to a box. */
  logins: Map<string, { credentialId: string; createdAt: number }>;
  /** Network name to the id of the box it is labelled with. */
  networks: Map<string, string>;
  /** Volume name to the id of the box it is labelled with. */
  volumes: Map<string, string>;
  /** Names of objects the sweep removed, in the order it removed them. */
  removed: string[];
  /** Objects the daemon refuses to remove, by name. */
  stuck: Set<string>;
  /** Run as the daemon answers a listing, for what happens mid-sweep. */
  whileListing?: () => void;
}

/** Installs a Docker client that lists and removes the objects of the fake. */
function install(fake: Fake): void {
  const refuse = (name: string): void => {
    if (fake.stuck.has(name)) throw Object.assign(new Error('in use'), { statusCode: 409 });
  };
  dk.setDockerForTests({
    listContainers: async () => [
      ...[...fake.containers].map(([id, c]) => ({
        Id: id,
        State: c.running ? 'running' : 'exited',
        Labels: { [dk.LABEL]: c.boxId },
      })),
      // The daemon answers one listing; each caller's own label filter is
      // what picks its own containers out of it.
      ...[...fake.logins].map(([id, l]) => ({
        Id: id,
        State: 'running',
        Created: Math.round(l.createdAt / 1000),
        Labels: { [dk.LOGIN_LABEL]: l.credentialId },
      })),
    ],
    listNetworks: async () =>
      [...fake.networks].map(([name, boxId]) => ({
        Name: name,
        Labels: { [dk.LABEL]: boxId },
      })),
    listVolumes: async () => {
      fake.whileListing?.();
      return {
        Volumes: [...fake.volumes].map(([name, boxId]) => ({
          Name: name,
          Labels: { [dk.LABEL]: boxId },
        })),
      };
    },
    getContainer: (id: string) => ({
      remove: async () => {
        refuse(id);
        fake.removed.push(id);
        fake.containers.delete(id);
        fake.logins.delete(id);
      },
    }),
    getNetwork: (name: string) => ({
      disconnect: async () => {},
      remove: async () => {
        refuse(name);
        fake.removed.push(name);
        fake.networks.delete(name);
      },
    }),
    getVolume: (name: string) => ({
      remove: async () => {
        refuse(name);
        fake.removed.push(name);
        fake.volumes.delete(name);
      },
    }),
  } as unknown as Docker);
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;
let fake: Fake;

/** Inserts a box row that names the objects Boxes would create for it. */
function insertBox(id: string, status = 'stopped'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO boxes (id, name, profile, image, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
       status, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', ?,
       ?, '10.200.0.0/24', '', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `c-${id}`,
    `bn-${id}`,
    `home-${id}`,
    `${dir}/workspaces/${id}`,
    `${dir}/homes/${id}`,
    status,
    now,
    now,
  );
}

/** The Docker objects and the directories one box owns. */
function insertObjects(id: string): void {
  fake.containers.set(`c-${id}`, { boxId: id, running: false });
  fake.networks.set(`bn-${id}`, id);
  // Older boxes have a home volume, labelled the same way.
  fake.volumes.set(`home-${id}`, id);
  const workspace = ws.createWorkspace(orchestrator.cfg.DATA_DIR, id);
  writeFileSync(join(workspace, 'work.txt'), 'the agent was here');
  const home = ws.createHome(orchestrator.cfg.DATA_DIR, id);
  writeFileSync(join(home, '.profile'), 'and lived here');
  const nix = ws.createNix(orchestrator.cfg.DATA_DIR, id);
  writeFileSync(join(nix, 'store'), 'and installed things');
}

/** The workspace directory of a box. */
function workspaceOf(id: string): string {
  return ws.workspacePath(orchestrator.cfg.DATA_DIR, id);
}

/** The home directory of a box. */
function homeOf(id: string): string {
  return ws.homePath(orchestrator.cfg.DATA_DIR, id);
}

/** The Nix store directory of a box. */
function nixOf(id: string): string {
  return ws.nixPath(orchestrator.cfg.DATA_DIR, id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-orphans-'));
  fake = {
    containers: new Map(),
    logins: new Map(),
    networks: new Map(),
    volumes: new Map(),
    removed: [],
    stuck: new Set(),
  };
  install(fake);
  db = openDb(dir);
  orchestrator = buildApp(loadConfig({ DATA_DIR: dir }), db);
});

afterEach(async () => {
  rmSync(ws.workspacesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  rmSync(ws.homesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  rmSync(ws.nixRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('sweeping objects no box owns', () => {
  it('takes the container, the network, the volume and every directory', async () => {
    insertBox('live');
    insertObjects('live');
    // A box that was deleted, and whose teardown did not finish.
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['c-gone', 'bn-gone', 'home-gone']);
    assert.ok(!existsSync(workspaceOf('gone')));
    // The home and the store are the bigger part: the caches and whatever
    // the agent installed at runtime are in them.
    assert.ok(!existsSync(homeOf('gone')));
    assert.ok(!existsSync(nixOf('gone')));
    // Nothing of the live box is touched.
    assert.ok(existsSync(workspaceOf('live')));
    assert.ok(existsSync(homeOf('live')));
    assert.ok(existsSync(nixOf('live')));
    assert.ok(fake.containers.has('c-live'));
    assert.ok(fake.volumes.has('home-live'));
  });

  it('removes the container before the network and the volume it holds', async () => {
    insertBox('keep');
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    // Docker refuses to remove a network or a volume that a container uses.
    assert.deepEqual(fake.removed, ['c-gone', 'bn-gone', 'home-gone']);
  });

  it('leaves a box that is still being created alone', async () => {
    // create() inserts the row before it makes anything, so a half-built
    // box always has one. Its objects are not orphans.
    insertBox('newborn', 'creating');
    insertObjects('newborn');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(existsSync(workspaceOf('newborn')));
    assert.ok(existsSync(homeOf('newborn')));
  });

  it('leaves a box created while it was reading the daemon alone', async () => {
    // A create can insert its row while the sweep reads Docker and the
    // directories, so the sweep reads the rows last.
    insertBox('keep');
    fake.whileListing = (): void => {
      insertBox('newborn', 'creating');
      insertObjects('newborn');
    };

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(existsSync(workspaceOf('newborn')));
    assert.ok(existsSync(homeOf('newborn')));
  });

  it('keeps going when one object cannot be removed', async () => {
    insertBox('keep');
    insertBox('gone', 'deleted');
    insertObjects('gone');
    fake.stuck.add('bn-gone');

    await orchestrator.manager.sweepOrphans();

    // The network stays for the next sweep; nothing behind it is held up.
    assert.deepEqual(fake.removed, ['c-gone', 'home-gone']);
    assert.ok(fake.networks.has('bn-gone'));
    assert.ok(!existsSync(workspaceOf('gone')));
  });

  it('does nothing at all when every object has a box', async () => {
    insertBox('a');
    insertObjects('a');
    insertBox('b');
    insertObjects('b');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
  });

  it('takes an abandoned login container, and leaves one still in use', async () => {
    // A login removes its container when the flow ends. A restart mid-login
    // leaves the container behind, holding half a credential in a tmpfs home.
    insertBox('keep');
    const now = Date.now();
    fake.logins.set('login-old', { credentialId: 'openai', createdAt: now - 20 * 60_000 });
    fake.logins.set('login-fresh', { credentialId: 'claude', createdAt: now - 60_000 });

    await orchestrator.manager.sweepOrphans();

    // Age is the only rule. The cutoff is longer than a flow may take, so a
    // login in progress is not swept.
    assert.deepEqual(fake.removed, ['login-old']);
    assert.ok(fake.logins.has('login-fresh'));
  });

  it('sweeps login containers even where the boxes table is empty', async () => {
    // The empty-table guard protects box objects. A login container belongs
    // to no box.
    fake.logins.set('login-old', { credentialId: 'openai', createdAt: Date.now() - 20 * 60_000 });
    insertObjects('orphan-by-accident');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['login-old']);
    assert.ok(existsSync(workspaceOf('orphan-by-accident')));
  });

  it('refuses to sweep for a database that knows of no box at all', async () => {
    // A data volume mounted from the wrong place, or replaced: the rows are
    // gone but the host's boxes are not. Their homes could not be recovered.
    insertObjects('orphan-by-accident');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(existsSync(workspaceOf('orphan-by-accident')));
    assert.ok(existsSync(homeOf('orphan-by-accident')));
  });

  it('refuses when the host holds far more boxes than the database knows of', async () => {
    // The same wrong database, a minute later: somebody whose dashboard looked
    // empty created a box in it. One row must not disarm the guard, so it
    // is a ratio rather than an empty table.
    insertBox('created-against-the-wrong-database');
    for (const id of ['a', 'b', 'c', 'd']) insertObjects(id);

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(existsSync(homeOf('a')));
  });

  it('still sweeps a handful of strays beside a database that knows its boxes', async () => {
    // A deployment with its rows intact still has its failed teardowns swept.
    for (const id of ['live-1', 'live-2', 'live-3']) insertBox(id);
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['c-gone', 'bn-gone', 'home-gone']);
    assert.ok(!existsSync(homeOf('gone')));
  });

  it('takes the files of a box whose Docker objects are already gone', async () => {
    insertBox('keep');
    // The shape a failed teardown leaves: it removes the container, the
    // network and the volumes first, so a box it gave up on halfway is
    // its directories and nothing else.
    insertObjects('half-torn-down');
    fake.containers.delete('c-half-torn-down');
    fake.networks.delete('bn-half-torn-down');
    fake.volumes.delete('home-half-torn-down');

    await orchestrator.manager.sweepOrphans();

    assert.ok(!existsSync(workspaceOf('half-torn-down')));
    assert.ok(!existsSync(homeOf('half-torn-down')));
    assert.ok(!existsSync(nixOf('half-torn-down')));
  });

  it('sweeps for a deployment whose boxes have all been deleted', async () => {
    // The tombstone is what tells the two cases apart: this database made
    // these objects, and one of its teardowns did not finish.
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['c-gone', 'bn-gone', 'home-gone']);
  });
});

describe('boot reconciliation', () => {
  it('fails a create that the last orchestrator did not finish', async () => {
    // create() inserts the row first and fails the box itself if any step
    // throws, so a row still saying `creating` at boot has lost its creator.
    insertBox('newborn', 'creating');
    insertObjects('newborn');
    fake.containers.delete('c-newborn');

    await orchestrator.manager.reconcile();

    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('newborn') as {
      status: string;
    };
    assert.equal(row.status, 'error');
    // Reconciliation deletes no files.
    assert.ok(existsSync(workspaceOf('newborn')));
  });

  it('adopts a half-created box whose container is up', async () => {
    insertBox('newborn', 'creating');
    insertObjects('newborn');
    fake.containers.set('c-newborn', { boxId: 'newborn', running: true });

    await orchestrator.manager.reconcile();

    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('newborn') as {
      status: string;
    };
    assert.equal(row.status, 'running');
  });
});
