import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from '@assistant-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { SessionDetail } from '../../../shared/types.ts';
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
 * A session's conversation, inside the dashboard.
 *
 * The browser speaks plain ACP to the gateway; the store turns the adapter's
 * session/update notifications into messages and this route mounts them into
 * the installed assistant-ui components.
 */
export function SessionThread() {
  const { id = '' } = useParams();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  const { store, state } = useThread(id, session?.wsToken ?? null);

  // Which of the session's conversations this is. A session with only one
  // says nothing, because then the session's own name is the whole answer.
  const threads = session?.threads ?? [];
  const current = threads.find((t) => t.id === session?.currentThreadId);
  const threadLabel = current && threads.length > 1 ? threadName(current) : null;

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

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <SlashCommandsProvider commands={state.commands}>
          <div className="flex h-dvh flex-col">
            <ThreadHeader
              sessionId={id}
              name={session?.name ?? id}
              threadLabel={threadLabel}
              connection={state.connection}
              modes={state.modes}
              configOptions={state.configOptions}
              onSetMode={(modeId) => void store?.setMode(modeId)}
              onSetConfigOption={(configId, value) =>
                void store?.setConfigOption(configId, value)
              }
            />
            {claudeTokenConfigured ? null : <TokenWarning className="border-b px-4 py-2" />}
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
