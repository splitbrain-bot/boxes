/** The card of a sub agent, with its name and its state in the row and its run inside. */

import {
  makeAssistantToolUI,
  ReadonlyThreadProvider,
  type ThreadMessage as RunMessage,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  useAuiState,
} from '@assistant-ui/react';
import { useState } from 'react';
import { ThreadMessage } from '@/components/assistant-ui/elements/thread.aui';
import {
  ToolFallbackContent,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from '@/components/assistant-ui/elements/tool-fallback.aui';
import { SUBAGENT_TOOL } from '../stores/thread/translate.ts';

/** The arguments of the card, which the thread model fills from the announcement of the sub agent. */
interface SubagentArgs {
  /** The name the agent gave the sub agent. */
  name?: string;
  /** The task the agent gave the sub agent. */
  task?: string;
}

/**
 * Checks if a tool call in the run waits for an answer of the user, through any number of sub agents.
 *
 * @param messages The messages of the run.
 * @returns True when a call waits.
 */
function awaitsAnswer(messages: readonly RunMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.some(
        (part) =>
          part.type === 'tool-call' &&
          ((part.approval !== undefined &&
            part.approval.approved === undefined &&
            part.approval.resolution === undefined) ||
            awaitsAnswer(part.messages ?? [])),
      ),
  );
}

/**
 * The card. It is closed by default and opens itself while a call inside it waits for an answer.
 *
 * The runtime derives the status of a tool call from its message, which is wrong for a sub agent that runs on
 * after the turn ended. The card has no result until the sub agent ends, so a missing result means that it runs.
 *
 * @param args The name and the task of the sub agent.
 * @param result Set once the sub agent has ended.
 * @param isError True when the sub agent failed or was cancelled.
 */
const SubagentCardImpl = ({ args, result, isError }: ToolCallMessagePartProps<SubagentArgs>) => {
  const messages = useAuiState((s) => (s.part.type === 'tool-call' ? s.part.messages : undefined));
  const asking = awaitsAnswer(messages ?? []);
  const [open, setOpen] = useState(asking);
  const [wasAsking, setWasAsking] = useState(asking);
  if (asking !== wasAsking) {
    setWasAsking(asking);
    if (asking) setOpen(true);
  }

  const status: ToolCallMessagePartStatus =
    result === undefined
      ? { type: 'running' }
      : isError
        ? { type: 'incomplete', reason: 'error' }
        : { type: 'complete' };

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger
        toolName={args.name ?? 'sub agent'}
        status={status}
        asking={asking}
        label="Sub agent"
      />
      <ToolFallbackContent>
        {args.task && (
          <p className="text-muted-foreground whitespace-pre-wrap" data-slot="subagent-task">
            {args.task}
          </p>
        )}
        {isError && typeof result === 'string' && result && (
          <p className="text-destructive" data-slot="subagent-state">
            {result}
          </p>
        )}
        {messages && messages.length > 0 && (
          <ReadonlyThreadProvider messages={messages}>
            <div data-slot="subagent-run" className="flex flex-col gap-y-6">
              <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
            </div>
          </ReadonlyThreadProvider>
        )}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

/** Registers the card for the sub agent parts of the thread while it is mounted. */
export const SubagentToolUI = makeAssistantToolUI<SubagentArgs, unknown>({
  toolName: SUBAGENT_TOOL,
  render: SubagentCardImpl,
});
