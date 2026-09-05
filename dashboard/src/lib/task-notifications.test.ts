import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatUsage } from './task-notifications.ts';

/** What a task cost, as the row shows it. */

test('what a task cost reads as a line, and says only what it knows', () => {
  assert.equal(
    formatUsage({ tokens: 48200, toolUses: 1, durationMs: 184000 }),
    '48.2k tokens · 1 tool call · 3m 4s',
  );
  assert.equal(formatUsage({ toolUses: 12 }), '12 tool calls');
  assert.equal(formatUsage({ durationMs: 4200 }), '4s');
  assert.equal(formatUsage({ tokens: 2_400_000, durationMs: 7_500_000 }), '2.4M tokens · 2h 5m');
});
