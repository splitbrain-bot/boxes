import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { TURN_STATE_METHOD, type BackgroundProcess } from '../../shared/types.ts';
import type {
  ThreadConfigOption,
  ThreadModeState,
  ThreadUpdate,
} from '../src/stores/thread/acp-types.ts';

/** One content block of a prompt, as far as the stub reads it. */
export interface PromptBlock {
  /** The block type, such as text or image. */
  type: string;
  /** The text of a text block. */
  text?: string;
  /** The media type of a binary block. */
  mimeType?: string;
  /** The base64 data of a binary block. */
  data?: string;
}

/** What the stub streams in answer to one prompt. */
export interface PromptScript {
  /** Matched against the prompt text; the first match wins. */
  match: (text: string) => boolean;
  /** Updates to stream, in order, with a pause between them. */
  updates: ThreadUpdate[];
  /** Milliseconds between updates. Zero sends them in one tick. */
  gapMs?: number;
  /** Hold the prompt open until the test releases it. */
  hold?: boolean;
  /**
   * Whether this turn leaves work running in the background: the agent stops
   * speaking, and the prompt stays open while a subagent runs. It takes effect
   * only with `hold`. A held prompt without it keeps speaking.
   */
  background?: boolean;
}

/** A streamed assistant reply, in the chunks an adapter would send it. */
export function reply(...texts: string[]): ThreadUpdate[] {
  return texts.map(
    (text) =>
      ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as ThreadUpdate,
  );
}

/** A permission question the stub raises instead of answering a prompt. */
export interface PermissionScript {
  /** Matched against the prompt text; the first match wins. */
  match: (text: string) => boolean;
  /** The tool call the question is about. */
  toolCall: { toolCallId: string; title: string; kind?: string };
  /** The answers the browser can choose from. */
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** Streamed after the answer arrives, given the chosen option's id or null. */
  after: (optionId: string | null) => ThreadUpdate[];
}

/** How the stub behaves, mutable between tests. */
export interface GatewayScript {
  /** The modes the adapter offers, or null for none. */
  modes: ThreadModeState | null;
  /** The options the adapter offers, such as the model. */
  configOptions: ThreadConfigOption[];
  /** How the stub answers prompts. */
  prompts: PromptScript[];
  /** The permission questions the stub raises instead of answering a prompt. */
  permissions: PermissionScript[];
  /** Delivered to the next socket that attaches, then cleared. */
  queuedPermission: PermissionScript | null;
  /**
   * Hold every session/load until the test releases it, so the window a
   * browser spends waiting for its history is a window assertions fit in.
   */
  holdLoad?: boolean;
  /**
   * What a turn with `background` leaves running, as the adapter's async-task
   * spawns describe it. One stoppable shell command by default.
   */
  backgroundTasks?: BackgroundProcess[];
}

/** A running stub gateway. */
export interface StubGateway {
  /** How the stub behaves. A test may change it between prompts. */
  script: GatewayScript;
  /** Prompt texts the stub received, across every thread. */
  prompts: string[];
  /** The content blocks of each prompt, including those without text. */
  promptBlocks: PromptBlock[][];
  /** Notifications the stub received, in order, such as session/cancel. */
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  /** How many sockets are attached right now, across every thread. */
  attached: () => number;
  /** Mints an empty thread and makes it the default; returns its ACP id. */
  newThread: () => string;
  /** Mints a thread carrying another's history and makes it the default. */
  forkThread: (from: string) => string;
  /** Releases a held prompt, ending the turn. */
  release: () => void;
  /** Ends the background work a held turn declared, as a report would. */
  finishTasks: (threadId?: string) => void;
  /** Releases every held session/load, replay and all. */
  releaseLoad: () => void;
  /**
   * How many session/loads are parked, waiting to be released.
   *
   * A release frees only the loads parked at that moment. A load that arrives
   * later stays parked, so a test waits for this count before it releases.
   */
  loadsHeld: () => number;
  /** Sends one update to the sockets watching a thread, and records it. */
  emit: (update: ThreadUpdate, threadId?: string) => void;
  /** Closes every socket and the server. */
  close: () => void;
}

/** A JSON-RPC frame. */
interface Rpc {
  /** The protocol version. */
  jsonrpc: '2.0';
  /** The request id. A notification has none. */
  id?: number | string;
  /** The method of a request or notification. */
  method?: string;
  /** The parameters of a request or notification. */
  params?: unknown;
  /** The result of a response. */
  result?: unknown;
  /** The error of a failed response. */
  error?: { code: number; message: string };
}

/** The thread the stub starts with, and the default until another is minted. */
const THREAD_ID = 'acp-thread-1';

/** What the gateway has to know about a box to answer an upgrade. */
export interface BoxLookup {
  /**
   * The bearer this box's upgrade has to present, or null for a box
   * the deployment does not have.
   */
  token: (boxId: string) => string | null;
  /**
   * The adapter's own id for the thread a path names, which is the mapping
   * the real gateway does out of the threads table. A path naming no thread
   * asks for the box's most recently active one.
   */
  thread: (boxId: string, threadId: string | null) => string | null;
}

/**
 * Attaches a stub gateway to an existing HTTP server at
 * `/ws/boxes/:id/acp` and `/ws/boxes/:id/threads/:threadId/acp`.
 *
 * It speaks the agent side of ACP from canned scripts, and behaves like the
 * real gateway. The upgrade path pins each socket to one thread. Every update
 * goes only to the sockets that watch its thread.
 */
export function attachStubGateway(
  server: Server,
  script: GatewayScript,
  boxes: BoxLookup,
): StubGateway {
  const wss = new WebSocketServer({ noServer: true });
  /** Every attached socket, each recording the thread it is pinned to. */
  const sockets = new Map<WebSocket, string>();
  /** One transcript per thread, which is what session/load replays. */
  const threads = new Map<string, ThreadUpdate[]>([[THREAD_ID, []]]);
  /** The thread a socket naming none is pinned to. */
  let current = THREAD_ID;
  let nextThread = 2;
  const prompts: string[] = [];
  const promptBlocks: PromptBlock[][] = [];
  /** Every notification received, which is how a test sees session/cancel. */
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Set while a prompt is held open, so the test can end the turn. */
  let releaseHeld: (() => void) | null = null;
  /** Loads waiting for releaseLoad, when the script holds them. */
  const heldLoads: Array<() => void> = [];
  /** Threads with a prompt running, which is one third of the turn state. */
  const running = new Set<string>();
  /** Threads the agent is talking on. A thread can run a prompt without speaking. */
  const speaking = new Set<string>();
  /** What each thread has left running in the box, as the gateway reads it. */
  const background = new Map<string, BackgroundProcess[]>();

  const historyOf = (threadId: string): ThreadUpdate[] => {
    let found = threads.get(threadId);
    if (!found) {
      found = [];
      threads.set(threadId, found);
    }
    return found;
  };

  /** The sockets watching one thread. Nobody else is told. */
  const watchers = (threadId: string): WebSocket[] =>
    [...sockets].filter(([, pinned]) => pinned === threadId).map(([ws]) => ws);

  /**
   * Sends a thread's turn state to its watchers, or to one socket only.
   * A browser that re-opens a thread mid-turn learns it from nothing else.
   */
  const turnState = (threadId: string, only?: WebSocket): void => {
    for (const ws of only ? [only] : watchers(threadId)) {
      send(ws, {
        jsonrpc: '2.0',
        method: TURN_STATE_METHOD,
        params: {
          sessionId: threadId,
          active: running.has(threadId),
          speaking: speaking.has(threadId),
          background: background.get(threadId) ?? [],
        },
      });
    }
  };

  const emit = (update: ThreadUpdate, threadId: string = current): void => {
    historyOf(threadId).push(update);
    for (const ws of watchers(threadId)) {
      send(ws, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: threadId, update },
      });
    }
  };

  /** Mints a thread, carrying a source thread's history when forking. */
  const mint = (from: string | null): string => {
    const id = `acp-thread-${nextThread++}`;
    threads.set(id, from ? [...historyOf(from)] : []);
    // The new thread becomes the default. Sockets stay pinned to their threads.
    current = id;
    return id;
  };

  server.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const path = /^\/ws\/boxes\/([^/]+)(?:\/threads\/([^/]+))?\/acp$/.exec(url);
    if (!path) return;
    const boxId = path[1]!;
    const threadId = path[2] ?? null;

    // The real gateway's check: acp.v1 and the bearer of the box the path
    // names, both offered as subprotocols.
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim());
    const token = boxes.token(boxId);
    if (!offered.includes('acp.v1') || token === null || !offered.includes(`bearer.${token}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // The socket stays pinned to this thread for its whole life, as in the
    // real gateway. An unknown box or thread is refused before the upgrade.
    const pinned = boxes.thread(boxId, threadId);
    if (pinned === null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!threads.has(pinned)) threads.set(pinned, []);

    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, pinned);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => void handle(ws, String(data)));
    });
  });

  async function handle(ws: WebSocket, text: string): Promise<void> {
    /** The thread this socket is pinned to. */
    const pinned = sockets.get(ws) ?? current;
    let msg: Rpc;
    try {
      msg = JSON.parse(text) as Rpc;
    } catch {
      return;
    }
    if (!msg.method) return;
    if (msg.id === undefined) {
      // A notification, such as session/cancel. A cancel ends the held prompt,
      // as the adapter does.
      notifications.push({ method: msg.method, params: params(msg) });
      if (msg.method === 'session/cancel') releaseHeld?.();
      return;
    }
    const reply = (result: unknown): void => send(ws, { jsonrpc: '2.0', id: msg.id, result });

    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: 1, agentCapabilities: {} });

      case 'session/new':
        // Only the pinned thread's id. The modes come with the session/load that follows.
        return reply({ sessionId: pinned });

      case 'session/fork':
        // The stub plays gateway and adapter together. For a fork not yet
        // prompted, the orchestrator replays the source's history, so the
        // fork starts here with a copy of it.
        return reply({
          sessionId: mint(String(params(msg)['sessionId'] ?? current)),
          modes: script.modes,
          configOptions: script.configOptions,
        });

      case 'session/load': {
        const threadId = String(params(msg)['sessionId'] ?? pinned);
        if (script.holdLoad) await new Promise<void>((go) => heldLoads.push(go));
        // The replay goes to this socket only.
        for (const update of historyOf(threadId)) {
          send(ws, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: threadId, update },
          });
        }
        // The real gateway sends the turn state after the replay.
        turnState(threadId, ws);
        // The real gateway sends queued requests after the replay, because the
        // client discards what it showed before the replay. Each is sent once.
        if (script.queuedPermission) {
          const queued = script.queuedPermission;
          script.queuedPermission = null;
          void askPermission(ws, queued, threadId);
        }
        // Answered last, as the real gateway does. The client shows the thread
        // once the answer arrives.
        return reply({ modes: script.modes, configOptions: script.configOptions });
      }

      case 'session/set_mode': {
        const modeId = String(params(msg)['modeId'] ?? '');
        if (script.modes) script.modes = { ...script.modes, currentModeId: modeId };
        reply({});
        return void emit(
          { sessionUpdate: 'current_mode_update', currentModeId: modeId },
          pinned,
        );
      }

      case 'session/set_config_option': {
        const configId = String(params(msg)['configId'] ?? '');
        const value = String(params(msg)['value'] ?? '');
        script.configOptions = script.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option,
        );
        reply({ configOptions: script.configOptions });
        return void emit(
          { sessionUpdate: 'config_option_update', configOptions: script.configOptions },
          pinned,
        );
      }

      case 'session/prompt': {
        // A turn runs on the thread the prompt names, never on the default.
        const onThread = String(params(msg)['sessionId'] ?? pinned);
        const blocks = (params(msg)['prompt'] ?? []) as PromptBlock[];
        const promptText = blocks.map((b) => b.text ?? '').join('');
        prompts.push(promptText);
        promptBlocks.push(blocks);
        running.add(onThread);
        speaking.add(onThread);
        turnState(onThread);
        try {
          return await runPrompt(ws, onThread, blocks, promptText, reply);
        } finally {
          running.delete(onThread);
          speaking.delete(onThread);
          background.delete(onThread);
          turnState(onThread);
        }
      }

      default:
        return reply({});
    }
  }

  /** Streams one prompt's script, or its permission question. */
  async function runPrompt(
    ws: WebSocket,
    onThread: string,
    blocks: PromptBlock[],
    promptText: string,
    reply: (result: unknown) => void,
  ): Promise<void> {
    // Echoed block by block, as the real gateway does, because a client
    // renders an image block differently from text.
    for (const content of blocks) {
      emit({ sessionUpdate: 'user_message_chunk', content } as ThreadUpdate, onThread);
    }

    const permission = script.permissions.find((p) => p.match(promptText));
    if (permission) {
      await askPermission(ws, permission, onThread);
      return reply({ stopReason: 'end_turn' });
    }

    const found = script.prompts.find((p) => p.match(promptText));
    if (found) {
      for (const update of found.updates) {
        if (found.gapMs) await sleep(found.gapMs);
        emit(update, onThread);
      }
      if (found.hold) {
        if (found.background) {
          // As the adapter does: the prompt stays open and the agent stops speaking.
          background.set(
            onThread,
            script.backgroundTasks ?? [
              {
                id: 'bg-1',
                command: 'npm run build',
                kind: 'shell',
                stoppable: true,
                startedAt: Date.now() - 154_000,
              },
            ],
          );
          speaking.delete(onThread);
          turnState(onThread);
        }
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
        releaseHeld = null;
      }
    }
    return reply({ stopReason: 'end_turn' });
  }

  /** Puts a permission question to one socket and streams the aftermath. */
  async function askPermission(
    ws: WebSocket,
    permission: PermissionScript,
    onThread: string,
  ): Promise<void> {
    emit({ sessionUpdate: 'tool_call', ...permission.toolCall } as ThreadUpdate, onThread);
    const answer = await request(ws, 'session/request_permission', {
      sessionId: onThread,
      toolCall: { toolCallId: permission.toolCall.toolCallId },
      options: permission.options,
    });
    const outcome = (answer as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
    const optionId = outcome?.outcome === 'selected' ? (outcome.optionId ?? null) : null;
    for (const update of permission.after(optionId)) emit(update, onThread);
  }

  let nextRequestId = 1000;
  const waiting = new Map<number, (value: unknown) => void>();

  /** Sends a request to a browser and waits for its answer. */
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
    prompts,
    promptBlocks,
    notifications,
    attached: () => sockets.size,
    newThread: () => mint(null),
    forkThread: (from) => mint(from),
    release: () => releaseHeld?.(),
    finishTasks: (threadId = current) => {
      background.delete(threadId);
      turnState(threadId);
    },
    releaseLoad: () => {
      for (const go of heldLoads.splice(0)) go();
    },
    loadsHeld: () => heldLoads.length,
    emit,
    close: () => {
      for (const ws of sockets.keys()) ws.close();
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

/** Sends a frame to a socket that is still open. */
function send(ws: WebSocket, msg: Rpc): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Resolves after the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
