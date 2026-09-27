import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ThreadSummary } from '../../../shared/types.ts';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { BackgroundBar } from '@/components/BackgroundBar';
import { Notice } from '@/components/Notice';
import { SlashCommandsProvider } from '@/components/SlashCommands';
import { TokenWarning } from '@/components/TokenWarning';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api, ApiError } from '../api.ts';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useBox } from '@/hooks/use-box';
import { useUp } from '@/hooks/use-up';
import { takeStagedPrompt } from '@/lib/staged-prompt';
import { threadTitle, type TabState } from '@/lib/tab-title';
import { refreshHealth } from '../stores/boxes.ts';
import { createAttachmentAdapter } from '../stores/thread/attachments.ts';
import type { ContentBlock } from '../stores/thread/acp-types.ts';
import { convertMessage } from '../stores/thread/convert.ts';
import type { Message } from '../stores/thread/translate.ts';
import { useThread } from '../stores/thread/use-thread.ts';
import { harnessLabel } from '@/lib/harness';
import { threadName } from '@/lib/threads';
import { useBoxes } from '../stores/boxes.ts';
import { buildEnvelope, formatBytes, type AttachmentEntry } from '@/lib/attachments';
import { Shelf } from '@/components/Shelf';
import { ThreadLoading } from '@/components/ThreadLoading';
import { ThreadHeader } from '@/components/ThreadHeader';
import { useScrollAway } from '@/hooks/use-scroll-away';
import { useViewportLock } from '@/hooks/use-viewport-lock';

/**
 * Returns the typed text of a composer submission, without its attachments.
 *
 * @param message The submission.
 * @returns The trimmed text.
 */
function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * Converts one composer submission into the content blocks of an ACP prompt.
 *
 * The note on the attachments comes first, then the typed text. The
 * attachments are already uploaded, so the note holds their paths.
 *
 * @param message The submission.
 * @returns The prompt blocks.
 */
function blocksOf(message: AppendMessage): ContentBlock[] {
  const entries: AttachmentEntry[] = [];

  for (const attachment of message.attachments ?? []) {
    for (const part of attachment.content ?? []) {
      if (part.type !== 'file') continue;
      entries.push({
        path: part.data,
        name: part.filename ?? attachment.name,
        mimeType: part.mimeType,
        size: formatBytes(attachment.file?.size ?? 0),
      });
    }
  }

  const text = textOf(message);
  return [
    ...(entries.length > 0 ? [{ type: 'text' as const, text: buildEnvelope(entries) }] : []),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];
}

/** Why this view could not read its box, in the words it shows. */
interface LoadError {
  /** The first line of the notice. */
  message: string;
  /** The second line, which says what the failure means for the box. */
  detail: string;
}

/**
 * Builds the notice for a box that would not load.
 *
 * Only a 404 means the box is gone. An authenticating proxy in front of the
 * deployment answers 401 or 403 once its cookie expires. Any other failure
 * means the deployment could not be reached.
 *
 * @param err The failed read.
 * @returns The notice text.
 */
function describeLoadError(err: Error): LoadError {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 404) {
    return {
      message: err.message,
      detail: 'It may have been deleted. Nothing can be sent to it from here.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      message: 'This deployment wants you to sign in again.',
      detail: 'Reload the page to do that. The box itself is untouched.',
    };
  }
  return {
    message: err.message,
    detail: 'The deployment could not be reached. The box itself may be fine.',
  };
}

/**
 * Page with one thread of a box, at `/boxes/:id/threads/:threadId`.
 *
 * The browser speaks ACP to the gateway. The thread store turns the updates
 * into messages, and this page renders them with the assistant-ui components.
 * The connection URL names the thread, so two tabs on two threads of one box
 * each get their own stream.
 */
export function BoxThread() {
  const { id = '', threadId = '' } = useParams();
  /**
   * Text that the review view staged for the composer, or null. It fills the
   * composer and is never sent on its own.
   */
  const [prefill, setPrefill] = useState<string | null>(null);
  /** The thread a fork just made, shown as a link. */
  const [forked, setForked] = useState<ThreadSummary | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);

  /**
   * This box, polled for the WebSocket token, the name and the threads.
   * Polling picks up a title the agent gives a thread after its first turn.
   */
  const { box, error: readError, reload } = useBox(id);

  /**
   * Why there is nothing to show, or null. Set only while the box has never
   * been read, so a failed later poll keeps the conversation on screen.
   */
  const loadError: LoadError | null = box || !readError ? null : describeLoadError(readError);

  // Reads the harness health once for the credential warning.
  useEffect(() => {
    void refreshHealth();
  }, []);

  // Taking the staged prompt clears it, so a second run of this effect in
  // development finds nothing.
  useEffect(() => {
    const staged = takeStagedPrompt(id);
    if (staged !== null) setPrefill(staged);
  }, [id]);

  /** Leaves for the box list. */
  const up = useUp('/');

  const { store, state } = useThread(id, threadId, box?.wsToken ?? null);

  // Named even in a box with one thread, so two tabs on one box differ.
  const threads = box?.threads ?? [];
  const thread = threads.find((t) => t.id === threadId);
  const threadLabel = thread ? threadName(thread) : null;
  // The harness labels come from the health list that the box store holds.
  const { harnesses } = useBoxes();

  /**
   * What this tab is doing, for its title.
   *
   * A waiting question outranks a running turn. Below those, background work
   * without a turn reads as waiting.
   */
  const tabState: TabState =
    state.awaiting ??
    (state.isRunning ? 'running' : state.background.length > 0 ? 'waiting' : 'idle');
  useDocumentTitle(threadTitle(tabState, box?.name ?? id, threadLabel));

  // The thread viewport is the only scroller, so the header stays on screen.
  useViewportLock();

  // Hides the header while reading down and shows it on a scroll back up.
  // A turn's output does not move it, because the viewport stays at the bottom.
  const { away, container } = useScrollAway('[data-slot="aui_thread-viewport"]');

  /**
   * Forks this thread and shows the result as a link.
   *
   * Popup blockers stop a `window.open` after the await, so the user taps a link.
   */
  const onFork = useCallback(() => {
    if (!thread || forking) return;
    setForking(true);
    setForked(null);
    setForkError(null);
    api
      .createThread(id, { from: thread.id })
      .then(setForked)
      // Shown beside the action, not as a box load error.
      .catch((err: Error) => setForkError(err.message))
      .finally(() => setForking(false));
  }, [id, thread, forking]);

  /**
   * Marks this thread done, or removes the mark.
   *
   * The header shows the mark from the polled box, so this reloads the box.
   *
   * @param next True to mark the thread done.
   */
  const onSetDone = useCallback(
    (next: boolean) => {
      if (!thread) return;
      api
        .setThreadDone(id, thread.id, next)
        .then(() => reload())
        .catch((err: Error) => store?.reportError(err.message));
    },
    [id, thread, store, reload],
  );

  /**
   * Stops the background work of a thread: one process, or all of them.
   *
   * The bar keeps its rows until the gateway reports the processes gone.
   * A failed request shows as a thread error.
   *
   * @param forThread The thread id.
   * @param processId The process to stop, or all of them when absent.
   */
  const stopBackground = useCallback(
    async (forThread: string, processId?: string): Promise<void> => {
      try {
        await api.stopBackgroundWork(id, forThread, processId);
      } catch (err) {
        store?.reportError((err as Error).message);
      }
    },
    [id, store],
  );

  /** Sends a composer submission as a prompt. */
  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (!store) return;
      await store.send(blocksOf(message));
    },
    [store],
  );

  /**
   * The composer's attachment adapter, which uploads into this box's
   * workspace. It is rebuilt with the store, so a failed upload reports to the
   * current store.
   */
  const attachmentAdapter = useMemo(
    () => createAttachmentAdapter(id, (message) => store?.reportError(message)),
    [id, store],
  );

  // Bound to the box, because attachments are served from its workspace.
  const convert = useCallback((message: Message) => convertMessage(message, id), [id]);

  const runtime = useExternalStoreRuntime<Message>({
    messages: state.messages as Message[],
    convertMessage: convert,
    isRunning: state.isRunning,
    isSendDisabled: !store || state.connection !== 'ready',
    onNew,
    onCancel: async () => store?.cancel(),
    onRefetchThread: async () => store?.refetch(),
    adapters: { attachments: attachmentAdapter },
    onRespondToToolApproval: ({ approvalId, approved, optionId }) => {
      // No option id means a refusal to choose. The store sends ACP's cancelled outcome.
      store?.respondToApproval(approvalId, approved || optionId ? optionId : undefined);
    },
  });

  // The runtime is rebuilt on every message, so the ref keeps this to one run
  // that does not overwrite typed text.
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
          <div ref={container} className="flex h-dvh flex-col">
            {/* Only the header hides on scroll. The notices below it stay. */}
            <Shelf away={away}>
              <ThreadHeader
                boxId={id}
                threadId={thread?.id ?? null}
                up={up}
                name={box?.name ?? id}
                threadLabel={threadLabel}
                harness={thread?.harness ?? null}
                harnessLabel={harnessLabel(harnesses, thread?.harness)}
                // Shows closed when the box could not be read, because nothing connects.
                connection={loadError ? 'closed' : state.connection}
                modes={state.modes}
                configOptions={state.configOptions}
                done={thread?.done === true}
                canFork={thread?.canFork === true}
                forking={forking}
                onFork={onFork}
                // Undefined until the box has been read, which hides the button.
                onSetDone={thread ? onSetDone : undefined}
                onSetMode={(modeId) => void store?.setMode(modeId)}
                onSetConfigOption={(configId, value) =>
                  void store?.setConfigOption(configId, value)
                }
              />
            </Shelf>
            <TokenWarning className="border-b px-4 py-2" />
            {forked ? (
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm">
                <span>
                  {threadName(forked)} branched from this conversation. It opens on everything
                  said here so far and goes its own way from there.
                </span>
                {/* A plain link, so a popup blocker does not stop the new tab. */}
                <Link
                  to={`/boxes/${id}/threads/${forked.id}`}
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
              <Notice className="border-b px-4 py-2">
                Could not fork this thread: {forkError}
              </Notice>
            ) : null}
            {state.error ? (
              <Notice className="border-b px-4 py-2">{state.error}</Notice>
            ) : null}
            <div className="min-h-0 flex-1">
              {/* A box that could not be read has no token, so the page shows no composer. */}
              {loadError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-sm">{loadError.message}</p>
                  <p className="text-sm text-muted-foreground">{loadError.detail}</p>
                  {/* The same step out as the header's back button. */}
                  <a href={up.href} onClick={up.onClick} className="text-sm font-medium underline">
                    Back to boxes
                  </a>
                </div>
              ) : state.loading ? (
                // The box may still be starting. The conversation appears in one
                // piece once it has been read.
                <ThreadLoading />
              ) : (
                <Thread
                  aboveComposer={
                    <BackgroundBar
                      processes={state.background}
                      // Undefined until the box has been read, which hides the button.
                      onStop={
                        thread
                          ? (processId) => void stopBackground(thread.id, processId)
                          : undefined
                      }
                    />
                  }
                />
              )}
            </div>
          </div>
        </SlashCommandsProvider>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
