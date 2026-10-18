/**
 * Controls for the mode and the config options of an agent. The thread header and the thread options block use
 * them.
 */
import { modeDescription, modeLabel } from '@/lib/harness';
import { cn } from '@/lib/utils';
import type { HarnessId, ThreadConfigOption, ThreadModeState } from '../../../shared/types.ts';

/** The classes every select here shares. */
const SELECT = 'min-w-0 rounded-md border bg-muted px-2 py-1 text-xs';

/**
 * Checks if an option is a select with more than one value.
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
 * so a click anywhere on it reaches the control.
 *
 * @param name The name of the setting.
 * @param description The description from the adapter, if any.
 * @param children The control.
 */
export function Setting({
  name,
  description,
  children,
}: {
  /** The name of the setting. */
  name: string;
  /** The description from the adapter, if any. */
  description?: string | null | undefined;
  /** The control. */
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the children
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{name}</span>
      {description ? <span className="text-muted-foreground">{description}</span> : null}
      {children}
    </label>
  );
}

/**
 * One config option as a native select. A native select opens the picker of the
 * platform, which fits a phone.
 *
 * @param option The config option.
 * @param label The name to show. The default is the name from the adapter.
 * @param value The chosen value, for a caller that holds it. The default is the `currentValue` of the option.
 * @param className Extra classes for the select.
 * @param onSet Called with the value that the user picked.
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
  /** The name to show. The default is the name from the adapter. */
  label?: string;
  /**
   * The chosen value, for a caller that holds it, such as the thread options
   * block. The default is the `currentValue` of the option.
   */
  value?: string;
  /** Extra classes for the select. */
  className?: string;
  /** Called with the value that the user picked. */
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
 * It shows the mode names from the adapter, with a caveat on each mode that
 * may be unavailable in this deployment.
 *
 * @param modes The available modes and the current one.
 * @param harness The harness that the modes belong to.
 * @param className Extra classes for the select.
 * @param onSet Called with the mode id that the user picked.
 */
export function ModeSelect({
  modes,
  harness,
  className,
  onSet,
}: {
  /** The available modes and the current one. */
  modes: ThreadModeState;
  /** The harness that the modes belong to. The caveat depends on it. */
  harness: HarnessId | null;
  /** Extra classes for the select. */
  className?: string;
  /** Called with the mode id that the user picked. */
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
 * Returns the description of the current mode, to show below the name of the picker.
 *
 * @param modes The mode state, if any.
 * @param harness The harness that the modes belong to.
 * @returns The description, or null when there is none.
 */
export function currentModeDescription(
  modes: ThreadModeState | null | undefined,
  harness: HarnessId | null,
): string | null {
  const current = modes?.availableModes.find((mode) => mode.id === modes.currentModeId);
  return current ? modeDescription(harness, current) : null;
}
