import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import type {
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
} from '../src/stores/thread/acp-types.ts';

/**
 * A stand-in ACP gateway: a WebSocket server speaking the agent side of ACP
 * from canned scripts.
 *
 * It mirrors what the real gateway does rather than what a browser wishes it
 * did — a session owning several threads with one of them current,
 * session/new answered with the current thread's id, session/load replaying
 * that thread's stored history as notifications, and every update broadcast
 * to every attached socket.
 */

/** What the stub streams in answer to one prompt. */
export interface PromptScript {
  /** Matched against the prompt text; the first match wins. */
  match: (text: string) => boolean;
  /** Updates to stream, in order, with a pause between them. */
  updates: SessionUpdate[];
  /** Milliseconds between updates. Zero sends them in one tick. */
  gapMs?: number;
  /** Hold the prompt open until the test releases it. */
  hold?: boolean;
}

/** A permission question the stub raises instead of answering a prompt. */
export interface PermissionScript {
  match: (text: string) => boolean;
  toolCall: { toolCallId: string; title: string; kind?: string };
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** Streamed after the answer arrives, with the chosen option's id. */
  after: (optionId: string | null) => SessionUpdate[];
}

/** How the stub behaves, mutable between tests. */
export interface GatewayScript {
  token: string;
  /** Whether a prompt is echoed back as a user_message_chunk. */
  echoPrompt?: boolean;
  modes: SessionModeState | null;
  /** The options the adapter offers, such as the model. */
  configOptions: SessionConfigOption[];
  prompts: PromptScript[];
  permissions: PermissionScript[];
  /** Delivered to the next socket that attaches, then cleared. */
  queuedPermission: PermissionScript | null;
}

/** A running stub gateway. */
export interface StubGateway {
  script: GatewayScript;
  /** The current thread's updates, in order. */
  history: SessionUpdate[];
  /** One thread's updates, whichever is current. */
  historyOf: (threadId: string) => SessionUpdate[];
  /** Prompt texts the stub received, across every thread. */
  prompts: string[];
  /** How many sockets are attached right now. */
  attached: () => number;
  /** The ACP id of the thread session/new is answered with. */
  current: () => string;
  /** Mints an empty thread and makes it current; returns its ACP id. */
  newThread: () => string;
  /** Mints a thread carrying another's history and makes it current. */
  forkThread: (from: string) => string;
  /** Makes an existing thread current, dropping the attached sockets. */
  select: (threadId: string) => void;
  /** Releases a held prompt, ending the turn. */
  release: () => void;
  /** Broadcasts one update to every attached socket and records it. */
  emit: (update: SessionUpdate) => void;
  close: () => void;
}

/** A JSON-RPC frame. */
interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const THREAD_ID = 'acp-thread-1';

/** Attaches a stub gateway to an existing HTTP server at /ws/sessions/:id/acp. */
export function attachStubGateway(server: Server, script: GatewayScript): StubGateway {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  /** One transcript per thread, which is what session/load replays. */
  const threads = new Map<string, SessionUpdate[]>([[THREAD_ID, []]]);
  /** The thread session/new is answered with, and that a prompt runs on. */
  let current = THREAD_ID;
  let nextThread = 2;
  const prompts: string[] = [];
  /** Set while a prompt is held open, so the test can end the turn. */
  let releaseHeld: (() => void) | null = null;

  const historyOf = (threadId: string): SessionUpdate[] => {
    let found = threads.get(threadId);
    if (!found) {
      found = [];
      threads.set(threadId, found);
    }
    return found;
  };

  const emit = (update: SessionUpdate): void => {
    historyOf(current).push(update);
    for (const ws of sockets) send(ws, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: current, update } });
  };

  /** Closes every attached socket, as the real gateway does on a switch. */
  const dropSockets = (): void => {
    for (const ws of sockets) ws.close(1012, 'thread changed');
    sockets.clear();
  };

  /** Mints a thread, seeded with a source thread's history when forking. */
  const mint = (from: string | null): string => {
    const id = `acp-thread-${nextThread++}`;
    threads.set(id, from ? [...historyOf(from)] : []);
    current = id;
    dropSockets();
    return id;
  };

  server.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (!/^\/ws\/sessions\/[^/]+\/acp$/.test(url)) return;

    // The same handshake check the real gateway makes: acp.v1 plus the
    // bearer entry, both offered as subprotocols.
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim());
    if (!offered.includes('acp.v1') || !offered.includes(`bearer.${script.token}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => void handle(ws, String(data)));
    });
  });

  async function handle(ws: WebSocket, text: string): Promise<void> {
    let msg: Rpc;
    try {
      msg = JSON.parse(text) as Rpc;
    } catch {
      return;
    }
    if (msg.id === undefined || !msg.method) return;
    const reply = (result: unknown): void => send(ws, { jsonrpc: '2.0', id: msg.id, result });

    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: 1, agentCapabilities: {} });

      case 'session/new':
        // The session's current thread, whichever it is. A response without
        // modes is how the browser learns to load it rather than treat it as
        // brand new.
        return reply({ sessionId: current });

      case 'session/fork':
        // The fork answer carries modes and configOptions, the same as a
        // fresh thread's, and its history starts as the source's.
        return reply({
          sessionId: mint(String(params(msg)['sessionId'] ?? current)),
          modes: script.modes,
          configOptions: script.configOptions,
        });

      case 'session/load': {
        const threadId = String(params(msg)['sessionId'] ?? current);
        reply({ modes: script.modes, configOptions: script.configOptions });
        // Replay is that thread's stored history re-sent as notifications, to
        // this socket only.
        for (const update of historyOf(threadId)) {
          send(ws, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: threadId, update },
          });
        }
        if (script.queuedPermission) {
          const queued = script.queuedPermission;
          script.queuedPermission = null;
          void askPermission(ws, queued);
        }
        return undefined;
      }

      case 'session/set_mode': {
        const modeId = String(params(msg)['modeId'] ?? '');
        if (script.modes) script.modes = { ...script.modes, currentModeId: modeId };
        reply({});
        return void emit({ sessionUpdate: 'current_mode_update', currentModeId: modeId });
      }

      case 'session/set_config_option': {
        const configId = String(params(msg)['configId'] ?? '');
        const value = String(params(msg)['value'] ?? '');
        script.configOptions = script.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option,
        );
        reply({ configOptions: script.configOptions });
        return void emit({
          sessionUpdate: 'config_option_update',
          configOptions: script.configOptions,
        });
      }

      case 'session/prompt': {
        const blocks = (params(msg)['prompt'] ?? []) as Array<{ type: string; text?: string }>;
        const promptText = blocks.map((b) => b.text ?? '').join('');
        prompts.push(promptText);
        if (script.echoPrompt !== false) {
          emit({
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: promptText },
          } as SessionUpdate);
        }

        const permission = script.permissions.find((p) => p.match(promptText));
        if (permission) {
          await askPermission(ws, permission);
          return reply({ stopReason: 'end_turn' });
        }

        const found = script.prompts.find((p) => p.match(promptText));
        if (found) {
          for (const update of found.updates) {
            if (found.gapMs) await sleep(found.gapMs);
            emit(update);
          }
          if (found.hold) {
            await new Promise<void>((resolve) => {
              releaseHeld = resolve;
            });
            releaseHeld = null;
          }
        }
        return reply({ stopReason: 'end_turn' });
      }

      default:
        return reply({});
    }
  }

  /** Puts a permission question to one socket and streams the aftermath. */
  async function askPermission(ws: WebSocket, permission: PermissionScript): Promise<void> {
    emit({ sessionUpdate: 'tool_call', ...permission.toolCall } as SessionUpdate);
    const answer = await request(ws, 'session/request_permission', {
      sessionId: current,
      toolCall: { toolCallId: permission.toolCall.toolCallId },
      options: permission.options,
    });
    const outcome = (answer as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
    const optionId = outcome?.outcome === 'selected' ? (outcome.optionId ?? null) : null;
    for (const update of permission.after(optionId)) emit(update);
  }

  /** Sends a request to a browser and waits for its answer. */
  let nextRequestId = 1000;
  const waiting = new Map<number, (value: unknown) => void>();

  function request(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
    const id = nextRequestId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      const onMessage = (data: unknown): void => {
        let msg: Rpc;
        try {
          msg = JSON.parse(String(data)) as Rpc;
        } catch {
          return;
        }
        if (msg.id !== id) return;
        ws.off('message', onMessage);
        waiting.delete(id);
        resolve(msg.result);
      };
      ws.on('message', onMessage);
      send(ws, { jsonrpc: '2.0', id, method, params });
    });
  }

  return {
    script,
    get history() {
      return historyOf(current);
    },
    historyOf,
    prompts,
    attached: () => sockets.size,
    current: () => current,
    newThread: () => mint(null),
    forkThread: (from) => mint(from),
    select: (threadId) => {
      historyOf(threadId);
      current = threadId;
      dropSockets();
    },
    release: () => releaseHeld?.(),
    emit,
    close: () => {
      for (const ws of sockets) ws.close();
      wss.close();
    },
  };
}

/** A frame's params as a plain record; an absent or odd payload reads empty. */
function params(msg: Rpc): Record<string, unknown> {
  return typeof msg.params === 'object' && msg.params !== null
    ? (msg.params as Record<string, unknown>)
    : {};
}

function send(ws: WebSocket, msg: Rpc): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
