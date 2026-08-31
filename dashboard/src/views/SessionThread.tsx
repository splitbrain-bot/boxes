import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { SessionDetail, ThreadSummary } from '../../../shared/types.ts';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { SlashCommandsProvider } from '@/components/SlashCommands';
import { TokenWarning } from '@/components/TokenWarning';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '../api.ts';
import { useSessions } from '../stores/sessions.ts';
import { convertMessage } from '../stores/thread/convert.ts';
import { bangCommand } from '../stores/thread/exec.ts';
import type { Message } from '../stores/thread/translate.ts';
import { useThread } from '../stores/thread/use-thread.ts';
import { threadName } from '@/lib/threads';
import { ThreadHeader } from '@/components/ThreadHeader';

/** The text of a composer submission, which is all we send upstream. */
function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * One of a session's conversations, inside the dashboard.
 *
 * The browser speaks plain ACP to the gateway; the store turns the adapter's
 * session/update notifications into messages and this route mounts them into
 * the installed assistant-ui components.
 *
 * Two routes land here: `/sessions/:id/threads/:threadId` is that thread, and
 * `/sessions/:id` is whichever one the session has current. The thread is
 * part of the connection's own URL, so two tabs on two threads of one box
 * each get their own conversation and neither sees the other's stream.
 */
export function SessionThread() {
  const { id = '', threadId } = useParams();
  /**
   * Text the review view staged in the composer on its way here — "read
   * REVIEW.md and address the comments in it". Staged, never sent: what to do
   * with a review is the reviewer's call, and a prompt that fires itself on
   * navigation is a prompt nobody agreed to.
   */
  const prefill = (useLocation().state as { prefill?: string } | null)?.prefill ?? null;
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The thread a fork just made, revealed as a link rather than opened. */
  const [forked, setForked] = useState<ThreadSummary | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const { claudeTokenConfigured } = useSessions();

  // The WS token comes from the session API, behind the deployment's auth.
  useEffect(() => {
    let live = true;
    api
      .getSession(id)
      .then((s) => live && setSession(s))
      .catch((err: Error) => live && setLoadError(err.message));
    return () => {
      live = false;
    };
  }, [id]);

  const { store, state } = useThread(id, threadId ?? null, session?.wsToken ?? null);

  // Which of the session's conversations this is, named always rather than
  // only when there is more than one: two tabs on one session are otherwise
  // indistinguishable, which is the whole point of a thread in the URL.
  const threads = session?.threads ?? [];
  const thread = threads.find((t) => t.id === (threadId ?? session?.currentThreadId));
  const threadLabel = thread ? threadName(thread) : null;

  /**
   * Branches this conversation and reveals the result as a link.
   *
   * A `window.open` after the await is the thing to reach for, and it is what
   * popup blockers exist to stop. One extra tap is cheaper than an unreliable
   * one — and this thread stays exactly where it is either way, because no
   * connection is pinned to the session's default any more.
   */
  const onFork = useCallback(() => {
    if (!thread || forking) return;
    setForking(true);
    setForked(null);
    setForkError(null);
    api
      .createThread(id, { from: thread.id })
      .then(setForked)
      // Reported where the action was, rather than in the bar that means the
      // session itself could not be read.
      .catch((err: Error) => setForkError(err.message))
      .finally(() => setForking(false));
  }, [id, thread, forking]);

  // Commands already run in this session, appended once the thread is up.
  // ACP replay carries no timestamps, so they go after the transcript rather
  // than interleaved into it.
  useEffect(() => {
    if (!store || state.connection !== 'ready') return;
    void store.loadExecHistory();
  }, [store, state.connection]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = textOf(message);
      if (!text || !store) return;
      // A !bang line is intercepted here and never reaches the adapter, so
      // it costs no tokens and cannot be read as an instruction.
      const command = bangCommand(text);
      if (command) {
        await store.runCommand(command);
        return;
      }
      await store.send(text);
    },
    [store],
  );

  const runtime = useExternalStoreRuntime<Message>({
    messages: state.messages as Message[],
    convertMessage,
    isRunning: state.isRunning,
    isSendDisabled: !store || state.connection !== 'ready',
    onNew,
    onCancel: async () => store?.cancel(),
    onRefetchThread: async () => store?.refetch(),
    onRespondToToolApproval: ({ approvalId, approved, optionId }) => {
      // A decision with no option id is a plain refusal to choose; the store
      // turns that into ACP's cancelled outcome.
      store?.respondToApproval(approvalId, approved || optionId ? optionId : undefined);
    },
  });

  // Once, on arrival. Not in a dependency on the runtime, which is rebuilt on
  // every message: that would keep overwriting whatever is being typed.
  const staged = useRef(false);
  useEffect(() => {
    if (!prefill || staged.current) return;
    staged.current = true;
    runtime.thread.composer.setText(prefill);
  }, [prefill, runtime]);

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <SlashCommandsProvider commands={state.commands}>
          <div className="flex h-dvh flex-col">
            <ThreadHeader
              sessionId={id}
              threadId={thread?.id ?? null}
              name={session?.name ?? id}
              threadLabel={threadLabel}
              connection={state.connection}
              modes={state.modes}
              configOptions={state.configOptions}
              canFork={session?.canFork === true && thread !== undefined}
              forking={forking}
              onFork={onFork}
              onSetMode={(modeId) => void store?.setMode(modeId)}
              onSetConfigOption={(configId, value) =>
                void store?.setConfigOption(configId, value)
              }
            />
            {claudeTokenConfigured ? null : <TokenWarning className="border-b px-4 py-2" />}
            {forked ? (
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm">
                <span>{threadName(forked)} branched from this conversation.</span>
                {/* A real click on a real link, so the browser opens the tab
                    rather than a script asking it to. */}
                <Link
                  to={`/sessions/${id}/threads/${forked.id}`}
                  target="_blank"
                  rel="noopener"
                  className="font-medium underline"
                >
                  Open it in a new tab
                </Link>
                <button
                  type="button"
                  onClick={() => setForked(null)}
                  className="ml-auto text-xs text-muted-foreground hover:underline"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {forkError ? (
              <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm">
                Could not fork this thread: {forkError}
              </div>
            ) : null}
            {loadError ? (
              <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm">
                {loadError}
              </div>
            ) : null}
            {state.error ? (
              <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm">
                {state.error}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <Thread />
            </div>
          </div>
        </SlashCommandsProvider>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
