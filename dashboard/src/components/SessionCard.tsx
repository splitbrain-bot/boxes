import { Info } from 'lucide-react';
import { Link } from 'react-router';
import type { SessionSummary } from '../../../shared/types.ts';
import { StatusBadge, type BadgeKind } from './StatusBadge';
import { Card } from '@/components/ui/card';

/**
 * Builds the badges for a session: waiting approvals, a running turn, the
 * session's own state, and how many browsers are watching.
 */
export function sessionBadges(s: SessionSummary): Array<{ kind: BadgeKind; label: string }> {
  const badges: Array<{ kind: BadgeKind; label: string }> = [];
  if (s.pendingCount > 0) {
    badges.push({
      kind: 'waiting',
      label: s.pendingCount === 1 ? 'waiting for approval' : `${s.pendingCount} approvals waiting`,
    });
  }
  if (s.turnActive) badges.push({ kind: 'turn', label: 'running turn' });
  if (s.status === 'error') badges.push({ kind: 'error', label: 'error' });
  else if (s.dockerState === 'running') badges.push({ kind: 'running', label: 'up' });
  else badges.push({ kind: 'idle', label: s.status });
  if (s.attachedCount > 0) {
    badges.push({
      kind: 'idle',
      label: s.attachedCount === 1 ? '1 viewer' : `${s.attachedCount} viewers`,
    });
  }
  return badges;
}

/**
 * One session in the list. The card is the thread: tapping it opens the
 * conversation, because that is what a session is for. Ops live behind the
 * info corner, and the two sit side by side rather than nested, because an
 * anchor inside an anchor is invalid markup.
 */
export function SessionCard({ session }: { session: SessionSummary }) {
  return (
    <Card className="relative gap-0 overflow-hidden py-0 transition-colors hover:border-ring">
      <Link
        to={`/sessions/${session.id}`}
        className="flex flex-col gap-1 px-4 pt-4 pb-3 no-underline"
      >
        <div className="flex items-baseline gap-2 pr-9">
          <span className="truncate font-medium">{session.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{session.id}</span>
        </div>
        {session.repoUrl ? (
          <div className="truncate text-xs text-muted-foreground">{session.repoUrl}</div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sessionBadges(session).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
        </div>
      </Link>
      <Link
        to={`/sessions/${session.id}/info`}
        aria-label={`Details and controls for ${session.name}`}
        className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Info className="size-4" />
      </Link>
    </Card>
  );
}
