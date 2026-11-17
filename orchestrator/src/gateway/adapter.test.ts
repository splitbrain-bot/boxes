import assert from 'node:assert/strict';
import { test } from 'vitest';
import { translateChildUpdate } from './adapter.ts';

/** The fields every child notification of opencode carries. */
const child = {
  rootSessionId: 'root',
  childSessionId: 'ses-child',
  parentSessionId: 'ses-parent',
  depth: 2,
  title: 'Read the word list',
};

test('a created child becomes a sub agent of its parent', () => {
  assert.deepEqual(translateChildUpdate({ ...child, type: 'status', status: 'created' }), {
    sessionId: 'ses-parent',
    update: {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'ses-child',
      name: 'Read the word list',
      capabilities: {},
    },
  });
  // A child without a title gets a plain name.
  const { title: _title, ...untitled } = child;
  const spawned = translateChildUpdate({ ...untitled, type: 'status', status: 'created' }) as {
    update: { name: string };
  };
  assert.equal(spawned.update.name, 'subagent');
});

test('an update of a child goes on the session of the child', () => {
  const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } };
  assert.deepEqual(translateChildUpdate({ ...child, type: 'update', update }), {
    sessionId: 'ses-child',
    update,
  });
});

test('an end state becomes the state of the sub agent, and a running state nothing', () => {
  const state = (status: string): unknown =>
    (
      translateChildUpdate({ ...child, type: 'status', status }) as {
        update?: { state?: string };
      } | null
    )?.update?.state ?? null;
  assert.equal(state('completed'), 'completed');
  assert.equal(state('failed'), 'failed');
  assert.equal(state('interrupted'), 'cancelled');
  assert.equal(state('running'), null);
});

test('a notification without the sessions is dropped', () => {
  assert.equal(translateChildUpdate({ type: 'status', status: 'created' }), null);
  assert.equal(translateChildUpdate({ ...child, type: 'update' }), null);
});
