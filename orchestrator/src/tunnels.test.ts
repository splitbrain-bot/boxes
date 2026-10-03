import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { openDb, type Db } from './db.ts';
import {
  boxLabel,
  deploymentLabel,
  hostedTunnels,
  TUNNEL_GRACE_MS,
  TunnelReconciler,
  type BoxReading,
  type RemoteTunnel,
  type TunnelApi,
  type TunnelRef,
} from './tunnels.ts';

/** The deployment every case runs as. */
const DEPLOYMENT = 'd1d2d3d4';

/** A start time for the fake clock, in epoch milliseconds. */
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-tunnels-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A Dev Tunnels account held in memory, which records every call. */
function fakeApi(tunnels: RemoteTunnel[]): {
  api: TunnelApi;
  reads: string[];
  labelled: Array<{ id: string; labels: string[] }>;
  removed: string[];
} {
  const store = new Map(tunnels.map((t) => [t.id, t]));
  const reads: string[] = [];
  const labelled: Array<{ id: string; labels: string[] }> = [];
  const removed: string[] = [];
  return {
    reads,
    labelled,
    removed,
    api: {
      available: () => true,
      get: async (ref: TunnelRef) => {
        reads.push(ref.id);
        return store.get(ref.id) ?? null;
      },
      setLabels: async (ref, labels) => {
        labelled.push({ id: ref.id, labels });
      },
      remove: async (ref) => {
        removed.push(ref.id);
        store.delete(ref.id);
      },
    },
  };
}

/** A tunnel on port 3000 in `euw`, with the labels given. */
function tunnel(id: string, labels: string[] = []): RemoteTunnel {
  return {
    id,
    cluster: 'euw',
    labels,
    ports: [{ port: 3000, url: `https://${id}-3000.euw.devtunnels.ms/` }],
  };
}

/** The command line the skill starts. */
function hostCommand(id: string): string {
  return `devtunnel host ${id}.euw --access-token -`;
}

/** How many tunnels the table remembers. */
function tunnelCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM tunnels').get() as { n: number }).n;
}

/** A reconciler over the fake API, with box readings and a clock the case controls. */
function reconcilerFor(
  api: TunnelApi,
  readings: () => BoxReading[],
  now: () => number = () => T0,
): TunnelReconciler {
  return new TunnelReconciler(db, api, DEPLOYMENT, async () => readings(), now);
}

test('a host process is read by its id and region, and nothing else counts', () => {
  assert.deepEqual(
    hostedTunnels([
      `/usr/local/bin/${hostCommand('abc123')}`,
      'devtunnel host def456.uks1',
      // Without a region, no later call could reach the tunnel.
      'devtunnel host ghi789',
      'grep devtunnel',
      'python3 -m http.server 3000',
    ]),
    [
      { id: 'abc123', cluster: 'euw' },
      { id: 'def456', cluster: 'uks1' },
    ],
  );
});

test('a newly served tunnel is read and labelled once, then remembered', async () => {
  const fake = fakeApi([tunnel('abc123', ['someone-elses'])]);
  const reconciler = reconcilerFor(fake.api, () => [
    { boxId: 'box1', commands: [hostCommand('abc123')] },
  ]);

  await reconciler.tick();
  await reconciler.tick();

  // The API is called for the new tunnel only, not on every tick.
  assert.deepEqual(fake.reads, ['abc123']);
  // Labels this deployment did not set stay on the tunnel.
  assert.deepEqual(fake.labelled, [
    {
      id: 'abc123',
      labels: ['someone-elses', deploymentLabel(DEPLOYMENT), boxLabel(DEPLOYMENT, 'box1')],
    },
  ]);
  assert.deepEqual(reconciler.forBox('box1'), [
    { id: 'abc123', cluster: 'euw', port: 3000, url: 'https://abc123-3000.euw.devtunnels.ms/' },
  ]);
});

test('an unserved tunnel is deleted after the grace period, and forgotten', async () => {
  const fake = fakeApi([tunnel('abc123')]);
  let now = T0;
  let commands = [hostCommand('abc123')];
  const reconciler = reconcilerFor(fake.api, () => [{ boxId: 'box1', commands }], () => now);

  await reconciler.tick();
  commands = [];
  await reconciler.tick();
  // An unserved tunnel is not shown, because nothing answers on it.
  assert.deepEqual(reconciler.forBox('box1'), []);
  now += TUNNEL_GRACE_MS - 1;
  await reconciler.tick();
  assert.deepEqual(fake.removed, []);

  now += 1;
  await reconciler.tick();
  assert.deepEqual(fake.removed, ['abc123']);
  assert.equal(tunnelCount(), 0);
});

test('a host process that comes back in time keeps the tunnel', async () => {
  const fake = fakeApi([tunnel('abc123')]);
  let now = T0;
  let commands = [hostCommand('abc123')];
  const reconciler = reconcilerFor(fake.api, () => [{ boxId: 'box1', commands }], () => now);

  await reconciler.tick();
  commands = [];
  await reconciler.tick();
  now += TUNNEL_GRACE_MS / 2;
  commands = [hostCommand('abc123')];
  await reconciler.tick();
  // The grace period starts over once the tunnel is unserved again.
  commands = [];
  await reconciler.tick();
  now += TUNNEL_GRACE_MS - 1;
  await reconciler.tick();

  assert.deepEqual(fake.removed, []);
  assert.deepEqual(fake.reads, ['abc123']);
});

test('a box that cannot be read keeps its tunnels', async () => {
  const fake = fakeApi([tunnel('abc123')]);
  let now = T0;
  let reading: BoxReading = { boxId: 'box1', commands: [hostCommand('abc123')] };
  const reconciler = reconcilerFor(fake.api, () => [reading], () => now);

  await reconciler.tick();
  reading = { boxId: 'box1', commands: null };
  now += 2 * TUNNEL_GRACE_MS;
  await reconciler.tick();
  await reconciler.tick();

  assert.deepEqual(fake.removed, []);
  assert.equal(reconciler.forBox('box1').length, 1);
});

test('a deleted box no longer read still has its tunnel deleted', async () => {
  const fake = fakeApi([tunnel('abc123')]);
  let now = T0;
  let readings: BoxReading[] = [{ boxId: 'box1', commands: [hostCommand('abc123')] }];
  const reconciler = reconcilerFor(fake.api, () => readings, () => now);

  await reconciler.tick();
  readings = [];
  await reconciler.tick();
  now += TUNNEL_GRACE_MS;
  await reconciler.tick();

  assert.deepEqual(fake.removed, ['abc123']);
});

test('a tunnel a box hosts that the service does not know is not remembered', async () => {
  const fake = fakeApi([]);
  const reconciler = reconcilerFor(fake.api, () => [
    { boxId: 'box1', commands: [hostCommand('gone123')] },
  ]);

  await reconciler.tick();

  assert.deepEqual(reconciler.forBox('box1'), []);
  assert.equal(tunnelCount(), 0);
});

test('without a stored login nothing is read and nothing changes', async () => {
  const fake = fakeApi([tunnel('abc123')]);
  let read = 0;
  const reconciler = new TunnelReconciler(
    db,
    { ...fake.api, available: () => false },
    DEPLOYMENT,
    async () => {
      read += 1;
      return [];
    },
  );

  await reconciler.tick();

  assert.equal(read, 0);
  assert.deepEqual(fake.reads, []);
});
