import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useViewportLock } from '@/hooks/use-viewport-lock';
import { TASK_NOTIFICATION_PART } from '@/lib/task-notifications';

/**
 * The installed components over a canned store, with no ACP connection.
 *
 * This is where a component upgrade is reviewed: every part kind the live
 * thread renders appears here, so a registry re-run that changes how one of
 * them looks shows up on one page rather than in a live box.
 */

/**
 * A picture a tool produced, inline so the page needs nothing served to it.
 *
 * Wide and short: a message much taller than the height the thread reserves
 * for an off-screen one sets the scroller oscillating when it is read back up.
 */
const SCREENSHOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAABgCAIAAADkcV3eAAACiElEQVR42u3VoQ3AMBAEQdeZIlyJCwsJdjuuweCkSDfS4wF/YMcz19W93746Pp/P5//THx7E5/P5AuBBfD6fLwAexOfz+QJgAD6fzxcAA/D5fL4AGIDP5/MFwAB8Pp8vAAbg8/l8ATAAn8/nCwCfz+fzBYDP5/P5AsDn8/l8AeDz+Xy+APD5fD5fAPh8Pp8fDYCH8vl8fqcvAHw+ny8AHsTn8/kC4EF8Pp8vAAbg8/l8ATAAn8/nC4AB+Hw+XwAMwOfz+QJgAD6fzxcAA/D5fL4A8Pl8Pl8A+Hw+ny8AfD6fzxcAPp/P5wsAn8/n8wWAz+fz+dkAeCifz+d3+gLA5/P5AuBBfD6fLwAexOfz+QJgAD6fzxcAA/D5fL4AGIDP5/MFwAB8Pp8vAAbg8/l8ATAAn8/nCwCfz+fzBYDP5/P5AsDn8/l8AeDz+Xy+APD5fD5fAPh8Pp+fDYCH8vl8fqcvAHw+ny8AHsTn8/kC4EF8Pp8vAAbg8/l8ATAAn8/nC4AB+Hw+XwAMwOfz+QJgAD6fzxcAA/D5fL4A8Pl8Pl8A+Hw+ny8AfD6fzxcAPp/P5wsAn8/n8wWAz+fz+dkAeCifz+d3+gLA5/P5AuBBfD6fLwAexOfz+QJgAD6fzxcAA/D5fL4AGIDP5/MFwAB8Pp8vAAbg8/l8ATAAn8/nCwCfz+fzBYDP5/P5AsDn8/l8AeDz+Xy+APD5fD5fAPh8Pp+fDYCH8vl8fqcvAHw+ny8AHsTn8/kC4EF8Pp8vAAbg8/l8ATAAn8/nC4AB+Hw+XwAMwOfz+QJgAD6fzxcAA/D5fL4A8Pl8Pl8A+Hw+ny8AfD6fzxcAPp/P5wsAn8/n8wWAz+fz+VH/ADfWFRnCibAxAAAAAElFTkSuQmCC';

/** A file the composer attached, inline for the same reason. */
const LOG_FILE =
  'data:text/plain;base64,cHJveHk6IGRlbmllZCAxMC4wLjAuNTo0NDMgKHByaXZhdGUgYWRkcmVzcykKcHJveHk6IGFsbG93ZWQgZXhhbXBsZS5jb206NDQzCg==';

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
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'The vetting reads every answer, not the name:' },
      { type: 'image', image: SCREENSHOT },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'file', data: LOG_FILE, mimeType: 'text/plain', filename: 'proxy.log' },
      { type: 'text', text: 'This is what it logged while I tried.' },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'data',
        name: TASK_NOTIFICATION_PART,
        data: {
          taskId: 'bnztwmmw5',
          status: 'completed',
          summary: 'Subagent finished: audit the proxy rules',
          body: 'Nothing in the rule set matches a private range twice.',
          usage: { tokens: 18200, toolUses: 6, durationMs: 94_000 },
        },
      },
    ],
  },
];

/** A thread that renders the canned messages and accepts no input. */
export function Playground() {
  // Every route sets its own title, so arriving here from a thread does not
  // leave that thread's name on the tab.
  useDocumentTitle('Playground · Boxes');
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
