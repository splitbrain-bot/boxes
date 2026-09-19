import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb, touchSession, type Db } from './db.ts';
import * as dk from './docker.ts';
import * as ws from './workspaces.ts';

/**
 * Keeping a session on the current session image.
 *
 * The orchestrator creates session containers, so nothing outside it may
 * recreate one — the id in the database and the runtime proxy attachment
 * would both be lost. Moving a session onto a new image is therefore the
 * orchestrator's own job, and start is the only moment it is safe: under a
 * running container it would kill the adapter exec mid-turn.
 */

const IMAGE = 'ghcr.io/example/session:latest';

/** The daemon this suite pretends to talk to. */
interface Fake {
  /** Image reference to the id it currently resolves to. */
  images: Map<string, string>;
  /**
   * Container id to the image id it was created from, whether it runs, and
   * the destinations it has mounts at — which the start path asks about, to
   * recognise a container from before a mount existed.
   */
  containers: Map<string, { image: string; running: boolean; mounts: string[] }>;
  created: Array<Record<string, unknown>>;
  removed: string[];
  pulled: string[];
  /**
   * Image ids on the host that carry no tag, and the label each was built
   * with. A pull that moves the tag puts the id it moved off in here, the way
   * the daemon does.
   */
  untagged: Map<string, Record<string, string>>;
  /** Image ids a container still uses, which the daemon refuses to remove. */
  imagesInUse: Set<string>;
  /** Image ids removed, in the order they went. */
  imagesRemoved: string[];
  /** What a pull does to `images`, which is how a tag moves in a test. */
  onPull?: (image: string) => void;
  /** Run as a container is created, for what arrives mid-operation. */
  onCreate?: () => void;
  /** Run as a container is removed, for what arrives mid-teardown. */
  onRemove?: () => void;
  /** Networks the daemon has. A prune takes the container's with it. */
  networks: Set<string>;
  next: number;
}

function notFound(what: string): Error {
  return Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
}

function install(fake: Fake): void {
  dk.setDockerForTests(dockerFor(fake));
}

/** The fake daemon itself, so a test can replace one part of it. */
function dockerFor(fake: Fake): Docker {
  return {
    getImage: (name: string) => ({
      inspect: async () => {
        const id = fake.images.get(name);
        if (!id) throw notFound('image');
        return { Id: id };
      },
      remove: async () => {
        if (fake.imagesInUse.has(name)) {
          throw Object.assign(new Error('image is in use'), { statusCode: 409 });
        }
        if (!fake.untagged.delete(name)) throw notFound('image');
        fake.imagesRemoved.push(name);
      },
    }),
    listImages: async (opts: { filters?: { label?: string[] } }) => {
      const wanted = opts.filters?.label ?? [];
      return [...fake.untagged]
        .filter(([, labels]) =>
          wanted.every((l) => {
            const [key, value] = l.split('=');
            return labels[key ?? ''] === value;
          }),
        )
        .map(([Id]) => ({ Id, RepoTags: [] }));
    },
    getContainer: (id: string) => ({
      inspect: async () => {
        const c = fake.containers.get(id);
        if (!c) throw notFound('container');
        return {
          Image: c.image,
          State: { Running: c.running },
          Mounts: c.mounts.map((Destination) => ({ Destination })),
        };
      },
      start: async () => {
        const c = fake.containers.get(id);
        // A daemon asked to start a container it does not have says so, which
        // is the whole of what a pruned box looks like from here.
        if (!c) throw notFound('container');
        c.running = true;
      },
      stop: async () => {
        const c = fake.containers.get(id);
        if (c) c.running = false;
      },
      remove: async () => {
        fake.onRemove?.();
        fake.removed.push(id);
        fake.containers.delete(id);
      },
    }),
    createContainer: async (opts: Record<string, unknown>) => {
      fake.onCreate?.();
      fake.created.push(opts);
      const id = `container-${++fake.next}`;
      const binds = (opts['HostConfig'] as { Binds?: string[] } | undefined)?.Binds ?? [];
      fake.containers.set(id, {
        image: fake.images.get(opts['Image'] as string) ?? 'unresolved',
        running: false,
        // A container's mounts come from what it was created with, so the
        // daemon reports back whatever containerSpec asked for.
        mounts: binds.map((bind) => bind.split(':')[1] ?? ''),
      });
      return { id };
    },
    pull: async (image: string) => {
      fake.pulled.push(image);
      fake.onPull?.(image);
      return new PassThrough();
    },
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!fake.networks.has(name)) throw notFound('network');
        // Enough of one for ensureProxyAttached, which tolerates whatever it
        // finds; what this suite reads is `fake.networks` itself.
        return { Containers: {} };
      },
      connect: async () => {},
    }),
    createNetwork: async (opts: { Name: string }) => {
      fake.networks.add(opts.Name);
      return {};
    },
    modem: {
      followProgress: (
        _stream: NodeJS.ReadableStream,
        onFinished: (err: Error | null, out: unknown[]) => void,
      ) => onFinished(null, []),
    },
  } as unknown as Docker;
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;
let fake: Fake;

/**
 * A stopped session with a container on `imageId`, shaped the way every
 * session created today is: both of its mounts are directories.
 *
 * `home` makes the older shape instead — a session from before homes became
 * directories, which keeps its named volume and goes on mounting it. Nothing
 * migrates it, so both shapes have to keep working.
 *
 * The directories are made as well as named, because a start refuses a
 * session whose bind sources are gone.
 */
function insertSession(
  id: string,
  containerId: string,
  imageId: string,
  home: 'directory' | 'volume' = 'directory',
): void {
  const now = Date.now();
  fake.containers.set(containerId, {
    image: imageId,
    running: false,
    // Every mount a container created today has. What this suite is about is
    // the image moving under a session, not a container from before a mount
    // existed — sessions.ts has its own path for that.
    mounts: [dk.WORKSPACE_DIR, '/home/agent', dk.AGENT_CONFIG_DIR],
  });
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
       status, current_thread_id, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', ?, '["claude-agent-acp"]', ?,
       ?, '10.200.0.0/24', '', ?, ?, ?, 'stopped', NULL, ?, ?)`,
  ).run(
    id,
    IMAGE,
    containerId,
    `sn-${id}`,
    home === 'volume' ? `home-${id}` : '',
    `${dir}/workspaces/${id}`,
    home === 'volume' ? null : `${dir}/homes/${id}`,
    now,
    now,
  );
  ws.createWorkspace(dir, id);
  if (home === 'directory') ws.createHome(dir, id);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-image-'));
  fake = {
    images: new Map([[IMAGE, 'sha256:one']]),
    containers: new Map(),
    created: [],
    removed: [],
    pulled: [],
    untagged: new Map(),
    imagesInUse: new Set(),
    imagesRemoved: [],
    networks: new Set(['sn-a1', 'sn-a2', 'sn-a3', 'sn-a4', 'sn-a5', 'sn-gone']),
    next: 0,
  };
  install(fake);
  db = openDb(dir);
  orchestrator = buildApp(loadConfig({ DATA_DIR: dir, SESSION_IMAGE: IMAGE }), db);
  await orchestrator.egress.prepare();
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('starting a session whose image has moved', () => {
  it('recreates the container on what the tag now resolves to', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    // The tag did not change; what it points at did. That is the whole case
    // this exists for, and comparing tags would miss it.
    fake.images.set(IMAGE, 'sha256:two');

    const detail = await orchestrator.manager.start('a1');

    assert.deepEqual(fake.removed, ['c1']);
    assert.equal(fake.created.length, 1);
    assert.equal(fake.created[0]!['Image'], IMAGE);
    assert.notEqual(detail.containerId, 'c1');
    assert.equal(detail.image, IMAGE);
    // And it is actually running, not merely created.
    assert.equal(fake.containers.get(detail.containerId!)?.running, true);
  });

  it('brings the workspace and the home across untouched', async () => {
    insertSession('a2', 'c1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');

    await orchestrator.manager.start('a2');

    // Everything durable about a session lives in these two mounts, which is
    // what makes recreating the container cheap rather than destructive.
    const host = fake.created[0]!['HostConfig'] as { Binds: string[] };
    assert.deepEqual(host.Binds, [
      `${dir}/workspaces/a2:/workspace`,
      `${dir}/homes/a2:/home/agent`,
      // The agent configuration comes across too, read-only. It is derived
      // from the database rather than durable in itself, but the mount has to
      // be there or the box starts with nothing configured.
      `${dir}/agents/a2:/boxes/agent:ro`,
    ]);
  });

  it('keeps mounting the volume of a session whose home is one', async () => {
    // Nothing migrates a home, so a session created before homes became
    // directories goes on mounting its volume for as long as it lives —
    // including through a rebuild of its container.
    insertSession('a2', 'c1', 'sha256:one', 'volume');
    fake.images.set(IMAGE, 'sha256:two');

    await orchestrator.manager.start('a2');

    const host = fake.created[0]!['HostConfig'] as { Binds: string[] };
    assert.deepEqual(host.Binds, [
      `${dir}/workspaces/a2:/workspace`,
      'home-a2:/home/agent',
      `${dir}/agents/a2:/boxes/agent:ro`,
    ]);
  });

  it('moves a session onto the current image for a terminal too', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');

    // A terminal starts a stopped box without going through start(), and
    // runs the same repairs it does.
    const target = await orchestrator.manager.execTarget('a1');

    assert.deepEqual(fake.removed, ['c1']);
    assert.notEqual(target.containerId, 'c1');
    assert.equal(fake.created[0]!['Image'], IMAGE);
  });

  it('leaves a session already on the current image alone', async () => {
    insertSession('a3', 'c1', 'sha256:one');

    const detail = await orchestrator.manager.start('a3');

    assert.deepEqual(fake.removed, []);
    assert.equal(fake.created.length, 0);
    assert.equal(detail.containerId, 'c1');
  });

  it('defers a running container rather than killing the turn in it', async () => {
    insertSession('a4', 'c1', 'sha256:one');
    fake.containers.get('c1')!.running = true;
    fake.images.set(IMAGE, 'sha256:two');

    const detail = await orchestrator.manager.start('a4');

    // The idle reaper stops it soon enough, and the next start moves it.
    assert.deepEqual(fake.removed, []);
    assert.equal(detail.containerId, 'c1');
  });

  it('starts the session as it is when the new image is not on the host', async () => {
    insertSession('a5', 'c1', 'sha256:one');
    fake.images.delete(IMAGE);

    const detail = await orchestrator.manager.start('a5');

    assert.deepEqual(fake.removed, []);
    assert.equal(detail.containerId, 'c1');
  });
});

describe('starting a session Docker has forgotten', () => {
  it('rebuilds a container something pruned, and starts it', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    // `docker container prune` takes every stopped container, and an idle
    // Boxes session is a stopped container. Nothing durable goes with it:
    // both of a session's mounts are directories on the data volume.
    fake.containers.delete('c1');

    const detail = await orchestrator.manager.start('a1');

    assert.equal(fake.created.length, 1);
    assert.notEqual(detail.containerId, 'c1');
    assert.equal(fake.containers.get(detail.containerId!)?.running, true);
    // And the row names the container that exists, so the next start is an
    // ordinary one.
    assert.equal(detail.status, 'running');
  });

  it('brings the workspace and the home back with it', async () => {
    insertSession('a2', 'c1', 'sha256:one');
    fake.containers.delete('c1');

    await orchestrator.manager.start('a2');

    // The point of the rebuild: a container is reproducible from the row, and
    // what is not reproducible is in these two directories — which the new
    // container mounts exactly as the old one did.
    const host = fake.created[0]!['HostConfig'] as { Binds: string[] };
    assert.deepEqual(host.Binds, [
      `${dir}/workspaces/a2:/workspace`,
      `${dir}/homes/a2:/home/agent`,
      `${dir}/agents/a2:/boxes/agent:ro`,
    ]);
  });

  it('makes the network again when that went with it', async () => {
    insertSession('a3', 'c1', 'sha256:one');
    // What `docker system prune` does: the container, and then the network
    // that has nothing left on it. A container cannot be created into a
    // network that is not there.
    fake.containers.delete('c1');
    fake.networks.delete('sn-a3');

    await orchestrator.manager.start('a3');

    assert.ok(fake.networks.has('sn-a3'));
    const host = fake.created[0]!['HostConfig'] as { NetworkMode: string };
    assert.equal(host.NetworkMode, 'sn-a3');
  });

  it('leaves a container that is merely stopped alone', async () => {
    insertSession('a4', 'c1', 'sha256:one');

    const detail = await orchestrator.manager.start('a4');

    // The ordinary case, and the one this must not touch: a stopped container
    // is started, not replaced.
    assert.deepEqual(fake.created, []);
    assert.deepEqual(fake.removed, []);
    assert.equal(detail.containerId, 'c1');
  });

  it('does not rebuild on a daemon that would not answer', async () => {
    insertSession('a5', 'c1', 'sha256:one');
    // 500 rather than 404: the difference between a container that is gone
    // and a daemon that is unwell. Rebuilding on the second would replace a
    // container that is running perfectly well behind a failed inspect.
    dk.setDockerForTests({
      ...(dockerFor(fake) as unknown as Record<string, unknown>),
      getContainer: () => ({
        inspect: async () => {
          throw Object.assign(new Error('daemon is unwell'), { statusCode: 500 });
        },
        start: async () => {
          throw Object.assign(new Error('daemon is unwell'), { statusCode: 500 });
        },
      }),
    } as unknown as Docker);

    await assert.rejects(() => orchestrator.manager.start('a5'));
    assert.deepEqual(fake.created, []);
  });

  it('rebuilds for a terminal too', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    fake.containers.delete('c1');

    // Opening a thread and opening a terminal both start a stopped box
    // without going through start(), so the repair cannot live only there.
    const target = await orchestrator.manager.execTarget('a1');

    assert.equal(fake.created.length, 1);
    assert.notEqual(target.containerId, 'c1');
    assert.equal(fake.containers.get(target.containerId)?.running, true);
  });
});

describe('having the session image at all', () => {
  it('pulls it when it is not on the host', async () => {
    fake.images.delete(IMAGE);
    fake.onPull = (image) => fake.images.set(image, 'sha256:pulled');

    await orchestrator.manager.ensureSessionImage();

    assert.deepEqual(fake.pulled, [IMAGE]);
  });

  it('does not pull one that is already here', async () => {
    await orchestrator.manager.ensureSessionImage();
    assert.deepEqual(fake.pulled, []);
  });

  it('refreshes on demand, so a moving tag moves on this host too', async () => {
    fake.onPull = (image) => fake.images.set(image, 'sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.pulled, [IMAGE]);
    assert.equal(fake.images.get(IMAGE), 'sha256:two');
  });
});

/** What a pull that moves the tag does: the old id stays, untagged. */
function moveTagTo(id: string): void {
  const before = fake.images.get(IMAGE);
  if (before) fake.untagged.set(before, { [dk.IMAGE_LABEL]: dk.SESSION_IMAGE_KIND });
  fake.images.set(IMAGE, id);
}

describe('reclaiming what a pull superseded', () => {
  it('removes the copy the tag moved off', async () => {
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    // A gigabyte or two per release, which nothing else was ever going to
    // reclaim: an untagged image is not something a deployment goes looking
    // for.
    assert.deepEqual(fake.imagesRemoved, ['sha256:one']);
  });

  it('leaves the one a session is still on, and takes it the next time round', async () => {
    // A box that has not been started since the tag moved is still on the old
    // image, and the daemon refuses to remove it. That refusal is the safety
    // property, not an error to work around.
    fake.imagesInUse.add('sha256:one');
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();
    assert.deepEqual(fake.imagesRemoved, []);
    assert.ok(fake.untagged.has('sha256:one'));

    // The session started, was recreated on the current image, and let go.
    fake.imagesInUse.delete('sha256:one');
    fake.onPull = () => moveTagTo('sha256:three');
    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved, ['sha256:one', 'sha256:two']);
  });

  it('takes what an earlier process left behind, by the image label', async () => {
    // The id this process replaced is known outright; one an orchestrator
    // that has since restarted replaced is only findable because the image
    // carries a label of its own.
    fake.untagged.set('sha256:from-last-week', { [dk.IMAGE_LABEL]: dk.SESSION_IMAGE_KIND });
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved.sort(), ['sha256:from-last-week', 'sha256:one']);
  });

  it('never touches an untagged image that is not ours', async () => {
    // The orchestrator holds this host's Docker socket. An image somebody
    // else built is not its to reclaim, however unused it looks.
    fake.untagged.set('sha256:somebody-elses', { 'com.example.thing': 'yes' });
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved, ['sha256:one']);
    assert.ok(fake.untagged.has('sha256:somebody-elses'));
  });

  it('removes nothing when the tag did not move', async () => {
    fake.untagged.set('sha256:from-last-week', { [dk.IMAGE_LABEL]: dk.SESSION_IMAGE_KIND });

    await orchestrator.manager.refreshSessionImage();

    // A pull that changed nothing superseded nothing, and the sweep rides
    // along with the change rather than running on its own.
    assert.deepEqual(fake.imagesRemoved, []);
  });

  it('keeps every copy when the deployment turns pruning off', async () => {
    await orchestrator.app.close();
    db.close();
    db = openDb(dir);
    orchestrator = buildApp(
      loadConfig({ DATA_DIR: dir, SESSION_IMAGE: IMAGE, SESSION_IMAGE_PRUNE: 'false' }),
      db,
    );
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved, []);
  });
});

describe('reading the uid back off the session image', () => {
  /** Installs a daemon whose image reports `user` as its own `USER`. */
  function withImageUser(user: string | undefined): void {
    dk.setDockerForTests({
      getImage: () => ({
        inspect: async () => ({ Id: 'sha256:one', Config: user === undefined ? {} : { User: user } }),
      }),
    } as unknown as Docker);
  }

  it('reads a numeric USER, which is what the image is built with', async () => {
    withImageUser('1020');
    assert.equal(await dk.imageUserUid(IMAGE), 1020);
  });

  it('ignores a uid:gid pair beyond its uid', async () => {
    withImageUser('1020:1020');
    assert.equal(await dk.imageUserUid(IMAGE), 1020);
  });

  it('says nothing about an image whose USER is a name', async () => {
    // An older image, or one built elsewhere: there is no uid to compare, and
    // guessing at one would be worse than staying quiet.
    withImageUser('agent');
    assert.equal(await dk.imageUserUid(IMAGE), null);
  });

  it('says nothing about an image with no USER at all', async () => {
    withImageUser(undefined);
    assert.equal(await dk.imageUserUid(IMAGE), null);
  });
});

describe('starting a session whose files are gone', () => {
  /** The session status as the row now stands. */
  function status(id: string): string {
    return (db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string })
      .status;
  }

  it('refuses rather than letting the daemon make an empty workspace', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    // What a crash during a delete, or a backup restored in part, leaves.
    // Docker would create the bind source itself, empty and owned by root:
    // the box would start, look healthy, and the agent could not write in it.
    rmSync(ws.workspacePath(dir, 'a1'), { recursive: true, force: true });

    await assert.rejects(
      () => orchestrator.manager.start('a1'),
      /workspace directory/,
    );
    assert.deepEqual(fake.created, []);
    assert.equal(status('a1'), 'error');
    // And nothing was put back: the missing half is not this process's to
    // invent.
    assert.ok(!existsSync(ws.workspacePath(dir, 'a1')));
  });

  it('refuses for a home that is gone, and seeds no fresh one over it', async () => {
    insertSession('a2', 'c1', 'sha256:one');
    rmSync(ws.homePath(dir, 'a2'), { recursive: true, force: true });

    await assert.rejects(() => orchestrator.manager.start('a2'), /home directory/);
    assert.deepEqual(fake.created, []);
    assert.equal(status('a2'), 'error');
    // The home holds the adapter's thread transcripts, so a fresh one would
    // erase every conversation while looking like a repair.
    assert.ok(!existsSync(ws.homePath(dir, 'a2')));
  });

  it('names both when both are gone', async () => {
    insertSession('a3', 'c1', 'sha256:one');
    rmSync(ws.workspacePath(dir, 'a3'), { recursive: true, force: true });
    rmSync(ws.homePath(dir, 'a3'), { recursive: true, force: true });

    await assert.rejects(
      () => orchestrator.manager.execTarget('a3'),
      /workspace directory.*and.*home directory/s,
    );
  });

  it('says nothing about a session whose halves are still volumes', async () => {
    // A session from before either became a directory mounts a named volume,
    // which Docker keeps on its own and this has no path to check.
    insertSession('a4', 'c1', 'sha256:one', 'volume');
    fake.containers.get('c1')!.running = true;

    await orchestrator.manager.start('a4');

    assert.equal(status('a4'), 'running');
  });
});

describe('one operation per session at a time', () => {
  it('does not let two starts both replace the same container', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');

    // Both requests read the same row, and both decide the container has to
    // be replaced. Run together, the second removes the container the first
    // just built and started.
    await Promise.all([orchestrator.manager.start('a1'), orchestrator.manager.start('a1')]);

    assert.deepEqual(fake.removed, ['c1']);
    assert.equal(fake.created.length, 1);
  });

  it('lets a stop overtake the start it arrived under', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');
    let stopping: Promise<unknown> | null = null;
    // The stop arrives while the replacement container is being created,
    // which is the middle of the start rather than a gap between requests.
    fake.onCreate = () => {
      stopping ??= orchestrator.manager.stop('a1');
    };

    await assert.rejects(() => orchestrator.manager.start('a1'), /stopped/);
    await stopping;

    // The start gave up at its next step, and the stop did not wait it out.
    const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get('a1') as {
      status: string;
    };
    assert.equal(row.status, 'stopped');
  });

  it('tells the reaper no rather than making it wait', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');
    let asked: Promise<boolean> | null = null;
    fake.onCreate = () => {
      asked ??= orchestrator.manager.stopUnlessBusy('a1');
    };

    await orchestrator.manager.start('a1');

    // A tick that waited here would hold up every other session it has to
    // look at. This one comes back next minute instead.
    assert.equal(await asked, false);
    const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get('a1') as {
      status: string;
    };
    assert.equal(row.status, 'running');
  });

  it('stops writing to a session the moment it is deleted', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    /** When the session was last marked active, read back mid-teardown. */
    let active = -1;
    // The teardown takes seconds, and a terminal still attached to the box is
    // able to mark it active during it.
    fake.onRemove = () => {
      touchSession(db, 'a1');
      active = (
        db.prepare('SELECT last_active_at AS t FROM sessions WHERE id = ?').get('a1') as {
          t: number;
        }
      ).t;
    };

    const before = (
      db.prepare('SELECT last_active_at AS t FROM sessions WHERE id = ?').get('a1') as { t: number }
    ).t;

    await orchestrator.manager.remove('a1');

    // The tombstone goes down before anything else of the session does, so
    // there was never a moment when a write would have landed.
    assert.equal(active, before);
  });
});

describe('the upstreams the manager is holding', () => {
  it('forgets one for a box that is down and holding nothing', () => {
    insertSession('a1', 'c1', 'sha256:one');
    const first = orchestrator.manager.upstream('a1');

    orchestrator.manager.maintenance();

    // The reaper builds one of these for every running session on every tick,
    // and nothing else lets go of them. A fresh one rebuilds everything this
    // holds, because it holds nothing.
    assert.notEqual(orchestrator.manager.upstream('a1'), first);
  });

  it('keeps the one for a box that is up, which holds the reading of it', () => {
    insertSession('a1', 'c1', 'sha256:one');
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = 'a1'").run();
    const first = orchestrator.manager.upstream('a1');

    orchestrator.manager.maintenance();

    // What is running in a box is read onto its upstream, and the reaper asks
    // for that reading every tick. Dropping this would throw the answer away
    // a minute after it was taken, and a box with no answer is held.
    assert.equal(orchestrator.manager.upstream('a1'), first);
  });
});
