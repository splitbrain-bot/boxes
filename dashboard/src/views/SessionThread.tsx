import { Info } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';

/**
 * The thread view. Placeholder: the runtime, the ACP client and the store
 * land here next.
 */
export function SessionThread() {
  const { id = '' } = useParams();

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Sessions
        </Link>
        <span className="font-mono text-xs text-muted-foreground">{id}</span>
        <Button asChild variant="ghost" size="icon-sm">
          <Link to={`/sessions/${id}/info`} aria-label="Session details and controls">
            <Info />
          </Link>
        </Button>
      </header>
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Thread view not wired up yet.
      </div>
    </div>
  );
}
