import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * What a view says while it waits for its first answer.
 *
 * `role="status"` is what this is for: a screen reader is otherwise told
 * nothing at all while a view sits empty, and the word on the screen is the
 * only thing a sighted reader has either. The arrangement stays the caller's,
 * because this sits centred on a whole viewport in one place and under a back
 * link in another.
 */
export function Loading({
  className,
  children = 'Loading…',
}: {
  className?: string;
  /** What it says, where a view has something more exact to say. */
  children?: ReactNode;
}) {
  return (
    <div role="status" className={cn('text-sm text-muted-foreground', className)}>
      {children}
    </div>
  );
}
