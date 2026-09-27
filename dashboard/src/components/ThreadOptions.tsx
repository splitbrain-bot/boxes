import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type {
  HarnessId,
  HarnessInfo,
  ThreadConfigOption,
  ThreadDialogDefaults,
  ThreadOptions as ThreadOptionsBody,
} from '../../../shared/types.ts';
import {
  ConfigSelect,
  ModeSelect,
  Setting,
  currentModeDescription,
  isSelectable,
  optionName,
} from '@/components/AgentSettings';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { unavailableReason } from '@/lib/harness';
import { rememberDialog, useHarnesses } from '../stores/harnesses.ts';

/** The block's state, held by the hook and rendered by the component. */
export interface ThreadOptionsState {
  /** Every harness, or null while the list is still loading. */
  harnesses: HarnessInfo[] | null;
  /** The one chosen, or null while nothing has loaded. */
  chosen: HarnessInfo | null;
  /** What the last load failed with, or null. */
  error: string | null;
  /**
   * Whether the harness list has loaded or failed. Callers hold their submit
   * until then, because an earlier submit would start the thread on the
   * orchestrator's default agent.
   */
  ready: boolean;
  /** The mode chosen, or null for a harness whose catalogue has no modes. */
  modeId: string | null;
  /** Every other setting, by the adapter's own id for it. */
  config: Record<string, string>;
  /** What a create request should carry, or null while nothing is chosen. */
  value: ThreadOptionsBody | null;
  /** Picks a harness and resets the mode and settings to its start values. */
  setHarness: (id: HarnessId) => void;
  /** Picks a mode. */
  setMode: (modeId: string) => void;
  /** Sets one config option by its id. */
  setConfig: (optionId: string, value: string) => void;
  /**
   * Stores the choice as this harness's dialog default, so the next dialog on
   * any device opens on it. Callers call it once the thread exists.
   */
  remember: () => void;
}

/**
 * Returns the start values for a harness: the last dialog's choice for it,
 * laid over the registry's defaults.
 *
 * The merge gives an option that the adapter added since the last choice its
 * default value.
 *
 * @param info The harness.
 * @param saved The last dialog's choice for it, if any.
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

/** Holds the block's state, wired to the harness store. */
export function useThreadOptions(): ThreadOptionsState {
  const { harnesses, dialogs, error } = useHarnesses();
  const [harnessId, setHarnessId] = useState<HarnessId | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [config, setConfigMap] = useState<Record<string, string>>({});

  const chosen = harnesses?.find((harness) => harness.id === harnessId) ?? null;

  const choose = useCallback(
    (info: HarnessInfo, saved: ThreadDialogDefaults | undefined) => {
      const start = prefill(info, saved);
      setHarnessId(info.id);
      setModeId(start.modeId);
      setConfigMap(start.config);
    },
    [],
  );

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
      // Modes and models belong to one adapter, so a switch starts from the new
      // harness's own values.
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
 * The block's choice wins while the adapter still offers it. Otherwise the
 * adapter's current value or the first offered value keeps the select from
 * showing nothing, for example after a model was dropped.
 *
 * @param option The config option.
 * @param config The block's chosen values.
 * @returns The value to select, or an empty string without choices.
 */
function valueOf(option: ThreadConfigOption, config: Record<string, string>): string {
  const offered = (value: string | undefined): boolean =>
    value !== undefined && (option.options?.some((entry) => entry.value === value) ?? false);
  const chosen = config[option.id];
  if (offered(chosen)) return chosen as string;
  if (offered(option.currentValue)) return option.currentValue as string;
  return option.options?.[0]?.value ?? '';
}

/**
 * Block that picks the agent and its settings for a new thread.
 *
 * The modes and options come from the harness catalogue. The orchestrator
 * caches what the adapter advertised the last time it ran. A value chosen here
 * is a request, and the adapter corrects it on the thread's first turn.
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

  // The cached `currentModeId` is the last thread's mode, so the block's
  // choice replaces it.
  const cached = chosen?.catalog?.modes ?? null;
  const modes = cached ? { ...cached, currentModeId: state.modeId ?? cached.currentModeId } : null;
  const hasModes = (modes?.availableModes.length ?? 0) > 1;
  // The mode travels through `session/set_mode`, so its config option is left
  // out. Setting both would set the mode twice.
  const options = (chosen?.catalog?.configOptions ?? []).filter(
    (option) => option.category !== 'mode' && isSelectable(option),
  );
  // The model comes first, found by category, because the protocol defines
  // categories and each adapter picks its own ids.
  const ordered = [
    ...options.filter((option) => option.category === 'model'),
    ...options.filter((option) => option.category !== 'model'),
  ];
  const blocked = harnesses.filter((harness) => !harness.runnable);

  return (
    <div className="flex flex-col gap-3">
      {/* A harness that cannot run stays in the list, disabled, with its reason. */}
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Agent</span>
        <div role="group" aria-label="Agent" className="flex flex-wrap gap-1.5">
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
        </div>
        {blocked.length > 0 ? (
          <p className="text-muted-foreground">
            {blocked.map((harness) => harness.label).join(' and ')} cannot run a turn until a
            working credential is entered.{' '}
            <Link to="/settings" className="underline hover:text-foreground">
              Settings
            </Link>{' '}
            is where that happens.
          </p>
        ) : null}
      </div>

      {/* The mode comes next, because it decides what the agent may do without asking. */}
      {modes && hasModes ? (
        <Setting
          name="Agent mode"
          description={currentModeDescription(modes, chosen?.id ?? null)}
        >
          <ModeSelect
            modes={modes}
            harness={chosen?.id ?? null}
            className="mt-0.5 py-1.5"
            onSet={state.setMode}
          />
        </Setting>
      ) : null}

      {/* Codex advertises its efforts per model, so these show what was last
          seen, which can differ from what the chosen model supports. */}
      {ordered.map((option) => (
        <Setting key={option.id} name={optionName(option)} description={option.description}>
          <ConfigSelect
            option={option}
            value={valueOf(option, config)}
            className="mt-0.5 py-1.5"
            onSet={(value) => state.setConfig(option.id, value)}
          />
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
