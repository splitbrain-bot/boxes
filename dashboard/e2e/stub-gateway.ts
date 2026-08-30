import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { SessionModeState, SessionUpdate } from '../src/stores/thread/acp-types.ts';

/**
 * A stand-in ACP gateway: a WebSocket server speaking the agent side of ACP
 * from canned scripts.
 *
 * It mirrors what the real gateway does rather than what a browser wishes it
 * did — one thread per session, session/new answered with the existing thread
 * id once there is one, session/load replaying the stored history as
 * notifications, and every update broadcast to every attached socket.
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
  modes: SessionModeState | null;
  prompts: PromptScript[];
  permissions: PermissionScript[];
  /** Delivered to the next socket that attaches, then cleared. */
  queuedPermission: PermissionScript | null;
}

/** A running stub gateway. */
export interface StubGateway {
  script: GatewayScript;
  /** Every session/update the stub has broadcast, in order. */
  history: SessionUpdate[];
  /** Prompt texts the stub received. */
  prompts: string[];
  /** How many sockets are attached right now. */
  attached: () => number;
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
  const history: SessionUpdate[] = [];
  const prompts: string[] = [];
  /** Set while a prompt is held open, so the test can end the turn. */
  let releaseHeld: (() => void) | null = null;
  /** Sockets that have already been handed a session/load replay. */
  let firstAttach = true;

  const emit = (update: SessionUpdate): void => {
    history.push(update);
    for (const ws of sockets) send(ws, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: THREAD_ID, update } });
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
        // One thread per session: the gateway hands back the existing id, and
        // a response without modes is how the browser learns to load.
        if (firstAttach && history.length === 0) {
          firstAttach = false;
          return reply({ sessionId: THREAD_ID, modes: script.modes });
        }
        return reply({ sessionId: THREAD_ID });

      case 'session/load': {
        reply({ modes: script.modes });
        // Replay is the stored history re-sent as notifications, to this
        // socket only.
        for (const update of history) {
          send(ws, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: THREAD_ID, update },
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

      case 'session/prompt': {
        const blocks = (params(msg)['prompt'] ?? []) as Array<{ type: string; text?: string }>;
        const promptText = blocks.map((b) => b.text ?? '').join('');
        prompts.push(promptText);
        emit({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: promptText },
        } as SessionUpdate);

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
      sessionId: THREAD_ID,
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
    history,
    prompts,
    attached: () => sockets.size,
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
