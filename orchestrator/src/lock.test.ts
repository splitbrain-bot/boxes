import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { claimDataDir, LOCK_FILE, LOCK_STALE_MS } from './lock.ts';

let dir: string;

/** The release functions of every claim a test took. */
const claims: Array<() => void> = [];

/** Claims the directory and remembers how to give it back. */
function claim(at: number): ReturnType<typeof claimDataDir> {
  const result = claimDataDir(dir, () => at);
  if (!result.held) claims.push(result.release);
  return result;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-lock-'));
});

afterEach(() => {
  for (const release of claims.splice(0)) release();
  rmSync(dir, { recursive: true, force: true });
});

test('a directory nobody holds is claimed', () => {
  const first = claim(1_000);
  assert.equal(first.held, false);
  assert.equal(first.held === false ? first.tookOver : 'x', null);
});

test('a directory somebody is still stamping is refused', () => {
  claim(1_000);
  const second = claimDataDir(dir, () => 1_000 + LOCK_STALE_MS - 1);
  assert.equal(second.held, true);
  assert.equal(second.held === true ? second.quietFor : -1, LOCK_STALE_MS - 1);
});

test('a claim nothing has stamped since it died is taken over', () => {
  // A killed container leaves this behind. Both processes are PID 1, so only
  // the clock tells them apart.
  claim(1_000);
  const later = claimDataDir(dir, () => 1_000 + LOCK_STALE_MS);
  assert.equal(later.held, false);
  assert.equal(later.held === false ? later.tookOver : 'x', 1_000);
  if (!later.held) later.release();
});

test('a claim an older build wrote as a bare id is taken over', () => {
  // The older format holds only a process id and no time. Nothing stamps it,
  // so an upgraded deployment can take it over.
  writeFileSync(join(dir, LOCK_FILE), '1\n');
  const upgraded = claim(5_000);
  assert.equal(upgraded.held, false);
  assert.equal(upgraded.held === false ? upgraded.tookOver : 'x', null);
  assert.match(readFileSync(join(dir, LOCK_FILE), 'utf8'), /"at":5000/);
});

test('releasing lets the next process straight in', () => {
  const first = claim(1_000);
  if (!first.held) first.release();
  const second = claimDataDir(dir, () => 1_100);
  assert.equal(second.held, false);
  if (!second.held) second.release();
});
