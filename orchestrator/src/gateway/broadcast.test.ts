import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Broadcast } from './broadcast.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * Update routing, with two browsers attached — which is the case the two
 * rules exist for.
 */

/** A browser that records what it was sent. */
function fakeDownstream(id: number, lastActiveAt = 0): DownstreamHandle & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    id,
    lastActiveAt,
    sent,
    notify: (_method, params) => sent.push(params),
    request: () => Promise.resolve({}),
    close: () => {},
  };
}

/** A session/update notification, as the adapter sends it. */
function update(sessionUpdate: string, text: string): unknown {
  return { sessionId: 'acp-1', update: { sessionUpdate, content: { type: 'text', text } } };
}

/** The text of each user_message_chunk a browser received. */
function userChunks(d: { sent: unknown[] }): string[] {
  return d.sent
    .filter(
      (p) =>
        (p as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ===
        'user_message_chunk',
    )
    .map((p) => (p as { update: { content: { text: string } } }).update.content.text);
}

test('an ordinary update reaches every attached browser', () => {
  const b = new Broadcast('s1');
  const [a, c] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(a);
  b.add(c);

  b.update(update('agent_message_chunk', 'hello'));
  assert.equal(a.sent.length, 1);
  assert.equal(c.sent.length, 1);
});

test('a forwarded prompt is echoed to every browser, the sender included', () => {
  const b = new Broadcast('s1');
  const [phone, desktop] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(phone);
  b.add(desktop);

  b.beginPrompt({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'run the tests' }] });

  // The adapter only has to replay a prompt, not echo it live, so without
  // this neither device would show what was just asked.
  assert.deepEqual(userChunks(phone), ['run the tests']);
  assert.deepEqual(userChunks(desktop), ['run the tests']);
});

test('an adapter that echoes the prompt back does not produce a second copy', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hello' }] });
  b.update(update('user_message_chunk', 'hello'));
  assert.deepEqual(userChunks(a), ['hello']);

  b.endPrompt();
  // Once the prompt is done the adapter is the authority again.
  b.update(update('user_message_chunk', 'from somewhere else'));
  assert.deepEqual(userChunks(a), ['hello', 'from somewhere else']);
});

test('a multi-block prompt is echoed block by block', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);
  b.beginPrompt({
    sessionId: 'acp-1',
    prompt: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  });
  assert.deepEqual(userChunks(a), ['first', 'second']);
});

test('a replay goes only to the browser that asked for it', () => {
  const b = new Broadcast('s1');
  const [reattaching, watching] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(reattaching);
  b.add(watching);

  b.beginReplay(reattaching);
  b.update(update('user_message_chunk', 'old question'));
  b.update(update('agent_message_chunk', 'old answer'));

  // The other tab already has this history; sending it again would render
  // the whole thread twice.
  assert.equal(reattaching.sent.length, 2);
  assert.equal(watching.sent.length, 0);

  b.endReplay(reattaching);
  b.update(update('agent_message_chunk', 'something new'));
  assert.equal(reattaching.sent.length, 3);
  assert.equal(watching.sent.length, 1);
});

test('a replayed user message is delivered even during a prompt', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  // A load running while a prompt is in flight: the echo suppression must
  // not eat the history the adapter is reading back.
  b.beginPrompt({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'now' }] });
  b.beginReplay(a);
  b.update(update('user_message_chunk', 'from the transcript'));
  assert.deepEqual(userChunks(a), ['now', 'from the transcript']);
});

test('two replays at once each get the history', () => {
  const b = new Broadcast('s1');
  const [one, two, idle] = [fakeDownstream(1), fakeDownstream(2), fakeDownstream(3)];
  b.add(one);
  b.add(two);
  b.add(idle);

  b.beginReplay(one);
  b.beginReplay(two);
  b.update(update('agent_message_chunk', 'history'));
  assert.equal(one.sent.length, 1);
  assert.equal(two.sent.length, 1);
  assert.equal(idle.sent.length, 0);

  b.endReplay(one);
  b.endReplay(two);
  b.update(update('agent_message_chunk', 'live'));
  assert.equal(idle.sent.length, 1);
});

test('a browser that leaves mid-replay does not strand the others', () => {
  const b = new Broadcast('s1');
  const [leaving, watching] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(leaving);
  b.add(watching);

  b.beginReplay(leaving);
  b.remove(leaving);

  // With the replay target gone, updates go back to everyone left.
  b.update(update('agent_message_chunk', 'still here'));
  assert.equal(watching.sent.length, 1);
});

test('one browser failing does not stop the others being told', () => {
  const b = new Broadcast('s1');
  const broken: DownstreamHandle = {
    id: 1,
    lastActiveAt: 0,
    notify: () => {
      throw new Error('socket gone');
    },
    request: () => Promise.resolve({}),
    close: () => {},
  };
  const ok = fakeDownstream(2);
  b.add(broken);
  b.add(ok);

  b.update(update('agent_message_chunk', 'hello'));
  assert.equal(ok.sent.length, 1);
});

test('permission requests target the most recently active browser', () => {
  const b = new Broadcast('s1');
  const older = fakeDownstream(1, 1000);
  const newer = fakeDownstream(2, 2000);
  b.add(older);
  b.add(newer);
  assert.equal(b.byRecency[0], newer);
});

test('a prompt with no blocks echoes nothing but still guards the window', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: 'acp-1' });
  b.update(update('user_message_chunk', 'adapter said it'));
  assert.deepEqual(userChunks(a), []);

  b.endPrompt();
  b.update(update('user_message_chunk', 'now allowed'));
  assert.deepEqual(userChunks(a), ['now allowed']);
});

test('nested prompts hold the window until the last one ends', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'one' }] });
  b.beginPrompt({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'two' }] });
  b.endPrompt();
  b.update(update('user_message_chunk', 'echoed by the adapter'));
  assert.deepEqual(userChunks(a), ['one', 'two']);

  b.endPrompt();
  b.update(update('user_message_chunk', 'after'));
  assert.deepEqual(userChunks(a), ['one', 'two', 'after']);
});
