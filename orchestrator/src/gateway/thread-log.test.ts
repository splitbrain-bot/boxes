import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ThreadLog } from './thread-log.ts';

/**
 * The log one thread keeps of what its watchers were sent: what a browser
 * opening the thread gets, and what goes when it grows past its cap.
 */

const T1 = 'acp-1';

/** A chunk of a named message. */
function chunk(messageId: string, text: string, thread = T1): unknown {
  return {
    sessionId: thread,
    update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
  };
}

/** An update about a tool call, which names no message. */
function call(toolCallId: string, thread = T1): unknown {
  return { sessionId: thread, update: { sessionUpdate: 'tool_call', toolCallId, title: 'ls' } };
}

/** Roughly how many bytes an entry built by `chunk` takes on the wire. */
function sizeOf(params: unknown): number {
  return JSON.stringify(params).length;
}

test('a thread opens whole, or from the message the browser holds', () => {
  const log = new ThreadLog();
  log.append(chunk('m1', 'one'));
  log.append(chunk('m2', 'two'));
  log.append(chunk('m3', 'three'));

  assert.deepEqual(log.opening(), {
    resumed: false,
    updates: [chunk('m1', 'one'), chunk('m2', 'two'), chunk('m3', 'three')],
    options: { modes: null, configOptions: [] },
  });
  const tail = log.opening('m2');
  assert.equal(tail.resumed, true);
  assert.deepEqual(tail.updates, [chunk('m2', 'two'), chunk('m3', 'three')]);
});

test('a message the log does not hold means the thread whole', () => {
  const log = new ThreadLog();
  log.append(chunk('m1', 'one'));

  const whole = log.opening('m-elsewhere');
  assert.equal(whole.resumed, false);
  assert.deepEqual(whole.updates, [chunk('m1', 'one')]);
});

test('a log past its cap drops its oldest message, tool calls and all', () => {
  const first = chunk('m1', 'x'.repeat(200));
  const itsCall = call('c1');
  const second = chunk('m2', 'y'.repeat(200));
  // Room for the second message and a little more, not for both.
  const log = new ThreadLog(sizeOf(second) + sizeOf(itsCall) + 50);
  log.append(first);
  log.append(itsCall);
  log.append(second);

  // The first message went, and the call it made went with it: a call left
  // behind would be a result with no question above it.
  assert.deepEqual(log.opening().updates, [second]);
});

test('eviction stops at the next message, whatever sits in between', () => {
  const log = new ThreadLog(1);
  log.append(chunk('m1', 'first'));
  log.append(chunk('m1', 'still first'));
  log.append(call('c1'));
  log.append(chunk('m2', 'second'));

  // Over the cap by every entry, but the cut is made at m2's first chunk and
  // the log is never emptied, so the newest message survives whole.
  assert.deepEqual(log.opening().updates, [chunk('m2', 'second')]);
});

test('the answer follows the adapter as it changes its mind', () => {
  const log = new ThreadLog();
  log.options = {
    modes: { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'plan' }] },
    configOptions: [{ id: 'model', category: 'model', currentValue: 'sonnet' }],
  };

  log.append({
    sessionId: T1,
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
  });
  log.append({
    sessionId: T1,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'model', category: 'model', currentValue: 'opus' }],
    },
  });

  assert.equal(log.options.modes?.currentModeId, 'plan');
  assert.deepEqual(log.options.modes?.availableModes, [{ id: 'auto' }, { id: 'plan' }]);
  assert.deepEqual(log.options.configOptions, [
    { id: 'model', category: 'model', currentValue: 'opus' },
  ]);
});

test('a mode change on a thread with no modes is left alone', () => {
  const log = new ThreadLog();
  log.append({
    sessionId: T1,
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
  });
  assert.equal(log.options.modes, null);
});

test('a copy says every update is about the thread that copied it', () => {
  const source = new ThreadLog();
  source.append(chunk('m1', 'from the source', T1));
  source.append(call('c1', T1));

  const fork = new ThreadLog();
  fork.copyFrom(source, 'acp-fork');
  assert.deepEqual(fork.opening().updates, [
    chunk('m1', 'from the source', 'acp-fork'),
    call('c1', 'acp-fork'),
  ]);
  // The source is untouched, and still about itself.
  assert.deepEqual(source.opening().updates, [chunk('m1', 'from the source', T1), call('c1', T1)]);
});
