import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { FileError, readFile, writeFile } from './ops.ts';

let root: string;
let outside: string;
let secret: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boxes-files-ops-'));
  outside = mkdtempSync(join(tmpdir(), 'boxes-files-ops-outside-'));
  secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'a file outside the workspace');
});

afterEach(() => {
  for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
});

/** A body stream of some text. */
function body(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

describe('readFile', () => {
  test('reads a text file whole', () => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    const read = readFile(root, 'a.txt', 100);
    assert.equal(read.content.toString(), 'one\ntwo\n');
    assert.equal(read.truncated, false);
    assert.equal(read.binary, false);
    assert.equal(read.size, 8);
  });

  test('an empty file is empty, not binary', () => {
    writeFileSync(join(root, 'empty.txt'), '');
    const read = readFile(root, 'empty.txt', 100);
    assert.equal(read.content.length, 0);
    assert.equal(read.truncated, false);
    assert.equal(read.binary, false);
  });

  test('a hash follows the content', () => {
    writeFileSync(join(root, 'a.txt'), 'one');
    const first = readFile(root, 'a.txt', 100).hash;
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.equal(readFile(root, 'a.txt', 100).hash, first);
    writeFileSync(join(root, 'a.txt'), 'two');
    assert.notEqual(readFile(root, 'a.txt', 100).hash, first);
  });
});

describe('writeFile', () => {
  test('a link planted at the temp name is not written through', async () => {
    const path = join(root, 'REVIEW.md');
    // The agent owns the directory and the temp name is predictable. The
    // counter in the name is private, so every name the write could pick is
    // planted.
    for (let n = 0; n < 64; n++) symlinkSync(secret, `${path}.${process.pid}.${n}.tmp`);

    await writeFile(root, 'REVIEW.md', body('# Code Review\n'), { absent: true });

    assert.equal(readFileSync(secret, 'utf8'), 'a file outside the workspace');
    assert.equal(readFileSync(path, 'utf8'), '# Code Review\n');
    assert.equal(lstatSync(path).isSymbolicLink(), false);
  });

  test('an overwrite replaces the whole file', async () => {
    writeFileSync(join(root, 'a.txt'), 'first, and longer\n');
    const hash = readFile(root, 'a.txt', 100).hash;
    await writeFile(root, 'a.txt', body('second\n'), { hash });
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'second\n');
  });

  test('a failed write leaves the previous version and no temp file', async () => {
    const dir = join(root, 'sub');
    mkdirSync(dir);
    writeFileSync(join(dir, 'REVIEW.md'), 'the previous version\n');
    const hash = readFile(root, 'sub/REVIEW.md', 100).hash;
    // Read-only directory, so the temp write fails.
    chmodSync(dir, 0o555);
    try {
      await assert.rejects(writeFile(root, 'sub/REVIEW.md', body('fails\n'), { hash }), FileError);
      assert.equal(readFileSync(join(dir, 'REVIEW.md'), 'utf8'), 'the previous version\n');
      assert.deepEqual(readdirSync(dir), ['REVIEW.md']);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test('a new file behind a linked directory is refused', async () => {
    symlinkSync(outside, join(root, 'escape'));
    await assert.rejects(writeFile(root, 'escape/x.txt', body('x'), { absent: true }), FileError);
    assert.deepEqual(readdirSync(outside), ['secret.txt']);
  });
});
