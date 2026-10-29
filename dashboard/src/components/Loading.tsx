import type { ReactNode } from 'react';
import { Spinner } from '@/components/Spinner';
import { cn } from '@/lib/utils';

/**
 * Spinner and status text a view shows while it waits for its first answer.
 * The status role lets a screen reader announce it. The caller sets the layout.
 *
 * @param className Layout classes from the caller.
 * @param children The text, when a view has a more exact one than the default.
 */
export function Loading({
  className,
  children = 'Loading…',
}: {
  /** Layout classes from the caller. */
  className?: string;
  /** The text, when a view has a more exact one than the default. */
  children?: ReactNode;
}) {
  return (
    <div role="status" className={cn('text-sm text-muted-foreground', className)}>
      <span className="inline-flex items-center gap-2">
        <Spinner />
        {children}
      </span>
    </div>
  );
}
