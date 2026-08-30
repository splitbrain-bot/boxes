import assert from 'node:assert/strict';
import { test } from 'vitest';
import { bangCommand } from './exec.ts';

/** Which composer lines are local commands, and what they run. */

test('a bang line is a local command', () => {
  assert.equal(bangCommand('!echo hi'), 'echo hi');
  assert.equal(bangCommand('!  git status  '), 'git status');
});

test('an ordinary line is not', () => {
  assert.equal(bangCommand('echo hi'), null);
  assert.equal(bangCommand('what does ! mean?'), null);
  assert.equal(bangCommand(''), null);
});

test('a bare bang runs nothing', () => {
  assert.equal(bangCommand('!'), null);
  assert.equal(bangCommand('!   '), null);
});
