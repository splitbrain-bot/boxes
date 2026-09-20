import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { claimDataDir, LOCK_FILE, LOCK_STALE_MS } from './lock.ts';

/**
 * The claim on a data directory, over a clock a test can move.
 *
 * The case worth the file is the one a process id cannot answer: a container
 * killed rather than stopped leaves a claim behind, and the replacement is
 * PID 1 exactly as its predecessor was.
 */

let dir: string;
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
  // What a container killed rather than stopped leaves behind. The process
  // that wrote this is gone, and the one reading it is PID 1 just as that
  // one was, so only the clock can tell them apart.
  claim(1_000);
  const later = claimDataDir(dir, () => 1_000 + LOCK_STALE_MS);
  assert.equal(later.held, false);
  assert.equal(later.held === false ? later.tookOver : 'x', 1_000);
  if (!later.held) later.release();
});

test('a claim an older build wrote as a bare id is taken over', () => {
  // Before this file, the claim was the holder's process id and nothing
  // else. It says nothing about when, and whatever wrote it is not stamping,
  // so a deployment upgrading onto this is not locked out by its own
  // predecessor.
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
