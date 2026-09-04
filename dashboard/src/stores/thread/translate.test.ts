import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import type { SessionUpdate } from './acp-types.ts';
import {
  applyUpdate,
  emptyModel,
  findTool,
  resetIds,
  toolOutputText,
  type ThreadModel,
  type ToolPart,
} from './translate.ts';

/** Folds a script of updates into a fresh model, the way a replay arrives. */
function fold(...updates: SessionUpdate[]): ThreadModel {
  const model = emptyModel();
  for (const u of updates) applyUpdate(model, u);
  return model;
}

/** A text chunk of the given kind. */
function chunk(
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
  messageId?: string,
): SessionUpdate {
  return {
    sessionUpdate,
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {}),
  } as SessionUpdate;
}

beforeEach(() => resetIds());

test('streamed chunks of one message become one growing text part', () => {
  const model = fold(
    chunk('agent_message_chunk', 'Hel'),
    chunk('agent_message_chunk', 'lo, '),
    chunk('agent_message_chunk', 'world'),
  );
  assert.equal(model.messages.length, 1);
  assert.deepEqual(model.messages[0]!.parts, [{ type: 'text', text: 'Hello, world' }]);
});

test('a role change starts a new message', () => {
  const model = fold(
    chunk('user_message_chunk', 'hi'),
    chunk('agent_message_chunk', 'hello'),
    chunk('user_message_chunk', 'again'),
  );
  assert.deepEqual(
    model.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
});

test('a change of messageId starts a new message even in the same role', () => {
  const model = fold(
    chunk('agent_message_chunk', 'first', 'msg-a'),
    chunk('agent_message_chunk', ' more', 'msg-a'),
    chunk('agent_message_chunk', 'second', 'msg-b'),
  );
  assert.equal(model.messages.length, 2);
  assert.equal(model.messages[0]!.id, 'msg-a');
  assert.deepEqual(model.messages[0]!.parts, [{ type: 'text', text: 'first more' }]);
  assert.deepEqual(model.messages[1]!.parts, [{ type: 'text', text: 'second' }]);
});

test('thought chunks become a reasoning part beside the prose', () => {
  const model = fold(
    chunk('agent_thought_chunk', 'let me look'),
    chunk('agent_message_chunk', 'Here it is.'),
  );
  assert.equal(model.messages.length, 1);
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'reasoning', text: 'let me look' },
    { type: 'text', text: 'Here it is.' },
  ]);
});

test('a tool call becomes a part, and its update merges into it', () => {
  const model = fold(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read cidr.ts',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'proxy/src/cidr.ts' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'export function' } }],
    },
  );
  const part = findTool(model, 't1')!;
  assert.equal(part.status, 'completed');
  assert.equal(part.title, 'Read cidr.ts');
  assert.equal(part.kind, 'read');
  assert.deepEqual(part.rawInput, { path: 'proxy/src/cidr.ts' });
  assert.equal(toolOutputText(part), 'export function');
  // One card, not two.
  assert.equal(model.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').length, 1);
});

test('an update that arrives before its tool call still lands', () => {
  const model = fold(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
    },
    { sessionUpdate: 'tool_call', toolCallId: 't9', title: 'Search', status: 'in_progress' },
  );
  const part = findTool(model, 't9')!;
  assert.equal(part.title, 'Search');
  assert.equal(toolOutputText(part), 'partial');
  assert.equal(model.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').length, 1);
});

test('streamed tool content replaces rather than accumulates', () => {
  const model = fold(
    { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Run tests' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      content: [{ type: 'content', content: { type: 'text', text: 'ok 1' } }],
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      content: [{ type: 'content', content: { type: 'text', text: 'ok 1\nok 2' } }],
    },
  );
  assert.equal(toolOutputText(findTool(model, 't2')!), 'ok 1\nok 2');
});

test('an omitted field leaves the previous value alone', () => {
  const model = fold(
    { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Edit main.ts', kind: 'edit' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'completed' },
  );
  const part = findTool(model, 't3')!;
  assert.equal(part.title, 'Edit main.ts');
  assert.equal(part.kind, 'edit');
});

test('a diff renders as a unified block naming its file', () => {
  const model = fold({
    sessionUpdate: 'tool_call',
    toolCallId: 't4',
    title: 'Edit',
    content: [{ type: 'diff', path: 'a.ts', oldText: 'let x = 1;', newText: 'const x = 1;' }],
  });
  assert.equal(
    toolOutputText(findTool(model, 't4')!),
    ['--- a.ts', '-let x = 1;', '+const x = 1;'].join('\n'),
  );
});

test('a plan replaces the previous one', () => {
  const model = fold(
    { sessionUpdate: 'plan', entries: [{ content: 'read the code' }] },
    { sessionUpdate: 'plan', entries: [{ content: 'read the code' }, { content: 'fix it' }] },
  );
  assert.equal(model.plan?.length, 2);
});

test('a mode update moves the current mode without inventing a mode list', () => {
  const model = emptyModel();
  applyUpdate(model, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  assert.equal(model.modes, null);

  model.modes = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'auto', name: 'Auto' },
    ],
  };
  applyUpdate(model, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  assert.equal(model.modes.currentModeId, 'auto');
  assert.equal(model.modes.availableModes.length, 2);
});

test('a command list replaces the previous one', () => {
  const model = fold(
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'review' }, { name: 'release' }],
    },
    { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] },
  );
  assert.deepEqual(model.commands, [{ name: 'compact' }]);
  assert.deepEqual(model.messages, []);
});

test('an unknown update kind is kept and renders nothing', () => {
  const model = fold({ sessionUpdate: 'usage_update', tokens: 12 } as unknown as SessionUpdate);
  assert.equal(model.messages.length, 0);
  assert.equal(model.unknown.length, 1);
});

test('replaying the same script twice from a fresh model gives the same thread', () => {
  const script: SessionUpdate[] = [
    chunk('user_message_chunk', 'run the tests'),
    { sessionUpdate: 'tool_call', toolCallId: 't5', title: 'Run tests', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't5', status: 'completed' },
    chunk('agent_message_chunk', 'All green.'),
  ];
  const strip = (m: ThreadModel): unknown =>
    m.messages.map((msg) => ({
      role: msg.role,
      parts: msg.parts.map((p) => (p.type === 'tool' ? { tool: (p as ToolPart).title } : p)),
    }));
  assert.deepEqual(strip(fold(...script)), strip(fold(...script)));
});

/** An image chunk of the given kind, carrying a base64 payload. */
function imageChunk(
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk',
  data: string,
  mimeType = 'image/png',
): SessionUpdate {
  return { sessionUpdate, content: { type: 'image', data, mimeType } } as SessionUpdate;
}

test('an image chunk becomes its own part, between the prose either side', () => {
  const model = fold(
    chunk('agent_message_chunk', 'Here it is:'),
    imageChunk('agent_message_chunk', 'AAAA'),
    chunk('agent_message_chunk', 'and that is the page.'),
  );
  assert.equal(model.messages.length, 1);
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'text', text: 'Here it is:' },
    { type: 'image', src: 'data:image/png;base64,AAAA' },
    { type: 'text', text: 'and that is the page.' },
  ]);
});

test('an image a user sent survives the replay of their prompt', () => {
  const model = fold(imageChunk('user_message_chunk', 'BBBB', 'image/jpeg'));
  assert.equal(model.messages[0]!.role, 'user');
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'image', src: 'data:image/jpeg;base64,BBBB' },
  ]);
});

test('an image block with no payload the browser can load is said in words', () => {
  const model = fold(
    {
      sessionUpdate: 'agent_message_chunk',
      // What the adapter sends for a remote image: no payload, and a URL
      // assistant-ui would refuse as a src.
      content: { type: 'image', data: '', mimeType: '', uri: 'http://example.test/a.png' },
    } as SessionUpdate,
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: '', mimeType: '' },
    } as SessionUpdate,
  );
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'text', text: '[image: http://example.test/a.png][image]' },
  ]);
});

test('an https image block is passed through as its own src', () => {
  const model = fold({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', uri: 'https://example.test/a.png' },
  } as SessionUpdate);
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'image', src: 'https://example.test/a.png' },
  ]);
});

test("a tool call's image result is named in its output rather than left empty", () => {
  const model = fold({
    sessionUpdate: 'tool_call',
    toolCallId: 't10',
    title: 'Read screenshot.png',
    kind: 'read',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'image', data: 'CCCC', mimeType: 'image/png' } }],
  });
  assert.equal(toolOutputText(findTool(model, 't10')!), '[image]');
});
