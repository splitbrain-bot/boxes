import type { HarnessId, SessionConfigOption, SessionModeState } from '../../../shared/types.ts';
import { modeDescription, modeLabel } from '@/lib/harness';
import { cn } from '@/lib/utils';

/**
 * The controls an agent's settings are set with, wherever they are set.
 *
 * Two places ask the same questions of a thread — the header of one that
 * exists, and the dialog that starts one — and they have to look and behave
 * the same, because they are the same question. The difference is only where
 * the answers come from: the header reads what this thread's adapter is
 * advertising right now, and the dialog reads what that harness's adapter
 * advertised last (the catalogue). Both shapes are the ACP ones in
 * `shared/types.ts`, so one set of controls serves both.
 *
 * Native selects rather than rows of buttons or a styled listbox: six modes
 * are longer than a phone is wide, and the native control opens the
 * platform's own picker and brings its keyboard and screen-reader behaviour
 * with it.
 */

/** The classes every select here shares, so the two views cannot drift. */
const SELECT = 'min-w-0 rounded-md border bg-muted px-2 py-1 text-xs';

/**
 * Whether an option is one these controls can put a control on.
 *
 * A select with something to choose between. The adapter may advertise other
 * kinds — it has a boolean form of some options for clients that ask for one,
 * which this one does not — and an option with a single value is not a
 * choice.
 */
export function isSelectable(option: SessionConfigOption): boolean {
  return (option.type ?? 'select') === 'select' && (option.options?.length ?? 0) > 1;
}

/** What to call an option whose adapter did not name it. */
export function optionName(option: SessionConfigOption): string {
  return option.name ?? option.id;
}

/**
 * One setting: what it is called, what it does, and the control. A label
 * rather than a heading and a control, so the whole block is the hit area —
 * these are read and set with a thumb.
 */
export function Setting({
  name,
  description,
  children,
}: {
  name: string;
  /** What the adapter says it does, when it says anything. */
  description?: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{name}</span>
      {description ? <span className="text-muted-foreground">{description}</span> : null}
      {children}
    </label>
  );
}

/** One config option as a native select. */
export function ConfigSelect({
  option,
  label,
  value,
  className,
  onSet,
}: {
  option: SessionConfigOption;
  /** What to call it. The adapter's own name, unless the caller has a better one. */
  label?: string;
  /**
   * What to show as chosen, for a caller holding the answer itself — the
   * dialog, whose thread does not exist yet and whose value is therefore not
   * on the option. The option's own `currentValue` when absent, which is what
   * a live thread's header wants.
   */
  value?: string;
  className?: string;
  onSet: (value: string) => void;
}) {
  const name = label ?? optionName(option);
  const chosen = value ?? option.currentValue ?? '';
  const current = option.options?.find((entry) => entry.value === chosen);
  return (
    <select
      aria-label={name}
      value={chosen}
      onChange={(event) => onSet(event.target.value)}
      title={current?.description ?? current?.name ?? option.description ?? name}
      className={cn(SELECT, className)}
    >
      {option.options?.map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.name ?? entry.value}
        </option>
      ))}
    </select>
  );
}

/**
 * The mode picker, with what each mode does said in its own words.
 *
 * The names and descriptions are the adapter's — a mode id is an internal
 * name and `agent-full-access` says nothing about what it permits — and the
 * one thing added to them is the deployment's own caveat: see `modeLabel`.
 */
export function ModeSelect({
  modes,
  harness,
  className,
  onSet,
}: {
  modes: SessionModeState;
  /** Whose modes these are, which is what the caveat depends on. */
  harness: HarnessId | null;
  className?: string;
  onSet: (modeId: string) => void;
}) {
  return (
    <select
      aria-label="Agent mode"
      value={modes.currentModeId}
      onChange={(event) => onSet(event.target.value)}
      className={cn(SELECT, className)}
    >
      {modes.availableModes.map((mode) => (
        <option key={mode.id} value={mode.id}>
          {modeLabel(harness, mode)}
        </option>
      ))}
    </select>
  );
}

/** What the mode picker says under its name: the current mode's own line. */
export function currentModeDescription(
  modes: SessionModeState | null | undefined,
  harness: HarnessId | null,
): string | null {
  const current = modes?.availableModes.find((mode) => mode.id === modes.currentModeId);
  return current ? modeDescription(harness, current) : null;
}
