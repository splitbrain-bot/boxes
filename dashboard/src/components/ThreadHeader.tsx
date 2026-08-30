import { Info } from 'lucide-react';
import { Link } from 'react-router';
import type { SessionModeState } from '../stores/thread/acp-types.ts';
import type { ConnectionState } from '../stores/thread/acp-client.ts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** What the connection dot says, and the colour it says it in. */
const CONNECTION: Record<ConnectionState, { label: string; dot: string }> = {
  connecting: { label: 'connecting', dot: 'bg-warn animate-pulse' },
  ready: { label: 'connected', dot: 'bg-ok' },
  reconnecting: { label: 'reconnecting', dot: 'bg-warn animate-pulse' },
  closed: { label: 'disconnected', dot: 'bg-idle' },
};

/**
 * The thread's own chrome: where it goes back to, what it is connected to,
 * and which of the adapter's modes it is in.
 */
export function ThreadHeader({
  sessionId,
  name,
  connection,
  modes,
  onSetMode,
}: {
  sessionId: string;
  name: string;
  connection: ConnectionState;
  modes: SessionModeState | null;
  onSetMode: (modeId: string) => void;
}) {
  const state = CONNECTION[connection];

  return (
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
        <Link to="/" aria-label="Back to sessions">
          ←
        </Link>
      </Button>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', state.dot)} />
          {state.label}
        </span>
      </div>

      {/* Whatever the adapter advertises, with nothing hardcoded: an adapter
          that offers no modes gets no switcher. */}
      {modes && modes.availableModes.length > 1 ? (
        <div
          role="radiogroup"
          aria-label="Agent mode"
          className="flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5"
        >
          {modes.availableModes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={mode.id === modes.currentModeId}
              title={mode.description ?? mode.name}
              onClick={() => onSetMode(mode.id)}
              className={cn(
                'rounded px-2 py-1 text-xs whitespace-nowrap transition-colors',
                mode.id === modes.currentModeId
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {mode.name}
            </button>
          ))}
        </div>
      ) : null}

      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link to={`/sessions/${sessionId}/info`} aria-label="Session details and controls">
          <Info />
        </Link>
      </Button>
    </header>
  );
}
