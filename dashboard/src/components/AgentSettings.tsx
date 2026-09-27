import type { HarnessId, ThreadConfigOption, ThreadModeState } from '../../../shared/types.ts';
import { modeDescription, modeLabel } from '@/lib/harness';
import { cn } from '@/lib/utils';

/**
 * Controls for an agent's mode and config options, shared by the thread header
 * and the new-thread block.
 */

/** The classes every select here shares. */
const SELECT = 'min-w-0 rounded-md border bg-muted px-2 py-1 text-xs';

/**
 * Whether an option is a select with more than one value.
 *
 * @param option The config option.
 * @returns True when the option offers a choice.
 */
export function isSelectable(option: ThreadConfigOption): boolean {
  return (option.type ?? 'select') === 'select' && (option.options?.length ?? 0) > 1;
}

/**
 * Returns the name of an option, or its id when the adapter gave no name.
 *
 * @param option The config option.
 * @returns The name to show.
 */
export function optionName(option: ThreadConfigOption): string {
  return option.name ?? option.id;
}

/**
 * One setting with its name, description and control. The block is a label,
 * so the whole block is the hit area.
 */
export function Setting({
  name,
  description,
  children,
}: {
  /** The setting's name. */
  name: string;
  /** What the adapter says it does, when it says anything. */
  description?: string | null | undefined;
  /** The control. */
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

/**
 * One config option as a native select. A native select opens the platform's
 * own picker, which fits a phone.
 */
export function ConfigSelect({
  option,
  label,
  value,
  className,
  onSet,
}: {
  /** The config option. */
  option: ThreadConfigOption;
  /** What to call it. The adapter's own name, unless the caller has a better one. */
  label?: string;
  /**
   * The chosen value, for a caller that holds it, such as the new-thread
   * block. The option's own `currentValue` when absent.
   */
  value?: string;
  /** Extra classes for the select. */
  className?: string;
  /** Called with the value the user picked. */
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
 * The mode picker as a native select.
 *
 * It shows the adapter's mode names, plus a caveat for a mode that may be
 * unavailable in this deployment.
 */
export function ModeSelect({
  modes,
  harness,
  className,
  onSet,
}: {
  /** The available modes and the current one. */
  modes: ThreadModeState;
  /** The harness the modes belong to. The caveat depends on it. */
  harness: HarnessId | null;
  /** Extra classes for the select. */
  className?: string;
  /** Called with the mode id the user picked. */
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

/**
 * Returns the description of the current mode, for under the picker's name.
 *
 * @param modes The mode state, if any.
 * @param harness The harness the modes belong to.
 * @returns The description, or null when there is none.
 */
export function currentModeDescription(
  modes: ThreadModeState | null | undefined,
  harness: HarnessId | null,
): string | null {
  const current = modes?.availableModes.find((mode) => mode.id === modes.currentModeId);
  return current ? modeDescription(harness, current) : null;
}
