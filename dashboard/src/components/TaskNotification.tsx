import { useCallback, useRef, useState } from 'react';
import type { DataMessagePartComponent } from '@assistant-ui/react';
import { ActivityIcon, CheckIcon, ChevronDownIcon, HandIcon, XIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useDisclosureLock } from '@/hooks/use-disclosure-lock';
import type { TaskNotification } from '../../../shared/task-notifications.ts';
import { formatUsage } from '@/lib/task-notifications';
import { cn } from '@/lib/utils';

/** How long the body takes to fold, in milliseconds, as the tool rows do. */
const ANIMATION_DURATION = 200;
/** The same duration as utility classes, for the animation. */
const DURATION = 'duration-200 [--tw-duration:200ms]';

/** The icon and colour for each status the harness reports. */
const LOOK: Record<string, { Icon: typeof CheckIcon; tone: string }> = {
  completed: { Icon: CheckIcon, tone: 'text-ok' },
  failed: { Icon: XIcon, tone: 'text-danger' },
  killed: { Icon: XIcon, tone: 'text-muted-foreground' },
  blocked: { Icon: HandIcon, tone: 'text-warn' },
};

/**
 * The look for a task without a known status: a running task, such as a
 * monitor's event, or a status from a newer harness.
 */
const RUNNING = { Icon: ActivityIcon, tone: 'text-muted-foreground' };

/**
 * A background task's report, drawn in place of the XML block it arrived as.
 * It is as quiet as the tool rows. The icon shows how the task ended.
 */
export const TaskNotificationPart: DataMessagePartComponent<TaskNotification> = ({ data }) => {
  const { Icon, tone } = (data.status ? LOOK[data.status] : undefined) ?? RUNNING;
  const usage = data.usage ? formatUsage(data.usage) : '';

  return (
    <div
      data-slot="boxes_task-notification"
      className="flex items-start gap-2 py-0.5 text-xs text-muted-foreground"
    >
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} aria-hidden />
      <div className="min-w-0 flex-1">
        {data.body ? (
          <TaskBody summary={data.summary} body={data.body} finished={data.status !== undefined} />
        ) : (
          <p className="font-medium">{data.summary}</p>
        )}
        {usage ? <p className="mt-1 opacity-80">{usage}</p> : null}
      </div>
    </div>
  );
};

/**
 * The summary, with the task's own text folded under it.
 *
 * A running task starts open, because its body is the event worth reading. A
 * finished task starts closed, because its body can be pages long.
 */
function TaskBody({
  summary,
  body,
  finished,
}: {
  /** The one-line summary. */
  summary: string;
  /** What the task said. */
  body: string;
  /** Whether the task reported a status. */
  finished: boolean;
}) {
  const [open, setOpen] = useState(!finished);
  const ref = useRef<HTMLDivElement>(null);
  // Holds the viewport still while the body folds, unless the thread follows its output.
  const lockScroll = useDisclosureLock(ref, ANIMATION_DURATION);

  const onOpenChange = useCallback(
    (next: boolean) => {
      lockScroll();
      setOpen(next);
    },
    [lockScroll],
  );

  return (
    <Collapsible ref={ref} open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className={cn(
          'group/trigger flex w-full items-start gap-2 text-start font-medium',
          'transition-colors hover:text-foreground',
        )}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDownIcon
          className={cn(
            'mt-0.5 size-3 shrink-0 -rotate-90 transition-transform',
            'ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
            'group-data-open/trigger:rotate-0',
            DURATION,
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'overflow-hidden ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
          'data-closed:animate-collapsible-up data-open:animate-collapsible-down',
          'data-closed:fill-mode-forwards',
          DURATION,
        )}
      >
        {/* Shown as written, not rendered as markdown, so alignment and paragraphs survive. */}
        <p className="mt-1 font-mono break-words whitespace-pre-wrap">{body}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}
