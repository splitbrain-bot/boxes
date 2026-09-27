import { ArrowLeft } from 'lucide-react';
import type { Up } from '@/hooks/use-up';

/**
 * The labelled back link above a stacked page.
 *
 * A page draws it while loading and again with its data, so it must keep its
 * place and shape. It is an anchor with an href, so a middle click and copy
 * link work. A plain click steps back in the history instead of pushing.
 *
 * @param up The parent route and the step-out handlers.
 * @param label The link text.
 */
export function BackLink({ up, label }: { up: Up; label: string }) {
  return (
    <a
      href={up.href}
      onClick={up.onClick}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      {label}
    </a>
  );
}
