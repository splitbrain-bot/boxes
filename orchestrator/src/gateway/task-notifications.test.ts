import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isTerminalStatus,
  parseTaskNotifications,
} from '../../../shared/task-notifications.ts';

/**
 * The block the harness wakes the agent with when a background task reports
 * in, read back out of the transcript — shared/task-notifications.ts, tested
 * from the side that acts on it.
 *
 * The fixtures are the shapes the harness actually sends: a monitor's event,
 * a background command that finished, and a subagent's answer with what it
 * cost. What these cover is that each is read, that a terminal one is known
 * to be terminal, and that anything else is left as the text it is.
 */

const MONITOR = [
  '<task-notification>',
  '<task-id>bnztwmmw5</task-id>',
  '<summary>Monitor event: "Atlas Obscura crawl progress"</summary>',
  '<event>progress: 2200/30321 ok=2193 bad=7 0.9/s eta 528m',
  'rate limited - pausing 61s, delay now 5000ms</event>',
  '</task-notification>',
].join('\n');

const COMMAND = [
  '<task-notification>',
  '<task-id>bm74el4o7</task-id>',
  '<tool-use-id>toolu_01EKK7RLryD2H8fFoDDB6dmJ</tool-use-id>',
  '<output-file>/tmp/claude/tasks/bm74el4o7.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "Run the full suite" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

const AGENT = [
  '<task-notification>',
  '<task-id>agent-a1b</task-id>',
  '<status>completed</status>',
  '<summary>Agent "Investigate auth bug" finished</summary>',
  '<result>Found a null pointer in src/auth/validate.ts:42.</result>',
  '<usage>',
  '  <subagent_tokens>48200</subagent_tokens>',
  '  <tool_uses>1</tool_uses>',
  '  <duration_ms>184000</duration_ms>',
  '</usage>',
  '</task-notification>',
].join('\n');

/** The one notification in a block, which every fixture here holds. */
function only(text: string) {
  const segments = parseTaskNotifications(text);
  assert.equal(segments?.length, 1);
  assert.equal(segments![0]!.type, 'notification');
  return segments![0]!.type === 'notification' ? segments![0]!.notification : null;
}

test("a monitor's event becomes a row carrying what it saw", () => {
  assert.deepEqual(only(MONITOR), {
    taskId: 'bnztwmmw5',
    summary: 'Monitor event: "Atlas Obscura crawl progress"',
    body: [
      'progress: 2200/30321 ok=2193 bad=7 0.9/s eta 528m',
      'rate limited - pausing 61s, delay now 5000ms',
    ].join('\n'),
  });
});

test('a finished command carries its status, and the call that started it', () => {
  assert.deepEqual(only(COMMAND), {
    taskId: 'bm74el4o7',
    // ACP's toolCallId, which is what correlates the report with the call.
    toolUseId: 'toolu_01EKK7RLryD2H8fFoDDB6dmJ',
    status: 'completed',
    summary: 'Background command "Run the full suite" completed (exit code 0)',
  });
});

test('a status says whether the task will report again', () => {
  assert.equal(isTerminalStatus(only(COMMAND)?.status), true);
  assert.equal(isTerminalStatus('failed'), true);
  assert.equal(isTerminalStatus('killed'), true);
  // A monitor's event has no status at all, and a status this build has not
  // heard of is not proof that anything ended.
  assert.equal(isTerminalStatus(only(MONITOR)?.status), false);
  assert.equal(isTerminalStatus('blocked'), false);
  assert.equal(isTerminalStatus('something-newer'), false);
});

test("a subagent's answer and what it cost are both read", () => {
  assert.deepEqual(only(AGENT), {
    taskId: 'agent-a1b',
    status: 'completed',
    summary: 'Agent "Investigate auth bug" finished',
    body: 'Found a null pointer in src/auth/validate.ts:42.',
    usage: { tokens: 48200, toolUses: 1, durationMs: 184000 },
  });
});

test('text around a notification is kept, in the order it was said', () => {
  const segments = parseTaskNotifications(`before\n${MONITOR}\nafter`);
  assert.deepEqual(segments, [
    { type: 'text', text: 'before' },
    { type: 'notification', notification: only(MONITOR) },
    { type: 'text', text: 'after' },
  ]);
});

test('several notifications in one message stay several rows', () => {
  const segments = parseTaskNotifications(`${MONITOR}\n${COMMAND}`);
  assert.deepEqual(
    segments?.map((s) => s.type),
    ['notification', 'notification'],
  );
});

test('a message the user typed is not a notification', () => {
  assert.equal(parseTaskNotifications('how is the crawl going?'), null);
  // Somebody asking about the format, rather than the harness using it.
  assert.equal(parseTaskNotifications('what is a <task-notification> anyway?'), null);
});

test('a block this build cannot read is left as the text it is', () => {
  const noSummary = MONITOR.replace(/<summary>.*<\/summary>\n/, '');
  assert.equal(parseTaskNotifications(noSummary), null);
});

