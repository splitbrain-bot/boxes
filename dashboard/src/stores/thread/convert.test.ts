import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import type { ThreadUpdate } from './acp-types.ts';
import { convertMessage } from './convert.ts';
import { applyUpdate, emptyModel, resetIds } from './translate.ts';

beforeEach(() => resetIds());

/**
 * A text chunk of the agent.
 *
 * @param text The text.
 * @returns The update.
 */
function said(text: string): ThreadUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as ThreadUpdate;
}

test('the card of a sub agent carries the run as the messages of a nested thread', () => {
  const model = emptyModel();
  applyUpdate(model, said('Let me look.'));
  applyUpdate(model, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'child-1',
    name: 'Find the words',
    task: 'Read words.txt',
  } as ThreadUpdate);
  applyUpdate(model, said('Reading.'), 'child-1');
  applyUpdate(
    model,
    { sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Read' } as ThreadUpdate,
    'child-1',
  );

  const card = convertMessage(model.messages[0]!).content[1] as {
    toolName: string;
    args: unknown;
    result?: unknown;
    messages?: { id: string; status?: { type: string }; content: { type: string }[] }[];
  };
  assert.equal(card.toolName, 'boxes_subagent');
  assert.deepEqual(card.args, { name: 'Find the words', task: 'Read words.txt' });
  // No result while the sub agent runs, which is how the card knows.
  assert.equal(card.result, undefined);
  assert.deepEqual(
    card.messages?.map((m) => m.content.map((p) => p.type)),
    [['text', 'tool-call']],
  );
  // The last message of a running sub agent runs, so the nested thread shows it as such.
  assert.equal(card.messages?.[0]?.status?.type, 'running');

  applyUpdate(model, {
    sessionUpdate: 'subagent_state_update',
    subagentSessionId: 'child-1',
    state: 'completed',
  } as ThreadUpdate);
  const done = convertMessage(model.messages[0]!).content[1] as typeof card;
  assert.equal(done.result, '');
  assert.equal(done.messages?.[0]?.status?.type, 'complete');
});
