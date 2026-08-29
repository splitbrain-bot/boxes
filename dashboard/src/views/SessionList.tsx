import { SessionCard } from '../components/SessionCard.tsx';
import { loadError, loading, sessions } from '../store.ts';
import './SessionList.css';

/** The dashboard's home: every session as a card. */
export function SessionList() {
  return (
    <div class="SessionList">
      <div class="SessionList-header">
        <h1 class="SessionList-title">Sessions</h1>
        <a class="SessionList-new" href="/new">
          New
        </a>
      </div>

      {loadError.value ? <div class="SessionList-error">{loadError.value}</div> : null}

      {loading.value && sessions.value.length === 0 ? (
        <div class="SessionList-empty">Loading…</div>
      ) : null}

      {!loading.value && sessions.value.length === 0 ? (
        <div class="SessionList-empty">No sessions yet. Create one to get started.</div>
      ) : null}

      {sessions.value.map((s) => (
        <SessionCard key={s.id} session={s} />
      ))}
    </div>
  );
}
