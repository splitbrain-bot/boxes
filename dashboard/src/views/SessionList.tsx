import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { SessionCard } from '@/components/SessionCard';
import { TokenWarning } from '@/components/TokenWarning';
import { Button } from '@/components/ui/button';
import { useSessions } from '../stores/sessions.ts';

/** The dashboard's home: every session as a card, and the card is the thread. */
export function SessionList() {
  const { sessions, claudeTokenConfigured, error, loading } = useSessions();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sessions</h1>
        <Button asChild size="sm">
          <Link to="/new">
            <Plus />
            New
          </Link>
        </Button>
      </div>

      {claudeTokenConfigured ? null : <TokenWarning className="rounded-md border px-3 py-2" />}

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      {loading && sessions.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
      ) : null}

      {!loading && sessions.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No sessions yet. Create one to get started.
        </div>
      ) : null}

      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} />
      ))}
    </div>
  );
}
