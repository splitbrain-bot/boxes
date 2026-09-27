import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Status text a view shows while it waits for its first answer. The status
 * role lets a screen reader announce it. The caller sets the layout.
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
      {children}
    </div>
  );
}
