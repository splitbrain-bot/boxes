import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { SessionSummary } from '../../../shared/types.ts';
import { connectToSession } from '../acpui.ts';
import { StatusBadge, type BadgeKind } from './StatusBadge.tsx';
import './SessionCard.css';

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
 * One session in the list. The info area links to the detail view and Open
 * configures acp-ui for this session and goes there. The two actions sit side
 * by side rather than nested, because a button inside an anchor is invalid
 * markup.
 */
export function SessionCard({ session }: { session: SessionSummary }) {
  const { route } = useLocation();
  const [failed, setFailed] = useState(false);

  const open = (): void => {
    // A stopped session is fine to open: attaching starts it and
    // session/load restores the thread.
    if (!connectToSession(session)) {
      // Storage is blocked in this browser; the detail view carries the
      // manual fallback.
      setFailed(true);
      route(`/sessions/${session.id}`);
    }
  };

  return (
    <div class="SessionCard">
      <a class="SessionCard-main" href={`/sessions/${session.id}`}>
        <div class="SessionCard-head">
          <span class="SessionCard-name">{session.name}</span>
          <span class="SessionCard-id">{session.id}</span>
        </div>
        {session.repoUrl ? <div class="SessionCard-repo">{session.repoUrl}</div> : null}
      </a>
      <div class="SessionCard-footer">
        <div class="SessionCard-badges">
          {sessionBadges(session).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
        </div>
        <button
          type="button"
          class="SessionCard-open"
          onClick={open}
          aria-label={`Open ${session.name} in acp-ui`}
        >
          Open
        </button>
      </div>
      {failed ? (
        <div class="SessionCard-error">This browser blocked local storage.</div>
      ) : null}
    </div>
  );
}
