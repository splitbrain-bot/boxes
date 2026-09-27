import {
  ArrowLeft,
  CircleCheck,
  FileSearch,
  GitBranch,
  SlidersHorizontal,
  SquareTerminal,
} from 'lucide-react';
import { Link } from 'react-router';
import type { HarnessId } from '../../../shared/types.ts';
import type { ThreadConfigOption, ThreadModeState } from '../stores/thread/acp-types.ts';
import type { ConnectionState } from '../stores/thread/acp-client.ts';
import type { Up } from '@/hooks/use-up';
import {
  ConfigSelect,
  ModeSelect,
  Setting,
  currentModeDescription,
  isSelectable,
  optionName,
} from '@/components/AgentSettings';
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

/** The header of the thread page. */
export function ThreadHeader({
  boxId,
  threadId,
  up,
  name,
  threadLabel,
  harness,
  harnessLabel,
  connection,
  modes,
  configOptions,
  done,
  canFork,
  forking,
  onFork,
  onSetDone,
  onSetMode,
  onSetConfigOption,
}: {
  /** The box id, for the review and terminal links. */
  boxId: string;
  /** The thread id, which the review link carries so it leads back here. */
  threadId: string | null;
  /** The parent route and the step-out handlers. */
  up: Up;
  /** The box's name. */
  name: string;
  /** Which conversation of the box this is, or null while it is unknown. */
  threadLabel: string | null;
  /**
   * The thread's harness, or null while the thread is unknown. It decides the
   * caveat on a mode.
   */
  harness: HarnessId | null;
  /** The harness's name for the reader, or null. */
  harnessLabel: string | null;
  /** The connection state, which the dot shows. */
  connection: ConnectionState;
  /** The adapter's modes, or null when it offers none. */
  modes: ThreadModeState | null;
  /** The adapter's config options. */
  configOptions: readonly ThreadConfigOption[];
  /** Whether the reader has marked this conversation finished with. */
  done: boolean;
  /** Whether the thread's adapter advertised the fork capability. */
  canFork: boolean;
  /** Whether a fork is in flight. A double tap then cannot fork twice. */
  forking: boolean;
  /** Forks the thread. */
  onFork: () => void;
  /** Sets the mark, or takes it off. Absent while there is no thread to mark. */
  onSetDone?: (done: boolean) => void;
  /** Sets the thread's mode. */
  onSetMode: (modeId: string) => void;
  /** Sets one config option of the thread. */
  onSetConfigOption: (configId: string, value: string) => void;
}) {
  const state = CONNECTION[connection];
  // Found by category, because the protocol defines categories and each
  // adapter picks its own ids.
  const model = configOptions.find((option) => option.category === 'model');
  // Every other selectable option. The mode option is left out, because
  // `modes` already carries the mode.
  const rest = configOptions.filter(
    (option) =>
      option !== model && option.category !== 'mode' && isSelectable(option),
  );

  // All settings sit behind one button, because they do not fit a phone's header.
  const hasModes = Boolean(modes && modes.availableModes.length > 1);
  const hasModel = Boolean(model && isSelectable(model));
  const settings = hasModes || hasModel || rest.length > 0;

  return (
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
        <a href={up.href} onClick={up.onClick} aria-label="Back to boxes">
          <ArrowLeft className="size-4" />
        </a>
      </Button>

      {/* A minimum width, so the icon buttons cannot squeeze out the name. */}
      <div className="flex min-w-16 flex-1 flex-col">
        <span className="flex items-baseline gap-1.5 text-sm">
          {/* The box's name keeps up to two thirds of the line. The thread's
              name truncates first. */}
          <span className="max-w-2/3 shrink-0 truncate font-medium">{name}</span>
          {threadLabel ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{threadLabel}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', state.dot)} />
          {state.label}
          {/* The harness name, because a mode id means a different permission
              under each harness. */}
          {harnessLabel ? <span className="truncate">· {harnessLabel}</span> : null}
        </span>
      </div>

      {/* Shows only what the adapter advertises. Without any setting there is no button. */}
      {settings ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label="Agent settings"
              title="Mode, model, effort and the adapter's other settings"
            >
              <SlidersHorizontal />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <div className="flex flex-col gap-3">
              {/* The mode comes first, because it changes most often mid-thread. */}
              {modes && hasModes ? (
                <Setting name="Agent mode" description={currentModeDescription(modes, harness)}>
                  <ModeSelect
                    modes={modes}
                    harness={harness}
                    className="mt-0.5 py-1.5"
                    onSet={onSetMode}
                  />
                </Setting>
              ) : null}

              {model && hasModel ? (
                <Setting name={optionName(model)} description={model.description}>
                  <ConfigSelect
                    option={model}
                    label="Model"
                    className="mt-0.5 py-1.5"
                    onSet={(value) => onSetConfigOption(model.id, value)}
                  />
                </Setting>
              ) : null}

              {rest.map((option) => (
                <Setting key={option.id} name={optionName(option)} description={option.description}>
                  <ConfigSelect
                    option={option}
                    className="mt-0.5 py-1.5"
                    onSet={(value) => onSetConfigOption(option.id, value)}
                  />
                </Setting>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      {/* The box list strikes through a thread marked done. The thread keeps running. */}
      {onSetDone ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-pressed={done}
          onClick={() => onSetDone(!done)}
          aria-label={done ? 'Mark this thread not done' : 'Mark this thread done'}
          title={done ? 'Mark this thread not done' : 'Mark this thread done'}
        >
          <CircleCheck className={done ? 'text-ok' : undefined} />
        </Button>
      ) : null}

      {/* The fork runs beside this thread. */}
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

      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link
          to={`/boxes/${boxId}/review`}
          // The review's back link and handoff return to this thread.
          state={{ threadId }}
          aria-label="Review this box's code"
          title="Review this box's code"
        >
          <FileSearch />
        </Link>
      </Button>

      {/* A terminal belongs to the box, so the link names no thread. */}
      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link
          to={`/boxes/${boxId}/terminal`}
          aria-label="Open a terminal in this box"
          title="Open a terminal in this box"
        >
          <SquareTerminal />
        </Link>
      </Button>
    </header>
  );
}
