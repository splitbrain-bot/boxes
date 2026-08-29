import type { SessionSummary } from '../../../shared/types.ts';
import { StatusBadge, type BadgeKind } from './StatusBadge.tsx';
import './SessionCard.css';

/**
 * Badges answer the two questions the plan's headline demo cares about:
 * is a turn running, and is something waiting for me (plan §8.5, M4).
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

export function SessionCard({ session }: { session: SessionSummary }) {
  return (
    <a class="SessionCard" href={`/sessions/${session.id}`}>
      <div class="SessionCard-head">
        <span class="SessionCard-name">{session.name}</span>
        <span class="SessionCard-id">{session.id}</span>
      </div>
      {session.repoUrl ? <div class="SessionCard-repo">{session.repoUrl}</div> : null}
      <div class="SessionCard-badges">
        {sessionBadges(session).map((b) => (
          <StatusBadge key={b.label} kind={b.kind} label={b.label} />
        ))}
      </div>
    </a>
  );
}
