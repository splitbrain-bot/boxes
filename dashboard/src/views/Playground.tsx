import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewportLock } from '@/hooks/use-viewport-lock';

/**
 * The installed components over a canned store, with no ACP connection.
 *
 * This is where a component upgrade is reviewed: every part kind the live
 * thread renders appears here, so a registry re-run that changes how one of
 * them looks shows up on one page rather than in a live session.
 */

/** One of everything the thread has to draw. */
const MESSAGES: ThreadMessageLike[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Summarise what `vetTarget` does, then list the files.' }],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: 'The question is about the proxy. vetTarget is in proxy/src/main.ts and it is the DNS-rebinding guard.',
      },
      {
        type: 'text',
        text: [
          '`vetTarget` is the egress proxy\'s **security boundary**. It:',
          '',
          '1. Resolves the hostname to *every* address it answers with.',
          '2. Rejects the target if any one of them is private.',
          '3. Connects to one vetted address, without resolving again.',
          '',
          'Pinning the connection to a vetted address is what closes DNS',
          'rebinding: a hostname must not pass with a public record and',
          'connect with a private one.',
          '',
          '```ts',
          'const vetted = await vetTarget(host, port);',
          'if (!vetted.ok) return deny(res, vetted.reason);',
          '```',
          '',
          '| Case | Outcome |',
          '| --- | --- |',
          '| Public A record | allowed |',
          '| Any private answer | denied |',
        ].join('\n'),
      },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'text', text: '!ls -1 proxy/src' }],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'shell-1',
        toolName: 'shell',
        args: { command: 'ls -1 proxy/src' },
        argsText: '{"command":"ls -1 proxy/src"}',
        result: 'cidr.test.ts\ncidr.ts\nmain.ts\n\n[exit 0]',
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-1',
        toolName: 'read_file',
        args: { path: 'proxy/src/cidr.ts' },
        argsText: '{"path":"proxy/src/cidr.ts"}',
      },
    ],
  },
];

/** A thread that renders the canned messages and accepts no input. */
export function Playground() {
  // A thread over canned messages is still a thread: same viewport, same lock.
  useViewportLock();
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: MESSAGES,
    convertMessage: (m) => m,
    isRunning: false,
    onNew: async () => {
      // Canned: there is nothing to send to.
    },
  });

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="h-dvh">
          <Thread />
        </div>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
