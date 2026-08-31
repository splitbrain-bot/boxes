import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import * as ws from './workspaces.ts';

/**
 * Workspace directories on the data volume: where they are, who may see them,
 * and that removing one cannot reach out of it.
 */

let dir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'boxes-outside-'));
});

afterEach(() => {
  for (const d of [dir, outside]) rmSync(d, { recursive: true, force: true });
});

test('the workspaces parent is created 0700', () => {
  ws.ensureWorkspacesRoot(dir);
  const mode = statSync(ws.workspacesRoot(dir)).mode & 0o777;
  // One session's files must not be readable from another, and the only thing
  // that reads across all of them is the orchestrator. A stray
  // `docker run -v boxes-data:/x` sees nothing through this.
  assert.equal(mode, 0o700);
});

test('a workspace is created under the parent and reported back', () => {
  const path = ws.createWorkspace(dir, 'abcd1234');
  assert.equal(path, join(dir, 'workspaces', 'abcd1234'));
  assert.ok(statSync(path).isDirectory());
});

test('creating a workspace creates the parent it needs', () => {
  // No ensureWorkspacesRoot first: create is also the first thing a fresh
  // deployment runs.
  ws.createWorkspace(dir, 'abcd1234');
  assert.equal(statSync(ws.workspacesRoot(dir)).mode & 0o777, 0o700);
});

test('the host path is the daemon-side path, joined POSIX-style', () => {
  // Bind sources are resolved by the daemon, so this is the path it knows the
  // data volume by — on Linux the host's, under Docker Desktop the VM's.
  assert.equal(
    ws.hostWorkspacePath('/var/lib/docker/volumes/boxes-data/_data', 'abcd1234'),
    '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234',
  );
});

test('removing a workspace takes its content and no more', () => {
  const path = ws.createWorkspace(dir, 'abcd1234');
  writeFileSync(join(path, 'file.txt'), 'work');
  const keep = join(outside, 'secret.txt');
  writeFileSync(keep, 'not the agent business');
  // The tree is agent-controlled, so a link planted in it must not be
  // followed by the removal.
  symlinkSync(outside, join(path, 'escape'));

  ws.removeWorkspace(dir, 'abcd1234');

  assert.ok(!existsSync(path));
  assert.ok(existsSync(keep));
  // And the parent survives to hold the next session's workspace.
  assert.ok(existsSync(ws.workspacesRoot(dir)));
});

test('removing a workspace that is not there is not an error', () => {
  ws.ensureWorkspacesRoot(dir);
  ws.removeWorkspace(dir, 'nosuch');
});

test('one workspace is not the same directory as another', () => {
  assert.notEqual(ws.workspacePath(dir, 'aaa'), ws.workspacePath(dir, 'bbb'));
});
