import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fileLines, MAX_FILE_BYTES } from './fs.ts';

test('the cap is a real number', () => {
  assert.equal(MAX_FILE_BYTES, 2 * 1024 * 1024);
});

test('fileLines drops terminators and the trailing empty line', () => {
  assert.deepEqual(fileLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(fileLines('a\nb'), ['a', 'b']);
  assert.deepEqual(fileLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(fileLines(''), []);
  assert.deepEqual(fileLines('\n'), ['']);
});
