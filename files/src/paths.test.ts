import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { validRelativePath } from '../../shared/files.ts';
import { resolveInRoot } from './paths.ts';

let root: string;
let outside: string;
let secret: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boxes-files-root-'));
  outside = mkdtempSync(join(tmpdir(), 'boxes-files-outside-'));
  secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'a file outside the workspace');
});

afterEach(() => {
  for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
});

describe('validRelativePath', () => {
  test('accepts an ordinary relative path', () => {
    for (const path of ['a.txt', 'src/app.ts', 'a/b/c/d.txt', '.gitignore', 'a b/c d.txt']) {
      assert.equal(validRelativePath(path), true, path);
    }
  });

  test('accepts a filename that merely contains dots', () => {
    for (const path of ['[...slug].astro', 'a..b.txt', 'src/..hidden', 'x/....y']) {
      assert.equal(validRelativePath(path), true, path);
    }
  });

  test('refuses a traversal, however it is spelled', () => {
    for (const path of [
      '../etc/passwd',
      'a/../../b',
      'a/..',
      '..',
      'a/../b',
      'a\\..\\b',
      '..\\b',
    ]) {
      assert.equal(validRelativePath(path), false, path);
    }
  });

  test('refuses an absolute path, a drive letter and a NUL', () => {
    for (const path of ['/etc/passwd', '\\etc', 'C:/Windows', 'a\0b', '', 'x'.repeat(5000)]) {
      assert.equal(validRelativePath(path), false, JSON.stringify(path));
    }
  });

  test('refuses an empty segment, which would collapse a path', () => {
    assert.equal(validRelativePath('a//b'), false);
    assert.equal(validRelativePath('a/'), false);
  });
});

describe('resolveInRoot', () => {
  test('resolves a file inside the root', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    const result = resolveInRoot(root, 'a.txt');
    assert.ok(result.ok);
    assert.equal(readFileSync(result.path, 'utf8'), 'x');
  });

  test('refuses a symlink pointing out of the root', () => {
    symlinkSync(secret, join(root, 'secret.txt'));
    const result = resolveInRoot(root, 'secret.txt');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'symlink');
  });

  test('refuses a symlink even when it stays inside the root', () => {
    // Its target can change after the tree was listed.
    writeFileSync(join(root, 'real.txt'), 'x');
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    const result = resolveInRoot(root, 'link.txt');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'symlink');
  });

  test('refuses a file reached through a linked directory', () => {
    symlinkSync(outside, join(root, 'escape'));
    const result = resolveInRoot(root, 'escape/secret.txt');
    assert.equal(result.ok, false);
    // The final component is a real file, so the realpath check refuses it.
    assert.equal(result.ok === false && result.reason, 'outside');
  });

  test('refuses a traversal before touching the filesystem', () => {
    const result = resolveInRoot(root, '../secret.txt');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'invalid');
  });

  test('a missing file is missing, not outside', () => {
    const result = resolveInRoot(root, 'nosuch.txt');
    assert.equal(result.ok === false && result.reason, 'missing');
  });

  test('a file that need not exist yet resolves, if its parent is inside', () => {
    // This is the REVIEW.md case: the first write creates the file.
    const result = resolveInRoot(root, 'REVIEW.md', false);
    assert.ok(result.ok);
    assert.equal(result.path, join(root, 'REVIEW.md'));
  });

  test('a file that need not exist yet is still refused behind a link', () => {
    symlinkSync(outside, join(root, 'escape'));
    const result = resolveInRoot(root, 'escape/REVIEW.md', false);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'outside');
    assert.equal(existsSync(join(outside, 'REVIEW.md')), false);
  });

  test('the empty path is the root itself', () => {
    const result = resolveInRoot(root, '');
    assert.ok(result.ok);
  });

  test('a root that is not there refuses everything', () => {
    const gone = join(root, 'nosuch-root');
    assert.equal(resolveInRoot(gone, 'a.txt').ok, false);
  });

  test('the root itself resolves through its own realpath', () => {
    // macOS puts temp directories behind /private, so a root given by a path
    // that is itself a link must not make everything under it "outside".
    const linked = join(outside, 'root-link');
    symlinkSync(root, linked);
    writeFileSync(join(root, 'a.txt'), 'x');
    const result = resolveInRoot(linked, 'a.txt');
    assert.ok(result.ok);
  });
});
