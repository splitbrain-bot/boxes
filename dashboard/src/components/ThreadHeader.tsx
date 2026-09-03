import { ArrowLeft, FileSearch, GitBranch, Info, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import type { SessionConfigOption, SessionModeState } from '../stores/thread/acp-types.ts';
import type { ConnectionState } from '../stores/thread/acp-client.ts';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** What the connection dot says, and the colour it says it in. */
const CONNECTION: Record<ConnectionState, { label: string; dot: string }> = {
  connecting: { label: 'connecting', dot: 'bg-warn animate-pulse' },
  ready: { label: 'connected', dot: 'bg-ok' },
  reconnecting: { label: 'reconnecting', dot: 'bg-warn animate-pulse' },
  closed: { label: 'disconnected', dot: 'bg-idle' },
};

/**
 * Whether an option is one this header can put a control on.
 *
 * A select with something to choose between. The adapter may advertise other
 * kinds — it has a boolean form of some options for clients that ask for one,
 * which this one does not — and an option with a single value is not a
 * choice.
 */
function isSelectable(option: SessionConfigOption): boolean {
  return (option.type ?? 'select') === 'select' && (option.options?.length ?? 0) > 1;
}

/** One config option as a native select. */
function ConfigSelect({
  option,
  label,
  className,
  onSet,
}: {
  option: SessionConfigOption;
  /** What to call it. The adapter's own name, unless the header has a better one. */
  label?: string;
  className?: string;
  onSet: (value: string) => void;
}) {
  const name = label ?? option.name;
  const current = option.options?.find((value) => value.value === option.currentValue);
  return (
    <select
      aria-label={name}
      value={option.currentValue ?? ''}
      onChange={(event) => onSet(event.target.value)}
      title={current?.description ?? current?.name ?? option.description ?? name}
      className={cn('min-w-0 rounded-md border bg-muted px-2 py-1 text-xs', className)}
    >
      {option.options?.map((value) => (
        <option key={value.value} value={value.value}>
          {value.name}
        </option>
      ))}
    </select>
  );
}

/**
 * The thread's own chrome: where it goes back to, which of the session's
 * conversations it is, what it is connected to, which of the adapter's modes
 * it is in, which model it answers with, and how to branch it.
 */
export function ThreadHeader({
  sessionId,
  threadId,
  name,
  threadLabel,
  connection,
  modes,
  configOptions,
  canFork,
  forking,
  onFork,
  onSetMode,
  onSetConfigOption,
}: {
  sessionId: string;
  /** Which thread this is, so the info view can come back to it exactly. */
  threadId: string | null;
  name: string;
  /** Which conversation of the session this is, or null while it is unknown. */
  threadLabel: string | null;
  connection: ConnectionState;
  modes: SessionModeState | null;
  configOptions: readonly SessionConfigOption[];
  /** Whether the adapter advertised the fork capability; see SessionSummary. */
  canFork: boolean;
  /** Held while a fork is in flight, so a double tap cannot branch twice. */
  forking: boolean;
  onFork: () => void;
  onSetMode: (modeId: string) => void;
  onSetConfigOption: (configId: string, value: string) => void;
}) {
  const state = CONNECTION[connection];
  const current = modes?.availableModes.find((mode) => mode.id === modes.currentModeId);
  // By category rather than by id: what the option is for is part of the
  // protocol, the id the adapter gives it is not.
  const model = configOptions.find((option) => option.category === 'model');
  // Everything else the adapter lets a client set — the effort level, fast
  // mode, the agent persona, whatever a later adapter adds. These used to go
  // nowhere, so the effort level could not be set at all. They live behind a
  // button rather than in the row: four selects do not fit a phone's header,
  // and these are the ones you set once rather than flip mid-thread.
  //
  // The mode is excluded because the switcher beside the name already is it,
  // under the adapter's other name for the same thing.
  const rest = configOptions.filter(
    (option) =>
      option !== model && option.category !== 'mode' && isSelectable(option),
  );

  return (
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
        <Link to="/" aria-label="Back to sessions">
          <ArrowLeft className="size-4" />
        </Link>
      </Button>

      {/* A floor under the name: two selects next to it would otherwise take
          the whole row on a phone and squeeze it away entirely. */}
      <div className="flex min-w-16 flex-1 flex-col">
        {/* The thread's name shares the session's line: the row below is the
            connection state, and the two selects have already taken the rest
            of the width at phone size. */}
        <span className="flex items-baseline gap-1.5 text-sm">
          {/* The session's name goes first and keeps up to two thirds of the
              line: which box you are in matters more than which of its
              conversations, so the thread's name is what gives way. */}
          <span className="max-w-2/3 shrink-0 truncate font-medium">{name}</span>
          {threadLabel ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{threadLabel}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', state.dot)} />
          {state.label}
        </span>
      </div>

      {/* Whatever the adapter advertises, with nothing hardcoded: an adapter
          that offers no modes and no model gets neither switcher.

          Selects rather than rows of buttons: six modes are wider than a
          phone, and the native control opens the platform's own picker and
          brings its keyboard and screen-reader behaviour with it. Each is
          capped so a long label truncates instead of pushing the name out. */}
      {modes && modes.availableModes.length > 1 ? (
        <select
          aria-label="Agent mode"
          value={modes.currentModeId}
          onChange={(event) => onSetMode(event.target.value)}
          title={current?.description ?? current?.name}
          className="min-w-0 max-w-24 shrink rounded-md border bg-muted px-2 py-1 text-xs"
        >
          {modes.availableModes.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
      ) : null}

      {model && isSelectable(model) ? (
        <ConfigSelect
          option={model}
          label="Model"
          className="max-w-24 shrink"
          onSet={(value) => onSetConfigOption(model.id, value)}
        />
      ) : null}

      {rest.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label="Agent settings"
              title="Effort and the adapter's other settings"
            >
              <SlidersHorizontal />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <div className="flex flex-col gap-3">
              {rest.map((option) => (
                <label key={option.id} className="flex flex-col gap-1 text-xs">
                  <span className="font-medium">{option.name}</span>
                  {option.description ? (
                    <span className="text-muted-foreground">{option.description}</span>
                  ) : null}
                  <ConfigSelect
                    option={option}
                    className="mt-0.5 py-1.5"
                    onSet={(value) => onSetConfigOption(option.id, value)}
                  />
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      {/* Branching belongs here rather than only on the list, because this is
          where the motion starts: you are in a thread that is doing something
          long, and you want a second one to ask about it. The fork keeps
          running alongside this thread rather than replacing it. */}
      {canFork ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          disabled={forking}
          onClick={onFork}
          aria-label="Fork this thread"
          title="Fork this thread into a second one"
        >
          <GitBranch />
        </Button>
      ) : null}

      {/* Reviewing sits next to forking because it is the other thing you do
          from inside a thread when the agent has produced something: read what
          it wrote, comment on it, and hand the comments back. */}
      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link
          to={`/sessions/${sessionId}/review`}
          // Which conversation the review was opened from, so its back link
          // and its handoff come back here rather than to whichever thread the
          // session has current — the two differ as soon as one is forked.
          state={{ threadId }}
          aria-label="Review this session's code"
          title="Review this session's code"
        >
          <FileSearch />
        </Link>
      </Button>

      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link
          to={`/sessions/${sessionId}/info`}
          state={{ threadId }}
          aria-label="Session details and controls"
        >
          <Info />
        </Link>
      </Button>
    </header>
  );
}
