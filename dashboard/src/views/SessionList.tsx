import { Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { ImageFooter } from '@/components/ImageFooter';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { PushToggle } from '@/components/PushToggle';
import { SessionCard } from '@/components/SessionCard';
import { TokenWarning } from '@/components/TokenWarning';
import { Button } from '@/components/ui/button';
import { startPolling, useSessions } from '../stores/sessions.ts';

/** The dashboard's home: every session as a card, and the card is the thread. */
export function SessionList() {
  const { sessions, claudeTokenConfigured, images, error, loading } = useSessions();

  // The whole list is polled while this screen is up, and only while it is:
  // every other view watches one session, and none of them needs the rest of
  // the deployment fetched every few seconds.
  useEffect(() => startPolling(), []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sessions</h1>
        <div className="flex items-center gap-1">
          {/* Whether this browser hears about a box that wants something. A
              subscription belongs to the browser rather than to a session, so
              it lives with the list rather than inside one. */}
          <PushToggle />
          {/* The AGENTS.md, skills and commands every box is built with.
              Deployment-wide, so it hangs off the list rather than a box. */}
          <Button asChild size="sm" variant="ghost" aria-label="Agent configuration">
            <Link to="/agents">
              <SlidersHorizontal />
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/new">
              <Plus />
              New
            </Link>
          </Button>
        </div>
      </div>

      {claudeTokenConfigured ? null : <TokenWarning className="rounded-md border px-3 py-2" />}

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      {loading && sessions.length === 0 ? <Loading className="py-8 text-center" /> : null}

      {/* Only where the list is genuinely empty. A failed poll knows nothing
          about how many sessions there are, and saying there are none under
          the error that says so is the one reading that is certainly wrong. */}
      {!loading && !error && sessions.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No sessions yet. Create one to get started.
        </div>
      ) : null}

      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} />
      ))}

      {/* What this deployment is built from. Under the list because it is a
          fact about the whole of it, and the last thing anybody scrolls to. */}
      <ImageFooter images={images} />
    </div>
  );
}
