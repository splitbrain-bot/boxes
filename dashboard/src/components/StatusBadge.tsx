import './StatusBadge.css';

export type BadgeKind = 'running' | 'turn' | 'waiting' | 'error' | 'idle';

export function StatusBadge({ kind, label }: { kind: BadgeKind; label: string }) {
  return (
    <span class={`StatusBadge StatusBadge--${kind}`}>
      <span class="StatusBadge-dot" />
      {label}
    </span>
  );
}
