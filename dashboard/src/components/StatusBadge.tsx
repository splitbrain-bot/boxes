import './StatusBadge.css';

/** What a badge reports, which picks its colour. */
export type BadgeKind = 'running' | 'turn' | 'waiting' | 'error' | 'idle';

/** A coloured dot with a label. */
export function StatusBadge({ kind, label }: { kind: BadgeKind; label: string }) {
  return (
    <span class={`StatusBadge StatusBadge--${kind}`}>
      <span class="StatusBadge-dot" />
      {label}
    </span>
  );
}
