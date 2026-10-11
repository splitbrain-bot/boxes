import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BoxUsage } from './diskusage.ts';

/** The TTL the tests use. */
const TTL = 1000;

/**
 * A usage tracker over a stub measurement that records every call, with a
 * clock the test moves.
 */
function usage(measure: (id: string) => Promise<number> = async () => 42) {
  const calls: string[] = [];
  const stored: Array<{ id: string; bytes: number; at: number }> = [];
  const troubles: string[] = [];
  const clock = { now: 10_000 };
  const tracker = new BoxUsage({
    measure: async (id) => {
      calls.push(id);
      return measure(id);
    },
    store: (id, bytes, at) => stored.push({ id, bytes, at }),
    ttlMs: TTL,
    now: () => clock.now,
    onTrouble: (id) => troubles.push(id),
  });
  return { tracker, calls, stored, troubles, clock };
}

test('a box with no measurement is measured, and the result is stored with its time', async () => {
  const { tracker, stored } = usage();
  tracker.refresh('a', null);
  await tracker.settled();
  assert.deepEqual(stored, [{ id: 'a', bytes: 42, at: 10_000 }]);
});

test('a measurement stands until the TTL has passed', async () => {
  const { tracker, calls, clock } = usage();
  tracker.refresh('a', clock.now - TTL + 1);
  await tracker.settled();
  assert.deepEqual(calls, []);
  tracker.refresh('a', clock.now - TTL);
  await tracker.settled();
  assert.deepEqual(calls, ['a']);
});

test('a box with a measurement queued does not queue a second', async () => {
  let release: () => void = () => {};
  const { tracker, calls } = usage(
    () =>
      new Promise((resolve) => {
        release = () => resolve(1);
      }),
  );
  tracker.refresh('a', null);
  tracker.refresh('a', null);
  await Promise.resolve();
  await Promise.resolve();
  release();
  await tracker.settled();
  assert.deepEqual(calls, ['a']);
});

test('a failed measurement stores nothing, and is tried again only after the TTL', async () => {
  const { tracker, calls, stored, troubles, clock } = usage(async () => {
    throw new Error('box gone');
  });
  tracker.refresh('a', null);
  await tracker.settled();
  tracker.refresh('a', null);
  await tracker.settled();
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(stored, []);
  assert.deepEqual(troubles, ['a']);

  clock.now += TTL;
  tracker.refresh('a', null);
  await tracker.settled();
  assert.deepEqual(calls, ['a', 'a']);
});

test('a measurement before a stop runs at once, whatever the TTL says', async () => {
  const { tracker, stored, clock } = usage();
  await tracker.measureNow('a');
  clock.now += 1;
  await tracker.measureNow('a');
  assert.deepEqual(
    stored.map((s) => s.at),
    [10_000, 10_001],
  );
});

test('a failed measurement before a stop does not throw', async () => {
  const { tracker, troubles } = usage(async () => {
    throw new Error('timed out');
  });
  await tracker.measureNow('a');
  assert.deepEqual(troubles, ['a']);
});
