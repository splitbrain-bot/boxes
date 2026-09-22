import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  REPLAY_METHOD,
  TURN_STATE_METHOD,
  type ReplayParams,
  type TurnStateParams,
} from '../../../shared/types.ts';
import { Broadcast } from './broadcast.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * Update routing, with two browsers attached — which is the case every rule
 * in the class exists for, whether the two watch one thread or two.
 */

/** The thread most of these tests are about. */
const T1 = 'acp-1';
/** A second thread of the same box, watched by nobody unless said. */
const T2 = 'acp-2';

/** A browser that records what it was sent, watching one thread. */
function fakeDownstream(
  id: number,
  acpThreadId: string | null = T1,
  lastActiveAt = 0,
): DownstreamHandle & {
  sent: unknown[];
  turns: boolean[];
  states: TurnStateParams[];
  replays: ReplayParams[];
} {
  const sent: unknown[] = [];
  /** Every thread state this browser was told, in order. */
  const states: TurnStateParams[] = [];
  /** The prompt-open half of each, which most of these tests are about. */
  const turns: boolean[] = [];
  /** How each replay this browser read was said to have turned out. */
  const replays: ReplayParams[] = [];
  return {
    id,
    acpThreadId,
    lastActiveAt,
    sent,
    turns,
    states,
    replays,
    notify: (method, params) => {
      if (method === TURN_STATE_METHOD) {
        states.push(params as TurnStateParams);
        turns.push((params as TurnStateParams).active);
        return;
      }
      if (method === REPLAY_METHOD) {
        replays.push(params as ReplayParams);
        return;
      }
      sent.push(params);
    },
    request: () => Promise.resolve({}),
    close: () => {},
  };
}

/** A session/update notification, as the adapter sends it. */
function update(sessionUpdate: string, text: string, thread = T1): unknown {
  return { sessionId: thread, update: { sessionUpdate, content: { type: 'text', text } } };
}

/** A session/update the adapter named a message on, which is what a resume points at. */
function named(sessionUpdate: string, text: string, messageId: string, thread = T1): unknown {
  return {
    sessionId: thread,
    update: { sessionUpdate, messageId, content: { type: 'text', text } },
  };
}

/** A session/update about a tool call, which the adapter names by call id. */
function call(sessionUpdate: string, title: string, toolCallId: string, thread = T1): unknown {
  return { sessionId: thread, update: { sessionUpdate, toolCallId, title } };
}

/** The text of each chunk of one kind a browser received. */
function chunks(d: { sent: unknown[] }, kind: string): string[] {
  return d.sent
    .filter((p) => (p as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === kind)
    .map((p) => (p as { update: { content: { text: string } } }).update.content.text);
}

/** The text of each user_message_chunk a browser received. */
function userChunks(d: { sent: unknown[] }): string[] {
  return chunks(d, 'user_message_chunk');
}

/** A prompt as the gateway forwards it, which is what opens a turn. */
const PROMPT = { sessionId: T1, prompt: [{ type: 'text', text: 'run the tests' }] };

test('an ordinary update reaches every browser watching its thread', () => {
  const b = new Broadcast('s1');
  const [a, c] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(a);
  b.add(c);

  b.update(update('agent_message_chunk', 'hello'));
  assert.equal(a.sent.length, 1);
  assert.equal(c.sent.length, 1);
});

test('an update for one thread does not reach a browser watching another', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  const exploring = fakeDownstream(2, T2);
  b.add(working);
  b.add(exploring);

  b.update(update('agent_message_chunk', 'from the long turn', T1));
  b.update(update('agent_message_chunk', 'from the fork', T2));

  // Two tabs, two conversations, one box: neither shows the other's stream.
  assert.equal(working.sent.length, 1);
  assert.equal(exploring.sent.length, 1);
  assert.deepEqual(working.sent, [update('agent_message_chunk', 'from the long turn', T1)]);
  assert.deepEqual(exploring.sent, [update('agent_message_chunk', 'from the fork', T2)]);
});

test('an update for a thread nobody watches is dropped', () => {
  const b = new Broadcast('s1');
  const watching = fakeDownstream(1, T1);
  b.add(watching);

  // A thread running in the background with its tab closed. Broadcasting this
  // is what would put one conversation into another's transcript.
  b.update(update('agent_message_chunk', 'nobody asked for this', T2));
  assert.equal(watching.sent.length, 0);
});

test('an update naming no thread at all is dropped rather than broadcast', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.update({ update: { sessionUpdate: 'agent_message_chunk' } });
  assert.equal(a.sent.length, 0);
});

test('a browser whose thread is still resolving receives nothing', () => {
  const b = new Broadcast('s1');
  const resolving = fakeDownstream(1, null);
  b.add(resolving);

  // Counted as attached — it holds a socket open — but it has not been told
  // which thread it is on, so nothing is its.
  assert.equal(b.size, 1);
  b.update(update('agent_message_chunk', 'hello'));
  assert.equal(resolving.sent.length, 0);
});

test('a forwarded prompt is echoed to every browser on its thread, the sender included', () => {
  const b = new Broadcast('s1');
  const [phone, desktop] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(phone);
  b.add(desktop);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'run the tests' }] });

  // The adapter only has to replay a prompt, not echo it live, so without
  // this neither device would show what was just asked.
  assert.deepEqual(userChunks(phone), ['run the tests']);
  assert.deepEqual(userChunks(desktop), ['run the tests']);
});

test('a prompt echo reaches only the browsers watching its own thread', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  const exploring = fakeDownstream(2, T2);
  b.add(working);
  b.add(exploring);

  b.beginPrompt({ sessionId: T2, prompt: [{ type: 'text', text: 'what are you doing?' }] });

  assert.deepEqual(userChunks(exploring), ['what are you doing?']);
  assert.deepEqual(userChunks(working), []);
});

test('an adapter that echoes the prompt back does not produce a second copy', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'hello' }] });
  b.update(update('user_message_chunk', 'hello'));
  assert.deepEqual(userChunks(a), ['hello']);

  b.endPrompt({ sessionId: T1 });
  // Once the prompt is done the adapter is the authority again.
  b.update(update('user_message_chunk', 'from somewhere else'));
  assert.deepEqual(userChunks(a), ['hello', 'from somewhere else']);
});

test('echo suppression on one thread does not silence another thread user messages', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  const exploring = fakeDownstream(2, T2);
  b.add(working);
  b.add(exploring);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'mine' }] });
  // The other thread's own user message, which this gateway never echoed.
  b.update(update('user_message_chunk', 'theirs', T2));

  assert.deepEqual(userChunks(exploring), ['theirs']);
});

test('a multi-block prompt is echoed block by block', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);
  b.beginPrompt({
    sessionId: T1,
    prompt: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  });
  assert.deepEqual(userChunks(a), ['first', 'second']);
});

/** What the adapter answered for a thread, as a test hands it to the log. */
const OPTIONS = {
  modes: { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'plan' }] },
  configOptions: [],
};

test('a browser opening a thread is sent its log, and told the thread is whole', () => {
  const b = new Broadcast('s1');
  const watching = fakeDownstream(1);
  b.add(watching);
  b.openLog(T1, OPTIONS);

  b.update(named('user_message_chunk', 'the question', 'm1'));
  b.update(named('agent_message_chunk', 'the answer', 'm2'));

  // A second tab arrives on the thread. It is sent what the first was, in the
  // order the first was sent it, and the adapter is not asked for anything.
  const late = fakeDownstream(2);
  b.add(late);
  const answer = b.open(late, T1);

  assert.deepEqual(late.replays, [{ sessionId: T1, resumed: false }]);
  assert.deepEqual(late.sent, [
    named('user_message_chunk', 'the question', 'm1'),
    named('agent_message_chunk', 'the answer', 'm2'),
  ]);
  assert.deepEqual(answer, OPTIONS);
  // The tab that was already there is sent nothing again.
  assert.equal(watching.sent.length, 2);
});

test('a browser that says how much it has is sent only the rest', () => {
  const b = new Broadcast('s1');
  b.openLog(T1, OPTIONS);
  b.update(named('user_message_chunk', 'the first question', 'm1'));
  b.update(named('agent_message_chunk', 'the first answer', 'm2'));
  b.update(named('user_message_chunk', 'and then this', 'm3'));

  // The browser holds the thread as far as m2. m2 goes out with the tail: the
  // browser drops the message it named and takes it again, which is what
  // makes the result the whole thread's model.
  const back = fakeDownstream(1);
  b.add(back);
  b.open(back, T1, 'm2');

  assert.deepEqual(back.replays, [{ sessionId: T1, resumed: true }]);
  assert.deepEqual(back.sent, [
    named('agent_message_chunk', 'the first answer', 'm2'),
    named('user_message_chunk', 'and then this', 'm3'),
  ]);
});

test('a message the log no longer holds means the thread whole', () => {
  const b = new Broadcast('s1');
  b.openLog(T1, OPTIONS);
  b.update(named('user_message_chunk', 'the first question', 'm1'));
  b.update(named('agent_message_chunk', 'the first answer', 'm2'));

  // A tail starting anywhere else would be a thread with a hole in it.
  const back = fakeDownstream(1);
  b.add(back);
  b.open(back, T1, 'm-long-gone');

  assert.deepEqual(back.replays, [{ sessionId: T1, resumed: false }]);
  assert.equal(back.sent.length, 2);
});

test('the answer comes before the thread does', () => {
  const b = new Broadcast('s1');
  b.openLog(T1, OPTIONS);
  b.update(update('agent_message_chunk', 'history'));
  const opening = fakeDownstream(1);
  b.add(opening);
  /** Everything this browser was told, in the order it was told it. */
  const order: string[] = [];
  const inner = opening.notify;
  opening.notify = (method, params) => {
    order.push(method === REPLAY_METHOD ? 'answer' : 'update');
    inner(method, params);
  };

  b.open(opening, T1);
  // A browser rebuilding has to know before the first of it lands, or it
  // throws away what it has just been sent along with what it held.
  assert.deepEqual(order, ['answer', 'update']);
});

test('a thread with no log is sent as empty', () => {
  const b = new Broadcast('s1');
  const opening = fakeDownstream(1);
  b.add(opening);

  const answer = b.open(opening, T1);
  assert.deepEqual(opening.replays, [{ sessionId: T1, resumed: false }]);
  assert.deepEqual(opening.sent, []);
  assert.deepEqual(answer, { modes: null, configOptions: [] });
});

test('a transcript being read into the log reaches nobody', () => {
  const b = new Broadcast('s1');
  const watching = fakeDownstream(1);
  b.add(watching);

  // The adapter replaying the thread on its way up. The tab already on it
  // has the thread; sending it the replay would render it twice.
  b.beginFill(T1);
  b.update(named('user_message_chunk', 'old question', 'm1'));
  b.update(named('agent_message_chunk', 'old answer', 'm2'));
  assert.equal(watching.sent.length, 0);

  b.endFill(T1, OPTIONS);
  b.update(named('agent_message_chunk', 'something new', 'm3'));
  assert.deepEqual(watching.sent, [named('agent_message_chunk', 'something new', 'm3')]);

  // Whoever opens the thread next is sent the transcript and what came after.
  const late = fakeDownstream(2);
  b.add(late);
  b.open(late, T1);
  assert.deepEqual(late.sent, [
    named('user_message_chunk', 'old question', 'm1'),
    named('agent_message_chunk', 'old answer', 'm2'),
    named('agent_message_chunk', 'something new', 'm3'),
  ]);
});

test('a thread being read in leaves another thread live', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  b.add(working);
  b.openLog(T1, OPTIONS);

  // A second thread of the box being brought up while this one is mid-turn.
  b.beginFill(T2);
  b.update(update('agent_message_chunk', 'still working', T1));
  b.update(update('agent_message_chunk', 'replayed history', T2));

  assert.deepEqual(working.sent, [update('agent_message_chunk', 'still working', T1)]);
});

test('reading a transcript in replaces what an earlier log held', () => {
  const b = new Broadcast('s1');
  b.openLog(T1, OPTIONS);
  b.update(update('agent_message_chunk', 'from before the adapter restarted'));

  // The adapter is spawned again and says the whole thread back. What the
  // log held is in that, so keeping it would say it twice.
  b.beginFill(T1);
  b.update(update('agent_message_chunk', 'from the transcript'));
  b.endFill(T1, OPTIONS);

  const opening = fakeDownstream(1);
  b.add(opening);
  b.open(opening, T1);
  assert.deepEqual(opening.sent, [update('agent_message_chunk', 'from the transcript')]);
});

test('a prompt is logged where it was made', () => {
  const b = new Broadcast('s1');
  b.openLog(T1, OPTIONS);
  b.beginPrompt(PROMPT);
  b.update(update('agent_message_chunk', 'on it'));

  // The adapter never echoed the prompt, so the gateway's own echo is the
  // only copy a browser opening the thread later can be shown.
  const late = fakeDownstream(1);
  b.add(late);
  b.open(late, T1);
  assert.deepEqual(userChunks(late), ['run the tests']);
  assert.deepEqual(chunks(late, 'agent_message_chunk'), ['on it']);
});

test('a reconnect mid-turn is sent the rest of the turn, and nothing is asked of the adapter', () => {
  const b = new Broadcast('s1');
  const phone = fakeDownstream(1);
  b.add(phone);
  b.openLog(T1, OPTIONS);
  b.beginPrompt(PROMPT);
  b.update(named('agent_message_chunk', 'the answer so far', 'm1'));

  // The phone's socket drops. The turn goes on without it: a tool call, and a
  // new message the gateway has never seen a chunk of before.
  b.remove(phone);
  b.update(call('tool_call', 'npm test', 'c1'));
  b.update(named('agent_message_chunk', 'and the conclusion', 'm2'));

  // Back, holding the thread as far as m1. Every chunk the turn produced
  // while it was away is in the log, whatever its id.
  const back = fakeDownstream(2);
  b.add(back);
  b.open(back, T1, 'm1');
  assert.deepEqual(back.replays, [{ sessionId: T1, resumed: true }]);
  assert.deepEqual(back.sent, [
    named('agent_message_chunk', 'the answer so far', 'm1'),
    call('tool_call', 'npm test', 'c1'),
    named('agent_message_chunk', 'and the conclusion', 'm2'),
  ]);
});

test('a fork opens on the conversation it came from, under its own thread id', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  b.add(working);
  b.openLog(T1, OPTIONS);
  b.update(update('user_message_chunk', 'old question', T1));
  b.update(update('agent_message_chunk', 'old answer', T1));

  // The fork carries the source's context, and the browser reading it is
  // pinned to the fork, so what it is sent has to name the fork -- an update
  // naming the source is some other conversation's as far as it is concerned.
  b.openLog(T2, OPTIONS, T1);
  const exploring = fakeDownstream(2, T2);
  b.add(exploring);
  b.open(exploring, T2);
  assert.deepEqual(exploring.sent, [
    update('user_message_chunk', 'old question', T2),
    update('agent_message_chunk', 'old answer', T2),
  ]);

  // From here the two are two threads: what the source says next is its own.
  b.update(update('agent_message_chunk', 'live', T1));
  assert.deepEqual(working.sent.at(-1), update('agent_message_chunk', 'live', T1));
  assert.equal(exploring.sent.length, 2);
});

test('a log the adapter turned out not to hold is forgotten', () => {
  const b = new Broadcast('s1');
  b.beginFill(T1);
  b.update(update('agent_message_chunk', 'half a transcript'));
  b.dropLog(T1);

  const opening = fakeDownstream(1);
  b.add(opening);
  b.open(opening, T1);
  assert.deepEqual(opening.sent, []);
});

test('one browser failing does not stop the others being told', () => {
  const b = new Broadcast('s1');
  const broken: DownstreamHandle = {
    id: 1,
    acpThreadId: T1,
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

test('permission requests target the most recently active browser on the asking thread', () => {
  const b = new Broadcast('s1');
  const older = fakeDownstream(1, T1, 1000);
  const newer = fakeDownstream(2, T1, 2000);
  const elsewhere = fakeDownstream(3, T2, 3000);
  b.add(older);
  b.add(newer);
  b.add(elsewhere);

  // The most recent browser overall is on the other thread, and is not the
  // one being asked.
  assert.equal(b.byRecency(T1)[0], newer);
  assert.equal(b.byRecency(T2)[0], elsewhere);
  assert.deepEqual(b.byRecency('acp-nobody'), []);
});

test('the watched threads are what a respawn has to reload', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  b.add(working);
  b.add(fakeDownstream(2, T2));
  b.add(fakeDownstream(3, T2));
  b.add(fakeDownstream(4, null));

  assert.deepEqual(b.watchedThreads.sort(), [T1, T2]);

  // The set shrinks as tabs close, so it needs no storage of its own.
  b.remove(working);
  assert.deepEqual(b.watchedThreads, [T2]);
});

test('a prompt with no blocks echoes nothing but still guards the window', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'adapter said it'));
  assert.deepEqual(userChunks(a), []);

  b.endPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'now allowed'));
  assert.deepEqual(userChunks(a), ['now allowed']);
});

test('nested prompts hold the window until the last one ends', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'one' }] });
  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'two' }] });
  b.endPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'echoed by the adapter'));
  assert.deepEqual(userChunks(a), ['one', 'two']);

  b.endPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'after'));
  assert.deepEqual(userChunks(a), ['one', 'two', 'after']);
});

test('a prompt tells the browsers on its thread that a turn is running', () => {
  const b = new Broadcast('s1');
  const [a, c, other] = [fakeDownstream(1), fakeDownstream(2), fakeDownstream(3, T2)];
  b.add(a);
  b.add(c);
  b.add(other);

  const prompt = { sessionId: T1, prompt: [{ type: 'text', text: 'go' }] };
  b.beginPrompt(prompt);
  assert.deepEqual(a.turns, [true]);
  // Both browsers on the thread, including the one that did not send it.
  assert.deepEqual(c.turns, [true]);
  // And nobody on another conversation of the same box.
  assert.deepEqual(other.turns, []);

  b.endPrompt(prompt);
  assert.deepEqual(a.turns, [true, false]);
});

test('two prompts on one thread are one turn', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  const first = { sessionId: T1, prompt: [] };
  const second = { sessionId: T1, prompt: [] };
  b.beginPrompt(first);
  b.beginPrompt(second);
  assert.deepEqual(a.turns, [true]);
  assert.equal(b.isPrompting(T1), true);

  // The first to finish does not end the turn the second is still running.
  b.endPrompt(first);
  assert.deepEqual(a.turns, [true]);
  assert.equal(b.isPrompting(T1), true);

  b.endPrompt(second);
  assert.deepEqual(a.turns, [true, false]);
  assert.equal(b.isPrompting(T1), false);
});

test('a browser can be told its own thread state, and only its own', () => {
  const b = new Broadcast('s1');
  const [a, other] = [fakeDownstream(1), fakeDownstream(2, T2)];
  b.add(a);
  b.add(other);

  b.threadStateTo(a);
  assert.deepEqual(a.turns, [false]);
  assert.deepEqual(other.turns, []);

  // A connection whose thread has not been settled yet is told nothing;
  // it has not asked for anything either.
  const unpinned = fakeDownstream(3, null);
  b.add(unpinned);
  b.threadStateTo(unpinned);
  assert.deepEqual(unpinned.turns, []);
});

test('re-stating every thread reaches every watched one', () => {
  const b = new Broadcast('s1');
  const [a, other] = [fakeDownstream(1), fakeDownstream(2, T2)];
  b.add(a);
  b.add(other);

  b.refreshThreadStates();
  assert.deepEqual(a.turns, [false]);
  assert.deepEqual(other.turns, [false]);
});

test('the state a browser is told is the one the gateway supplies', () => {
  // What the gateway knows and this class does not: the agent is talking on
  // T1, and it has a build running in it.
  const b = new Broadcast('s1', (thread) => ({
    sessionId: thread,
    active: false,
    speaking: thread === T1,
    background:
      thread === T1
        ? [
            {
              id: 'task-1',
              command: 'npm run build',
              kind: 'shell',
              stoppable: true,
              startedAt: 1_700_000_000_000,
            },
          ]
        : [],
  }));
  const a = fakeDownstream(1);
  b.add(a);

  b.threadState(T1);
  assert.deepEqual(
    a.states.at(-1)?.background.map((p) => p.command),
    ['npm run build'],
  );
  assert.equal(a.states.at(-1)?.speaking, true);
});
