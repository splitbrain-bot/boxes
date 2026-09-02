import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** What a notice is about, which picks its colour. */
export type NoticeTone = 'danger' | 'warn';

const TONE: Record<NoticeTone, string> = {
  danger: 'border-danger/40 bg-danger/10',
  warn: 'border-warn/40 bg-warn/10',
};

/**
 * Something the view has to say: a failed request, or a state worth warning
 * about.
 *
 * The colour and the alert role belong to the component; the arrangement stays
 * the caller's, because a notice sits as a card in a stacked view and as a
 * band across the top of a pane, and each view has its own padding rhythm to
 * match. That is the same bargain TokenWarning makes.
 */
export function Notice({
  tone = 'danger',
  className,
  children,
}: {
  tone?: NoticeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="alert" className={cn(TONE[tone], 'text-sm', className)}>
      {children}
    </div>
  );
}
