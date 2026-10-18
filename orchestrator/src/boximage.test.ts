import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { loadConfig } from './config.ts';
import { type Db, openDb, touchBox } from './db.ts';
import * as dk from './docker.ts';
import { setFileServiceSpawnerForTests } from './files.ts';
import { inProcessFileService } from './files-in-process.ts';
import { patchSettings } from './settings.ts';
import * as ws from './workspaces.ts';

/** The box image the test config names. */
const IMAGE = 'ghcr.io/example/box:latest';

/** The state of the fake Docker daemon. */
interface Fake {
  /** Maps each image reference to the image id that it resolves to now. */
  images: Map<string, string>;
  /** Maps each container id to its image id and its run state. */
  containers: Map<string, { image: string; running: boolean }>;
  /** The options of each created container, in order. */
  created: Array<Record<string, unknown>>;
  /** The ids of the removed containers, in order. */
  removed: string[];
  /** Each pulled image reference, in order. */
  pulled: string[];
  /**
   * The image ids on the host without a tag, with the labels of each image. A
   * pull that moves the tag puts the old id here, as the daemon does.
   */
  untagged: Map<string, Record<string, string>>;
  /** The image ids that a container still uses, which the daemon refuses to remove. */
  imagesInUse: Set<string>;
  /** The removed image ids, in order. */
  imagesRemoved: string[];
  /** Changes `images` at a pull, so a test can move a tag. */
  onPull?: (image: string) => void;
  /** Runs when a container is created, for an event during an operation. */
  onCreate?: () => void;
  /** Runs when a container is removed, for an event during a teardown. */
  onRemove?: () => void;
  /** The networks of the daemon. A prune can remove the network of a container. */
  networks: Set<string>;
  /** The containers in which `boxes-setup` ran, in order. */
  setups: string[];
  /** The exit code and the output of `boxes-setup`. */
  setupExit: { code: number; output: string };
}

/**
 * Makes an error like the 404 of the daemon for a missing object.
 *
 * @param what The kind of the object, for the message.
 * @returns The error with the status code 404.
 */
function notFound(what: string): Error {
  return Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
}

/**
 * Installs the fake daemon as the Docker client.
 *
 * @param fake The state of the fake daemon.
 */
function install(fake: Fake): void {
  dk.setDockerForTests(dockerFor(fake));
}

/**
 * Builds the fake Docker client, so a test can replace one part of it.
 *
 * @param fake The state of the fake daemon.
 * @returns The fake client.
 */
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
        return { Image: c.image, State: { Running: c.running } };
      },
      start: async () => {
        const c = fake.containers.get(id);
        // The daemon answers 404 to the start of a container that it does not have.
        // A pruned box looks like this to the orchestrator.
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
      // The only exec in this suite is the setup, under `timeout`.
      exec: async (opts: { Cmd: string[] }) => {
        assert.equal(opts.Cmd[3], 'boxes-setup');
        fake.setups.push(id);
        return {
          start: async () => {
            const stream = new PassThrough();
            queueMicrotask(() => stream.end(frame(fake.setupExit.output)));
            return stream;
          },
          inspect: async () => ({ ExitCode: fake.setupExit.code }),
        };
      },
    }),
    createContainer: async (opts: Record<string, unknown>) => {
      fake.onCreate?.();
      fake.created.push(opts);
      // Docker finds a container by its name too, so the name stands in for the id.
      const id = opts.name as string;
      fake.containers.set(id, {
        image: fake.images.get(opts.Image as string) ?? 'unresolved',
        running: false,
      });
      return { id };
    },
    pull: async (image: string) => {
      fake.pulled.push(image);
      fake.onPull?.(image);
      return new PassThrough();
    },
    listNetworks: async () => [],
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!fake.networks.has(name)) throw notFound('network');
        // This answer is enough for ensureProxyAttached, which accepts each answer.
        // The suite reads `fake.networks` directly.
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
      demuxStream: new Docker({ socketPath: '/var/run/docker.sock' }).modem.demuxStream,
    },
  } as unknown as Docker;
}

/**
 * Makes one stderr frame of a multiplexed Docker stream.
 *
 * @param text The payload of the frame.
 * @returns The frame with its header.
 */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * Reads the lines of the managed file in the home of a box.
 *
 * @param boxId The id of the box.
 * @returns The lines, or an empty list when the file does not exist.
 */
function managed(boxId: string): string[] {
  const path = join(ws.homePath(dir, boxId), '.boxes', 'managed');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

/** The temporary DATA_DIR of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The app and the objects behind it, built for each test. */
let orchestrator: Orchestrator;
/** The state of the fake Docker daemon of each test. */
let fake: Fake;

/**
 * Inserts a stopped box with its container `box-<id>` on `imageId`.
 *
 * The workspace and home directories are created too, because a start
 * refuses a box whose bind sources are gone.
 *
 * @param id The id of the box.
 * @param imageId The image id of the container.
 */
function insertBox(id: string, imageId: string): void {
  const now = Date.now();
  fake.containers.set(`box-${id}`, { image: imageId, running: false });
  db.prepare(
    `INSERT INTO boxes (id, name, profile, status, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'stopped', ?, ?)`,
  ).run(id, now, now);
  ws.createWorkspace(dir, id);
  ws.createHome(dir, id);
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
    networks: new Set(['bn-a1', 'bn-a2', 'bn-a3', 'bn-a4', 'bn-a5', 'bn-gone']),
    setups: [],
    setupExit: { code: 0, output: '' },
  };
  install(fake);
  db = openDb(dir);
  orchestrator = buildApp(loadConfig({ DATA_DIR: dir, BOX_IMAGE: IMAGE }), db);
  await orchestrator.egress.prepare();
  // The file service of each container uses the directories of the one box that
  // the test starts. The agent set install writes to its home.
  setFileServiceSpawnerForTests(
    inProcessFileService(() => {
      const [row] = db.prepare('SELECT id FROM boxes').all() as Array<{ id: string }>;
      return {
        workspace: ws.workspacePath(dir, row!.id),
        home: ws.homePath(dir, row!.id),
        nix: ws.nixPath(dir, row!.id),
      };
    }),
  );
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  setFileServiceSpawnerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('starting a box whose image has moved', () => {
  it('recreates the container on what the tag now resolves to', async () => {
    insertBox('a1', 'sha256:one');
    // The tag stays the same and points at a new id. A comparison of tags would
    // miss this.
    fake.images.set(IMAGE, 'sha256:two');

    await orchestrator.manager.start('a1');

    assert.deepEqual(fake.removed, ['box-a1']);
    assert.equal(fake.created.length, 1);
    assert.equal(fake.created[0]!.Image, IMAGE);
    assert.equal(fake.containers.get('box-a1')?.image, 'sha256:two');
    // The container runs, and is not only created.
    assert.equal(fake.containers.get('box-a1')?.running, true);
  });

  it('brings the workspace, the home and the nix store across untouched', async () => {
    insertBox('a2', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');

    await orchestrator.manager.start('a2');

    // All durable data of a box is in these three mounts, so a new container is
    // cheap and loses nothing.
    const host = fake.created[0]!.HostConfig as { Binds: string[] };
    assert.deepEqual(host.Binds, [
      `${dir}/workspaces/a2:/workspace`,
      `${dir}/homes/a2:/home/agent`,
      `${dir}/nix/a2:/nix`,
    ]);
  });

  it('moves a box onto the current image for a terminal too', async () => {
    insertBox('a1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');

    // A terminal starts a stopped box without start(), and runs the same repairs.
    await orchestrator.manager.execTarget('a1');

    assert.deepEqual(fake.removed, ['box-a1']);
    assert.equal(fake.containers.get('box-a1')?.image, 'sha256:two');
    assert.equal(fake.created[0]!.Image, IMAGE);
  });

  it('leaves a box already on the current image alone', async () => {
    insertBox('a3', 'sha256:one');

    await orchestrator.manager.start('a3');

    assert.deepEqual(fake.removed, []);
    assert.equal(fake.created.length, 0);
    assert.equal(fake.containers.get('box-a3')?.running, true);
  });

  it('defers a running container rather than killing the turn in it', async () => {
    insertBox('a4', 'sha256:one');
    fake.containers.get('box-a4')!.running = true;
    fake.images.set(IMAGE, 'sha256:two');

    await orchestrator.manager.start('a4');

    // The idle reaper stops it later, and the next start moves it to the new image.
    assert.deepEqual(fake.removed, []);
    assert.equal(fake.containers.get('box-a4')?.image, 'sha256:one');
  });

  it('starts the box as it is when the new image is not on the host', async () => {
    insertBox('a5', 'sha256:one');
    fake.images.delete(IMAGE);

    await orchestrator.manager.start('a5');

    assert.deepEqual(fake.removed, []);
    assert.equal(fake.containers.get('box-a5')?.running, true);
  });
});

describe('starting a box Docker has forgotten', () => {
  it('rebuilds a container something pruned, and starts it', async () => {
    insertBox('a1', 'sha256:one');
    // `docker container prune` removes every stopped container, and an idle box
    // is a stopped container. No durable data goes with it, because the
    // workspace, the home and the Nix store are directories on the data volume.
    fake.containers.delete('box-a1');

    const detail = await orchestrator.manager.start('a1');

    assert.equal(fake.created.length, 1);
    assert.equal(fake.containers.get('box-a1')?.running, true);
    assert.equal(detail.status, 'running');
  });

  it('brings the workspace and the home back with it', async () => {
    insertBox('a2', 'sha256:one');
    fake.containers.delete('box-a2');

    await orchestrator.manager.start('a2');

    // The row describes the container. The data that the row cannot reproduce is
    // in these directories, which the new container mounts as the old one did.
    const host = fake.created[0]!.HostConfig as { Binds: string[] };
    assert.deepEqual(host.Binds, [
      `${dir}/workspaces/a2:/workspace`,
      `${dir}/homes/a2:/home/agent`,
      `${dir}/nix/a2:/nix`,
    ]);
  });

  it('makes the network again when that went with it', async () => {
    insertBox('a3', 'sha256:one');
    // `docker system prune` removes the container, and then the network without
    // containers.
    fake.containers.delete('box-a3');
    fake.networks.delete('bn-a3');

    await orchestrator.manager.start('a3');

    assert.ok(fake.networks.has('bn-a3'));
    const host = fake.created[0]!.HostConfig as { NetworkMode: string };
    assert.equal(host.NetworkMode, 'bn-a3');
  });

  it('leaves a container that is merely stopped alone', async () => {
    insertBox('a4', 'sha256:one');

    await orchestrator.manager.start('a4');

    // A stopped container is started, not replaced.
    assert.deepEqual(fake.created, []);
    assert.deepEqual(fake.removed, []);
    assert.equal(fake.containers.get('box-a4')?.running, true);
  });

  it('does not rebuild on a daemon that would not answer', async () => {
    insertBox('a5', 'sha256:one');
    // A 500 means a daemon with a problem, not a missing container. A rebuild
    // could replace a working container after a failed inspect.
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
    insertBox('a1', 'sha256:one');
    fake.containers.delete('box-a1');

    // A thread or a terminal starts a stopped box without start(), so the repair
    // cannot be only in start().
    const target = await orchestrator.manager.execTarget('a1');

    assert.equal(fake.created.length, 1);
    assert.equal(target.boxId, 'a1');
    assert.equal(fake.containers.get('box-a1')?.running, true);
  });
});

describe('having the box image at all', () => {
  it('pulls it when it is not on the host', async () => {
    fake.images.delete(IMAGE);
    fake.onPull = (image) => fake.images.set(image, 'sha256:pulled');

    await orchestrator.manager.ensureBoxImage();

    assert.deepEqual(fake.pulled, [IMAGE]);
  });

  it('does not pull one that is already here', async () => {
    await orchestrator.manager.ensureBoxImage();
    assert.deepEqual(fake.pulled, []);
  });

  it('refreshes on demand, so a moving tag moves on this host too', async () => {
    fake.onPull = (image) => fake.images.set(image, 'sha256:two');

    await orchestrator.manager.refreshBoxImage();

    assert.deepEqual(fake.pulled, [IMAGE]);
    assert.equal(fake.images.get(IMAGE), 'sha256:two');
  });
});

/**
 * Moves the tag to `id` as a pull does. The old id stays on the host without a tag.
 *
 * @param id The new image id of the tag.
 */
function moveTagTo(id: string): void {
  const before = fake.images.get(IMAGE);
  if (before) fake.untagged.set(before, { [dk.IMAGE_LABEL]: dk.BOX_IMAGE_KIND });
  fake.images.set(IMAGE, id);
}

describe('reclaiming what a pull superseded', () => {
  it('removes the copy the tag moved off', async () => {
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshBoxImage();

    // Each pull that moves the tag leaves the old image on the host without a tag.
    assert.deepEqual(fake.imagesRemoved, ['sha256:one']);
  });

  it('leaves the one a box is still on, and takes it the next time round', async () => {
    // A box that did not start after the tag moved is still on the old image,
    // and the daemon refuses to remove it. The refusal keeps the box safe.
    fake.imagesInUse.add('sha256:one');
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshBoxImage();
    assert.deepEqual(fake.imagesRemoved, []);
    assert.ok(fake.untagged.has('sha256:one'));

    // The box started on a new container with the current image, so the old image is free.
    fake.imagesInUse.delete('sha256:one');
    fake.onPull = () => moveTagTo('sha256:three');
    await orchestrator.manager.refreshBoxImage();

    assert.deepEqual(fake.imagesRemoved, ['sha256:one', 'sha256:two']);
  });

  it('takes what an earlier process left behind, by the image label', async () => {
    // An image replaced before a restart can be found only by its label.
    fake.untagged.set('sha256:from-last-week', { [dk.IMAGE_LABEL]: dk.BOX_IMAGE_KIND });
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshBoxImage();

    assert.deepEqual(fake.imagesRemoved.sort(), ['sha256:from-last-week', 'sha256:one']);
  });

  it('never touches an untagged image that is not ours', async () => {
    // The orchestrator holds the Docker socket of this host. It must not remove an
    // image that somebody else built, also when the image looks unused.
    fake.untagged.set('sha256:somebody-elses', { 'com.example.thing': 'yes' });
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshBoxImage();

    assert.deepEqual(fake.imagesRemoved, ['sha256:one']);
    assert.ok(fake.untagged.has('sha256:somebody-elses'));
  });

  it('removes nothing when the tag did not move', async () => {
    fake.untagged.set('sha256:from-last-week', { [dk.IMAGE_LABEL]: dk.BOX_IMAGE_KIND });

    await orchestrator.manager.refreshBoxImage();

    // The sweep runs only when a pull moves the tag.
    assert.deepEqual(fake.imagesRemoved, []);
  });

  it('keeps every copy when the deployment turns pruning off', async () => {
    await orchestrator.app.close();
    db.close();
    db = openDb(dir);
    orchestrator = buildApp(
      loadConfig({ DATA_DIR: dir, BOX_IMAGE: IMAGE, BOX_IMAGE_PRUNE: 'false' }),
      db,
    );
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshBoxImage();

    assert.deepEqual(fake.imagesRemoved, []);
  });
});

describe('starting a box whose files are gone', () => {
  /**
   * Reads the current status in the row of a box.
   *
   * @param id The id of the box.
   * @returns The status.
   */
  function status(id: string): string {
    return (db.prepare('SELECT status FROM boxes WHERE id = ?').get(id) as { status: string })
      .status;
  }

  it('refuses rather than letting the daemon make an empty workspace', async () => {
    insertBox('a1', 'sha256:one');
    // A crash during a delete, or a partial restore of a backup, leaves this state.
    // Docker would create an empty bind source owned by root. The box would start
    // and look healthy, but the agent could not write in it.
    rmSync(ws.workspacePath(dir, 'a1'), { recursive: true, force: true });

    await assert.rejects(() => orchestrator.manager.start('a1'), /workspace directory/);
    assert.deepEqual(fake.created, []);
    assert.equal(status('a1'), 'error');
    // The orchestrator does not recreate the missing directory.
    assert.ok(!existsSync(ws.workspacePath(dir, 'a1')));
  });

  it('refuses for a home that is gone, and seeds no fresh one over it', async () => {
    insertBox('a2', 'sha256:one');
    rmSync(ws.homePath(dir, 'a2'), { recursive: true, force: true });

    await assert.rejects(() => orchestrator.manager.start('a2'), /home directory/);
    assert.deepEqual(fake.created, []);
    assert.equal(status('a2'), 'error');
    // The home holds the thread transcripts of the adapter, so a new home would
    // erase every thread and look like a repair.
    assert.ok(!existsSync(ws.homePath(dir, 'a2')));
  });

  it('names both when both are gone', async () => {
    insertBox('a3', 'sha256:one');
    rmSync(ws.workspacePath(dir, 'a3'), { recursive: true, force: true });
    rmSync(ws.homePath(dir, 'a3'), { recursive: true, force: true });

    await assert.rejects(
      () => orchestrator.manager.execTarget('a3'),
      /workspace directory.*and.*home directory/s,
    );
  });
});

describe('one operation per box at a time', () => {
  it('does not let two starts both replace the same container', async () => {
    insertBox('a1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');

    // Both requests read the same row, and both decide to replace the container.
    // When they run together, the second removes the container that the first
    // built and started.
    await Promise.all([orchestrator.manager.start('a1'), orchestrator.manager.start('a1')]);

    assert.deepEqual(fake.removed, ['box-a1']);
    assert.equal(fake.created.length, 1);
  });

  it('lets a stop overtake the start it arrived under', async () => {
    insertBox('a1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');
    let stopping: Promise<unknown> | null = null;
    // The stop arrives during the creation of the new container, in the middle of
    // the start and not between two requests.
    fake.onCreate = () => {
      stopping ??= orchestrator.manager.stop('a1');
    };

    await assert.rejects(() => orchestrator.manager.start('a1'), /stopped/);
    await stopping;

    // The start gave up at its next step, and the stop did not wait for its end.
    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('a1') as {
      status: string;
    };
    assert.equal(row.status, 'stopped');
  });

  it('tells the reaper no rather than making it wait', async () => {
    insertBox('a1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');
    let asked: Promise<boolean> | null = null;
    fake.onCreate = () => {
      asked ??= orchestrator.manager.stopUnlessBusy('a1');
    };

    await orchestrator.manager.start('a1');

    // A tick that waited here would delay every other box that it checks. The
    // reaper checks this box again at the next tick.
    assert.equal(await asked, false);
    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('a1') as {
      status: string;
    };
    assert.equal(row.status, 'running');
  });

  it('stops writing to a box the moment it is deleted', async () => {
    insertBox('a1', 'sha256:one');
    /** The last activity time of the box, read during the teardown. */
    let active = -1;
    // The teardown takes seconds, and a terminal that is still attached to the
    // box can mark it active during that time.
    fake.onRemove = () => {
      touchBox(db, 'a1');
      active = (
        db.prepare('SELECT last_active_at AS t FROM boxes WHERE id = ?').get('a1') as {
          t: number;
        }
      ).t;
    };

    const before = (
      db.prepare('SELECT last_active_at AS t FROM boxes WHERE id = ?').get('a1') as { t: number }
    ).t;

    await orchestrator.manager.remove('a1');

    // The tombstone is set before the teardown starts, so no write lands.
    assert.equal(active, before);
  });
});

describe('making a box ready', () => {
  it('writes its files, runs the setup and installs the agent set after a start, once', async () => {
    insertBox('a1', 'sha256:one');
    orchestrator.agents.putItem('global', { name: 'ship', content: 'Open a PR.' });
    patchSettings(db, { gitName: 'Some "One"', gitEmail: 'one@example.com' });

    await orchestrator.manager.start('a1');

    assert.deepEqual(fake.setups, ['box-a1']);
    assert.match(
      readFileSync(join(ws.homePath(dir, 'a1'), '.boxes/proxy-ca.crt'), 'utf8'),
      /BEGIN CERTIFICATE/,
    );
    assert.equal(
      readFileSync(join(ws.homePath(dir, 'a1'), '.config/git/config'), 'utf8'),
      '[user]\n\tname = "Some \\"One\\""\n\temail = "one@example.com"\n[init]\n\tdefaultBranch = main\n' +
        '[advice]\n\tdetachedHead = false\n[safe]\n\tdirectory = *\n',
    );
    // The diagrams skill of the orchestrator comes with every set.
    assert.deepEqual(managed('a1'), [
      '.agents/skills/diagrams',
      '.agents/skills/ship',
      '.claude/skills/diagrams',
      '.claude/skills/ship',
    ]);
    assert.equal(
      readFileSync(join(ws.homePath(dir, 'a1'), '.claude/skills/ship/SKILL.md'), 'utf8'),
      'Open a PR.\n',
    );
    assert.equal((await orchestrator.manager.detail('a1')).status, 'running');

    // The box is up and set up, so a terminal on it runs no setup again.
    await orchestrator.manager.execTarget('a1');
    assert.deepEqual(fake.setups, ['box-a1']);
  });

  it('runs the setup again after the next start', async () => {
    insertBox('a1', 'sha256:one');
    await orchestrator.manager.start('a1');
    await orchestrator.manager.stop('a1');
    await orchestrator.manager.start('a1');
    assert.deepEqual(fake.setups, ['box-a1', 'box-a1']);
  });

  it('sets up a running box that was not set up, for example after a crash', async () => {
    insertBox('a1', 'sha256:one');
    fake.containers.get('box-a1')!.running = true;
    await orchestrator.manager.execTarget('a1');
    assert.deepEqual(fake.setups, ['box-a1']);
  });

  it('marks the box as an error when the setup fails, with its output', async () => {
    insertBox('a1', 'sha256:one');
    fake.setupExit = { code: 1, output: '[setup] ERROR: /nix is not writable\n' };

    await assert.rejects(orchestrator.manager.start('a1'), /nix is not writable/);

    assert.equal((await orchestrator.manager.detail('a1')).status, 'error');
    assert.deepEqual(managed('a1'), []);
    // The next start tries again.
    fake.setupExit = { code: 0, output: '' };
    await orchestrator.manager.start('a1');
    assert.equal((await orchestrator.manager.detail('a1')).status, 'running');
  });

  it('names an image without the setup', async () => {
    insertBox('a1', 'sha256:one');
    fake.setupExit = { code: 127, output: '' };
    await assert.rejects(orchestrator.manager.start('a1'), /has no boxes-setup/);
    assert.equal((await orchestrator.manager.detail('a1')).status, 'error');
  });

  it('tells about the failed pull when the image is outdated', async () => {
    insertBox('a1', 'sha256:one');
    fake.onPull = () => {
      throw new Error('registry unreachable');
    };
    await assert.rejects(orchestrator.manager.refreshBoxImage(), /registry unreachable/);
    fake.setupExit = { code: 127, output: '' };
    await assert.rejects(
      orchestrator.manager.start('a1'),
      /has no boxes-setup.*The last pull of the box image failed: registry unreachable/,
    );
  });
});

describe('the upstreams the manager is holding', () => {
  it('forgets one for a box that is down and holding nothing', () => {
    insertBox('a1', 'sha256:one');
    const first = orchestrator.manager.upstream('a1');

    orchestrator.manager.maintenance();

    // The reaper builds an upstream for each running box that it checks, and
    // nothing else removes them. This upstream holds nothing, so a new upstream
    // loses nothing.
    assert.notEqual(orchestrator.manager.upstream('a1'), first);
  });

  it('keeps the one for a box that is up, which holds the reading of it', () => {
    insertBox('a1', 'sha256:one');
    db.prepare("UPDATE boxes SET status = 'running' WHERE id = 'a1'").run();
    const first = orchestrator.manager.upstream('a1');

    orchestrator.manager.maintenance();

    // The upstream holds the process reading of the box, and the reaper asks for
    // it at each tick. A new upstream has no reading, and the reaper does not stop
    // a box without a reading.
    assert.equal(orchestrator.manager.upstream('a1'), first);
  });
});

describe('repairing the isolation of running boxes', () => {
  it('makes the network of a running box again', async () => {
    insertBox('a1', 'sha256:one');
    db.prepare("UPDATE boxes SET status = 'running' WHERE id = 'a1'").run();
    fake.containers.get('box-a1')!.running = true;
    fake.networks.delete('bn-a1');

    await orchestrator.manager.reconcileIsolation();

    assert.ok(fake.networks.has('bn-a1'));
    // A running container is never replaced.
    assert.deepEqual(fake.created, []);
  });

  it('leaves a box alone whose container has stopped', async () => {
    insertBox('a1', 'sha256:one');
    db.prepare("UPDATE boxes SET status = 'running' WHERE id = 'a1'").run();
    fake.images.set(IMAGE, 'sha256:two');

    assert.deepEqual(await orchestrator.manager.reconcileIsolation(), []);
    // The image change waits for the next start.
    assert.deepEqual(fake.created, []);
    assert.deepEqual(fake.removed, []);
  });

  it('skips a box with an operation in flight, rather than waiting for it', async () => {
    insertBox('a1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');
    let repaired: Promise<string[]> | null = null;
    // The start holds the box while it replaces the container.
    fake.onCreate = () => {
      db.prepare("UPDATE boxes SET status = 'running' WHERE id = 'a1'").run();
      repaired ??= orchestrator.manager.reconcileIsolation();
    };

    await orchestrator.manager.start('a1');

    assert.deepEqual(await repaired, []);
    assert.equal(fake.created.length, 1);
  });
});
