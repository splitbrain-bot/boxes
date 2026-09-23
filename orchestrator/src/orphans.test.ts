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

/**
 * Sweeping what a box left behind.
 *
 * Everything Boxes creates carries its box's id as a label, and boot
 * reconciliation reads that one way only — for each row, what Docker has. So
 * a container, network or volume whose row is gone was invisible: no card
 * lists it, no teardown will ever be run for it again, and a home volume of
 * it holds whatever the agent installed at runtime.
 *
 * What makes the rule exact rather than a guess is the order create() works
 * in: the row exists before any Docker object does, so a labelled object with
 * no live row cannot be one on its way up.
 */

/** The daemon this suite pretends to talk to. */
interface Fake {
  containers: Map<string, { boxId: string; running: boolean }>;
  /** Login containers, which belong to a credential rather than to a box. */
  logins: Map<string, { credentialId: string; createdAt: number }>;
  networks: Map<string, string>;
  volumes: Map<string, string>;
  /** Names of objects the sweep removed, in the order it removed them. */
  removed: string[];
  /** Objects the daemon refuses to remove, by name. */
  stuck: Set<string>;
  /** Run as the daemon answers a listing, for what happens mid-sweep. */
  whileListing?: () => void;
}

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

/** A box row, and the objects Boxes would have created for it. */
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
  // A box from before homes became directories still has this one, and
  // it is labelled the same way.
  fake.volumes.set(`home-${id}`, id);
  const workspace = ws.createWorkspace(orchestrator.cfg.DATA_DIR, id);
  writeFileSync(join(workspace, 'work.txt'), 'the agent was here');
  const home = ws.createHome(orchestrator.cfg.DATA_DIR, id);
  writeFileSync(join(home, '.profile'), 'and lived here');
}

function workspaceOf(id: string): string {
  return ws.workspacePath(orchestrator.cfg.DATA_DIR, id);
}

function homeOf(id: string): string {
  return ws.homePath(orchestrator.cfg.DATA_DIR, id);
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
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('sweeping objects no box owns', () => {
  it('takes the container, the network, the volume and both directories', async () => {
    insertBox('live');
    insertObjects('live');
    // A box that was deleted, and whose teardown did not finish.
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['c-gone', 'bn-gone', 'home-gone']);
    assert.ok(!existsSync(workspaceOf('gone')));
    // The home is the bigger half: the caches and whatever the agent
    // installed at runtime are in it.
    assert.ok(!existsSync(homeOf('gone')));
    // And nothing of the box that is still there.
    assert.ok(existsSync(workspaceOf('live')));
    assert.ok(existsSync(homeOf('live')));
    assert.ok(fake.containers.has('c-live'));
    assert.ok(fake.volumes.has('home-live'));
  });

  it('removes the container before the network and the volume it holds', async () => {
    insertBox('keep');
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    // Docker refuses a network with a container on it, and a volume mounted
    // into one, so the order is the whole of whether this works.
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
    // The sweep asks Docker three questions and reads the directories, which
    // takes long enough for a create to run: its row is inserted before it
    // makes anything, so it exists by the time the sweep decides. A snapshot
    // taken before the readings does not have it, and the box loses its
    // network, its workspace and its home while it is being built.
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
    // A login runs the harness's own CLI in a container of its own and removes
    // it when the flow ends — but only while the orchestrator is alive to end
    // it. A restart mid-login leaves one holding half a credential in a tmpfs
    // home, on the default bridge, that nothing else would ever look for.
    insertBox('keep');
    const now = Date.now();
    fake.logins.set('login-old', { credentialId: 'openai', createdAt: now - 20 * 60_000 });
    fake.logins.set('login-fresh', { credentialId: 'claude', createdAt: now - 60_000 });

    await orchestrator.manager.sweepOrphans();

    // Age is the whole rule, and the cutoff is longer than a flow is allowed
    // to take, so a person still in a browser is never swept out from under.
    assert.deepEqual(fake.removed, ['login-old']);
    assert.ok(fake.logins.has('login-fresh'));
  });

  it('sweeps login containers even where the boxes table is empty', async () => {
    // The guard below is about box objects a foreign database would take;
    // a login container belongs to no box and is nobody else's either.
    fake.logins.set('login-old', { credentialId: 'openai', createdAt: Date.now() - 20 * 60_000 });
    insertObjects('orphan-by-accident');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['login-old']);
    assert.ok(existsSync(workspaceOf('orphan-by-accident')));
  });

  it('refuses to sweep for a database that knows of no box at all', async () => {
    // A data volume mounted from the wrong place, or replaced: the rows are
    // gone but the host's boxes are not, and taking their home volumes is
    // the one loss here with nothing to recover it from.
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
    // And the guard is not so wide that it stops the sweep doing its job: a
    // deployment with its rows intact has its failed teardowns taken.
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
    // two directories and nothing else.
    insertObjects('half-torn-down');
    fake.containers.delete('c-half-torn-down');
    fake.networks.delete('bn-half-torn-down');
    fake.volumes.delete('home-half-torn-down');

    await orchestrator.manager.sweepOrphans();

    assert.ok(!existsSync(workspaceOf('half-torn-down')));
    assert.ok(!existsSync(homeOf('half-torn-down')));
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
    // throws, so a row still saying `creating` at boot is one whose creator
    // is gone. Nothing else touches it: the sweep protects every row that
    // exists, so the box held its subnet and answered 409 to start for
    // as long as the deployment lived.
    insertBox('newborn', 'creating');
    insertObjects('newborn');
    fake.containers.delete('c-newborn');

    await orchestrator.manager.reconcile();

    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('newborn') as {
      status: string;
    };
    assert.equal(row.status, 'error');
    // Its files are still there for the sweep, which is the only thing that
    // deletes anything.
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
