import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** What a notice is about, which picks its colour. */
export type NoticeTone = 'danger' | 'warn';

/** The colour classes of each tone. */
const TONE: Record<NoticeTone, string> = {
  danger: 'border-danger/40 bg-danger/10',
  warn: 'border-warn/40 bg-warn/10',
};

/**
 * An alert for a failed request or a state worth a warning. The component sets
 * the colour and the alert role. The caller sets the layout.
 */
export function Notice({
  tone = 'danger',
  className,
  children,
}: {
  /** The tone, danger by default. */
  tone?: NoticeTone;
  /** Layout classes from the caller. */
  className?: string;
  /** The message. */
  children: ReactNode;
}) {
  return (
    <div role="alert" className={cn(TONE[tone], 'text-sm', className)}>
      {children}
    </div>
  );
}
