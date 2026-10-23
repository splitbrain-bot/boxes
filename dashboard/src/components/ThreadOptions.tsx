import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ConfigSelect,
  currentModeDescription,
  isSelectable,
  ModeSelect,
  optionName,
  Setting,
} from '@/components/AgentSettings';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { unavailableReason } from '@/lib/harness';
import type {
  HarnessCatalog,
  HarnessId,
  HarnessInfo,
  ThreadConfigOption,
  ThreadDialogDefaults,
  ThreadOptions as ThreadOptionsBody,
} from '../../../shared/types.ts';
import { rememberDialog, useHarnesses } from '../stores/harnesses.ts';

/** The state of the thread options block, held by the hook and rendered by the component. */
export interface ThreadOptionsState {
  /** Every harness, or null while the list is still loading. */
  harnesses: HarnessInfo[] | null;
  /** The chosen harness, or null while nothing has loaded. */
  chosen: HarnessInfo | null;
  /** The error of the last load, or null. */
  error: string | null;
  /**
   * True when the harness list has loaded or failed. Callers hold their submit
   * until then, because an earlier submit would start the thread on the
   * default agent of the orchestrator.
   */
  ready: boolean;
  /** The mode chosen, or null for a harness whose catalogue has no modes. */
  modeId: string | null;
  /** Every other setting, by the id that the adapter gives it. */
  config: Record<string, string>;
  /** The options for a create request, or null while nothing is chosen. */
  value: ThreadOptionsBody | null;
  /** Picks a harness and resets the mode and settings to its start values. */
  setHarness: (id: HarnessId) => void;
  /** Picks a mode. */
  setMode: (modeId: string) => void;
  /** Sets one config option by its id. */
  setConfig: (optionId: string, value: string) => void;
  /**
   * Stores the choice as the dialog default of this harness, so the next dialog on
   * any device opens on it. Callers call it once the thread exists.
   */
  remember: () => void;
}

/**
 * Returns the start values for a harness. The choice of the last dialog for the
 * harness overrides the defaults of the registry.
 *
 * With the merge, an option that the adapter added after the last choice gets
 * its default value.
 *
 * @param info The harness.
 * @param saved The choice of the last dialog for the harness, if any.
 * @returns The mode, or null without modes, and the config values.
 */
function prefill(
  info: HarnessInfo,
  saved: ThreadDialogDefaults | undefined,
): { modeId: string | null; config: Record<string, string> } {
  const modes = info.catalog?.modes;
  const offered = (id: string | undefined): boolean =>
    id !== undefined && (modes?.availableModes.some((mode) => mode.id === id) ?? false);
  const modeId = !modes
    ? null
    : offered(saved?.modeId)
      ? (saved?.modeId ?? null)
      : offered(info.defaultModeId)
        ? info.defaultModeId
        : modes.currentModeId;
  return { modeId, config: { ...info.defaultConfig, ...saved?.config } };
}

/**
 * Holds the state of the block, connected to the harness store.
 *
 * @returns The state for {@link ThreadOptions}.
 */
export function useThreadOptions(): ThreadOptionsState {
  const { harnesses, dialogs, error } = useHarnesses();
  const [harnessId, setHarnessId] = useState<HarnessId | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [config, setConfigMap] = useState<Record<string, string>>({});

  const chosen = harnesses?.find((harness) => harness.id === harnessId) ?? null;

  const choose = useCallback((info: HarnessInfo, saved: ThreadDialogDefaults | undefined) => {
    const start = prefill(info, saved);
    setHarnessId(info.id);
    setModeId(start.modeId);
    setConfigMap(start.config);
  }, []);

  // The first harness list picks the first harness that can run. An agent
  // without a working credential fails at its first prompt. When none can
  // run, the first harness is still chosen.
  useEffect(() => {
    if (!harnesses || harnessId !== null) return;
    const first = harnesses.find((harness) => harness.runnable) ?? harnesses[0];
    if (first) choose(first, dialogs[first.id]);
  }, [harnesses, harnessId, dialogs, choose]);

  const setHarness = useCallback(
    (id: HarnessId) => {
      const info = harnesses?.find((harness) => harness.id === id);
      // Modes and models belong to one adapter, so a switch starts from the
      // values of the new harness.
      if (info) choose(info, dialogs[info.id]);
    },
    [harnesses, dialogs, choose],
  );

  const setConfig = useCallback((optionId: string, value: string) => {
    setConfigMap((previous) => ({ ...previous, [optionId]: value }));
  }, []);

  const value = useMemo<ThreadOptionsBody | null>(() => {
    if (!chosen) return null;
    return {
      harness: chosen.id,
      ...(modeId ? { modeId } : {}),
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  }, [chosen, modeId, config]);

  const remember = useCallback(() => {
    if (!chosen) return;
    void rememberDialog(chosen.id, { ...(modeId ? { modeId } : {}), config });
  }, [chosen, modeId, config]);

  return {
    harnesses,
    chosen,
    error,
    ready: harnesses !== null || error !== null,
    modeId,
    config,
    value,
    setHarness,
    setMode: setModeId,
    setConfig,
    remember,
  };
}

/**
 * Returns the value a select shows for one option.
 *
 * The choice of the block wins while the adapter offers it. Otherwise the
 * current value of the adapter or the first offered value keeps the select from
 * showing nothing, for example after the adapter dropped a model.
 *
 * @param option The config option.
 * @param config The chosen values of the block.
 * @returns The value to select, or an empty string without choices.
 */
function selectedValue(option: ThreadConfigOption, config: Record<string, string>): string {
  const offered = (value: string | undefined): boolean =>
    value !== undefined && (option.options?.some((entry) => entry.value === value) ?? false);
  const chosen = config[option.id];
  if (offered(chosen)) return chosen as string;
  if (offered(option.currentValue)) return option.currentValue as string;
  return option.options?.[0]?.value ?? '';
}

/**
 * Returns the options that the block shows for a harness, the model first.
 *
 * The other options come from the options that the catalogue recorded for the
 * selected model. Without a record, the cached options apply only to the model
 * of the last answer. A harness without a model option shows the cached
 * options.
 *
 * @param catalog The catalogue of the harness, or null when it has none.
 * @param config The chosen values of the block.
 * @returns The options to show.
 */
function shownOptions(
  catalog: HarnessCatalog | null,
  config: Record<string, string>,
): ThreadConfigOption[] {
  // The mode goes through session/set_mode, so the block leaves out its option.
  const shown = (option: ThreadConfigOption): boolean =>
    option.category !== 'mode' && option.category !== 'model' && isSelectable(option);
  const cached = catalog?.configOptions ?? [];
  // Each adapter picks its own option ids, so the block finds the model by its category.
  const model = cached.find((option) => option.category === 'model' && isSelectable(option));
  if (!model) return cached.filter(shown);
  const selected = selectedValue(model, config);
  const recorded = catalog?.modelOptions[selected];
  const others = recorded ?? (selected === model.currentValue ? cached : []);
  return [model, ...others.filter(shown)];
}

/**
 * Block that picks the agent and its settings for a new thread.
 *
 * The modes and options come from the harness catalogue. The orchestrator
 * caches what the adapter advertised the last time it ran. A value chosen here
 * is a request. The adapter can reject it when the orchestrator sets it on the
 * new thread.
 *
 * @param state The state from `useThreadOptions`.
 */
export function ThreadOptions({ state }: { state: ThreadOptionsState }) {
  const { harnesses, chosen, config } = state;

  if (!harnesses) {
    return state.error ? (
      <Notice className="rounded-md border px-3 py-2 text-xs">{state.error}</Notice>
    ) : (
      <p className="text-xs text-muted-foreground">Loading agents…</p>
    );
  }

  // The cached `currentModeId` comes from the last answer of the adapter, so the
  // choice of the block replaces it.
  const cached = chosen?.catalog?.modes ?? null;
  const modes = cached ? { ...cached, currentModeId: state.modeId ?? cached.currentModeId } : null;
  const hasModes = (modes?.availableModes.length ?? 0) > 1;
  const ordered = shownOptions(chosen?.catalog ?? null, config);

  return (
    <div className="flex flex-col gap-3">
      {/* A harness that cannot run stays in the list, disabled, with its reason. */}
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Agent</span>
        <fieldset aria-label="Agent" className="flex flex-wrap gap-1.5">
          {harnesses.map((harness) => {
            const reason = unavailableReason(harness);
            return (
              <Button
                key={harness.id}
                type="button"
                size="sm"
                variant={harness.id === chosen?.id ? 'default' : 'outline'}
                aria-pressed={harness.id === chosen?.id}
                disabled={reason !== null}
                onClick={() => state.setHarness(harness.id)}
              >
                {harness.label}
                {reason ? <span className="font-normal opacity-80">· {reason}</span> : null}
              </Button>
            );
          })}
        </fieldset>
      </div>

      {/* The mode comes next, because it decides what the agent may do without asking. */}
      {modes && hasModes ? (
        <Setting name="Agent mode" description={currentModeDescription(modes, chosen?.id ?? null)}>
          <ModeSelect
            modes={modes}
            harness={chosen?.id ?? null}
            className="mt-0.5 py-1.5"
            onSet={state.setMode}
          />
        </Setting>
      ) : null}

      {/* The model list can be long, so a combobox filters it. */}
      {ordered.map((option) => (
        <Setting key={option.id} name={optionName(option)} description={option.description}>
          {option.category === 'model' ? (
            <Combobox
              label={optionName(option)}
              options={option.options ?? []}
              value={selectedValue(option, config)}
              className="mt-0.5 py-1.5"
              onSelect={(value) => state.setConfig(option.id, value)}
            />
          ) : (
            <ConfigSelect
              option={option}
              value={selectedValue(option, config)}
              className="mt-0.5 py-1.5"
              onSet={(value) => state.setConfig(option.id, value)}
            />
          )}
        </Setting>
      ))}

      {/* A harness that has never run here has no cached catalogue. */}
      {chosen && !chosen.catalog ? (
        <p className="text-xs text-muted-foreground">
          {chosen.label} has not run here yet, so its modes and models are not known. The thread
          starts on its defaults, and its settings are on its own header afterwards.
        </p>
      ) : null}
    </div>
  );
}
