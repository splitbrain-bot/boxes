import assert from 'node:assert/strict';
import { test } from 'vitest';
import { tokenizeLines } from './highlight.ts';

test('an alias from a code fence selects the grammar of its language', async () => {
  const lines = await tokenizeLines('const a = 1;\nlet b = 2;', 'TS');
  assert.ok(lines);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.map((token) => token.content).join(''), 'const a = 1;');
  assert.ok(lines[0]?.some((token) => token.style['--shiki-light'] && token.style['--shiki-dark']));
});

test('a language without a grammar stays plain', async () => {
  assert.equal(await tokenizeLines('anything', 'klingon'), null);
  assert.equal(await tokenizeLines('anything', ''), null);
});
