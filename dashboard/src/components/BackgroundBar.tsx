import { useEffect, useState } from 'react';
import { ActivityIcon, ChevronDownIcon, SquareIcon } from 'lucide-react';
import type { BackgroundProcess } from '../../../shared/types.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { commandsRunning } from '@/lib/activity';
import { formatDuration } from '@/lib/task-notifications';
import { cn } from '@/lib/utils';

/** How often the ages are re-read, in milliseconds. */
const TICK_MS = 15_000;

/**
 * Row prefixes for the task kinds whose name is a description, not a command
 * line. A shell task gets none, because its name is its command line.
 */
const KINDS: Record<string, string> = {
  workflow: 'Workflow',
  monitor: 'Monitor',
  task: 'Task',
};

/**
 * Returns the prefix word for a row.
 *
 * @param kind The task kind from the adapter.
 * @returns The prefix, the kind as the adapter spelled it for an unknown kind,
 *   or null for a shell command.
 */
function kindLabel(kind: string): string | null {
  if (kind === '' || kind === 'shell') return null;
  return KINDS[kind] ?? kind;
}

/**
 * Returns the current time, re-read every {@link TICK_MS} while active.
 *
 * @param active Whether an age is being shown.
 * @returns The time in epoch milliseconds.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Bar above the composer that lists the background work of this thread while
 * it runs.
 *
 * Without it, a thread with a quiet agent and a running monitor or build
 * looks finished. It renders nothing when no work runs.
 */
export function BackgroundBar({
  processes,
  onStop,
}: {
  /** What this conversation is running, as the gateway last read it. */
  processes: readonly BackgroundProcess[];
  /**
   * Kills one process and its children, or everything this thread runs when
   * given no id. Absent hides the stop buttons.
   *
   * A kill, because `session/cancel` ends the turn but leaves a running
   * command alive.
   */
  onStop?: (processId?: string) => void;
}) {
  /** The process a confirmation is open for, or 'all', or nothing. */
  const [confirming, setConfirming] = useState<BackgroundProcess | 'all' | null>(null);
  const now = useNow(processes.length > 0);
  if (processes.length === 0) return null;

  const stop = (): void => {
    if (!confirming || !onStop) return;
    setConfirming(null);
    onStop(confirming === 'all' ? undefined : confirming.id);
  };

  // A task that says it cannot be stopped gets no button. A bar without a
  // stoppable task gets no stop-all either.
  const stoppable = processes.filter((process) => process.stoppable);

  return (
    <div
      data-slot="boxes_background-bar"
      className="mx-auto w-full max-w-(--thread-max-width) px-2"
    >
      <Collapsible className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-3.5 shrink-0" aria-hidden />
          <CollapsibleTrigger className="group/tasks flex min-w-0 flex-1 items-center gap-2 text-start">
            <span className="min-w-0 flex-1 truncate font-medium">
              {commandsRunning(processes.length)}
            </span>
            <ChevronDownIcon
              className={cn(
                'size-3 shrink-0 -rotate-90 transition-transform duration-200',
                'ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
                'group-data-open/tasks:rotate-0',
              )}
            />
          </CollapsibleTrigger>
          {onStop && stoppable.length > 0 ? (
            <button
              type="button"
              aria-label="Stop everything still running"
              onClick={() => setConfirming('all')}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
            >
              <SquareIcon className="size-3 fill-current" aria-hidden />
              {processes.length === 1 ? 'Stop' : 'Stop all'}
            </button>
          ) : null}
        </div>
        <CollapsibleContent
          className={cn(
            'overflow-hidden ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
            'data-closed:animate-collapsible-up data-open:animate-collapsible-down',
            'data-closed:fill-mode-forwards duration-200 [--tw-duration:200ms]',
          )}
        >
          <ul className="mt-1.5 flex flex-col gap-1">
            {processes.map((process) => {
              const kind = kindLabel(process.kind);
              return (
                <li key={process.id} className="flex items-baseline gap-2">
                  {kind ? <span className="shrink-0 opacity-70">{kind}</span> : null}
                  {/* Monospaced only for a command line. */}
                  <span className={cn('min-w-0 flex-1 truncate', kind === null && 'font-mono')}>
                    {process.command}
                  </span>
                  {/* Time since the start, not since the last output. */}
                  <span className="shrink-0 tabular-nums opacity-80">
                    {formatDuration(Math.max(now - process.startedAt, 0))}
                  </span>
                  {onStop && process.stoppable ? (
                    <button
                      type="button"
                      aria-label={`Stop ${process.command}`}
                      onClick={() => setConfirming(process)}
                      className="inline-flex shrink-0 items-center rounded-md px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
                    >
                      <SquareIcon className="size-2.5 fill-current" aria-hidden />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>

      {confirming && onStop ? (
        <ConfirmDialog
          title={confirming === 'all' && processes.length > 1 ? 'Stop everything?' : 'Stop this?'}
          description={
            confirming === 'all'
              ? 'Kills what this conversation is still running, and anything those commands started. Half-done work stays half-done, and nothing will report back.'
              : `Kills "${confirming.command}", and anything it started. Half-done work stays half-done, and nothing will report back.`
          }
          confirmLabel="Stop"
          danger
          onConfirm={stop}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}
