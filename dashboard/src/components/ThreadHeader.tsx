import {
  ArrowLeft,
  CircleCheck,
  FileSearch,
  GitBranch,
  SlidersHorizontal,
  SquareTerminal,
} from 'lucide-react';
import { Link } from 'react-router';
import {
  ConfigSelect,
  currentModeDescription,
  isSelectable,
  ModeSelect,
  optionName,
  Setting,
} from '@/components/AgentSettings';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Up } from '@/hooks/use-up';
import { cn } from '@/lib/utils';
import type { HarnessId } from '../../../shared/types.ts';
import type { ConnectionState } from '../stores/thread/acp-client.ts';
import type { ThreadConfigOption, ThreadModeState } from '../stores/thread/acp-types.ts';

/** The label and the colour of the connection dot for each connection state. */
const CONNECTION: Record<ConnectionState, { label: string; dot: string }> = {
  connecting: { label: 'connecting', dot: 'bg-warn animate-pulse' },
  ready: { label: 'connected', dot: 'bg-ok' },
  reconnecting: { label: 'reconnecting', dot: 'bg-warn animate-pulse' },
  closed: { label: 'disconnected', dot: 'bg-idle' },
};

/**
 * The header of the thread page.
 *
 * @param boxId The box id, for the review and terminal links.
 * @param threadId The thread id, which the review link carries so that the review leads back here.
 * @param up The parent route and the step-out handlers.
 * @param name The name of the box.
 * @param threadLabel The name of the thread, or null while the thread is unknown.
 * @param harness The harness of the thread, or null while the thread is unknown.
 * @param harnessLabel The name of the harness for the reader, or null.
 * @param connection The connection state, which the dot shows.
 * @param modes The modes of the adapter, or null when it offers none.
 * @param configOptions The config options of the adapter.
 * @param done True when the reader has marked this thread as done.
 * @param canFork True when the adapter of the thread advertised the fork capability.
 * @param forking True while a fork is in flight.
 * @param onFork Forks the thread.
 * @param onSetDone Sets the mark, or takes it off. Absent while there is no thread to mark.
 * @param onSetMode Sets the mode of the thread.
 * @param onSetConfigOption Sets one config option of the thread.
 */
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
  /** The thread id, which the review link carries so that the review leads back here. */
  threadId: string | null;
  /** The parent route and the step-out handlers. */
  up: Up;
  /** The name of the box. */
  name: string;
  /** The name of the thread, or null while the thread is unknown. */
  threadLabel: string | null;
  /**
   * The harness of the thread, or null while the thread is unknown. It decides the
   * caveat on a mode.
   */
  harness: HarnessId | null;
  /** The name of the harness for the reader, or null. */
  harnessLabel: string | null;
  /** The connection state, which the dot shows. */
  connection: ConnectionState;
  /** The modes of the adapter, or null when it offers none. */
  modes: ThreadModeState | null;
  /** The config options of the adapter. */
  configOptions: readonly ThreadConfigOption[];
  /** True when the reader has marked this thread as done. */
  done: boolean;
  /** True when the adapter of the thread advertised the fork capability. */
  canFork: boolean;
  /** True while a fork is in flight. A double tap then cannot fork twice. */
  forking: boolean;
  /** Forks the thread. */
  onFork: () => void;
  /** Sets the mark, or takes it off. Absent while there is no thread to mark. */
  onSetDone?: (done: boolean) => void;
  /** Sets the mode of the thread. */
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
    (option) => option !== model && option.category !== 'mode' && isSelectable(option),
  );

  // All settings sit behind one button, because they do not fit the header on a phone.
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
          {/* The name of the box keeps up to two thirds of the line. The name
              of the thread truncates first. */}
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

      {/* The fork is a new thread beside this thread. */}
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
          // The back link and the handoff of the review return to this thread.
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
