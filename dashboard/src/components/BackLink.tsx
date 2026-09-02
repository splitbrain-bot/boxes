import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';

/**
 * The labelled back link above a stacked page.
 *
 * A page draws this twice — once in the state where it is still loading and
 * once in the state where it has its data — and the two used to disagree: one
 * a text arrow, the other the icon. Leaving is the one thing that works in
 * both states, so it should not move or change shape between them.
 *
 * The back arrow inside a pane header is a different control; see
 * ThreadHeader.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      {label}
    </Link>
  );
}
