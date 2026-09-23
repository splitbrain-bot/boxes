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

/**
 * What a conversation is started as: which agent runs it, and what that agent
 * is set to before its first prompt.
 *
 * One block, used by both dialogs — the one that adds a thread to a box and
 * the form that makes the box — because they ask the identical question and a
 * second copy would drift. A fork asks nothing: a transcript can only be
 * loaded by the adapter that wrote it, so a fork stays on its source's
 * harness and keeps its settings.
 *
 * Nothing here can ask an adapter what it offers, because the thread it would
 * ask about does not exist yet. What it offers instead is the catalogue: what
 * that harness's adapter advertised the last time one ran, cached by the
 * orchestrator. A harness whose adapter has never run in this deployment has
 * none, and then the agent choice is the whole of the block and the thread
 * starts on the registry's defaults — which is also why a value chosen here
 * is a request rather than a promise. The adapter's own answer corrects it on
 * the thread's first turn.
 *
 * The mode is not among the config options, although both adapters also echo
 * it as one: it travels through `session/set_mode` and the thread's `modeId`,
 * and a client that set both would put the thread in its mode twice.
 */

/** The block's state, held by the hook and rendered by the component. */
export interface ThreadOptionsState {
  /** Every harness, or null while the list is still loading. */
  harnesses: HarnessInfo[] | null;
  /** The one chosen, or null while nothing has loaded. */
  chosen: HarnessInfo | null;
  /** What the last load failed with, or null. */
  error: string | null;
  /**
   * Whether the block has an answer to give — a list, or a failure to read
   * one. A submit before that would create a thread on the orchestrator's
   * default agent rather than on the one the block is about to offer, so the
   * two callers hold their submit until this is true.
   */
  ready: boolean;
  /** The mode chosen, or null for a harness whose catalogue has no modes. */
  modeId: string | null;
  /** Every other setting, by the adapter's own id for it. */
  config: Record<string, string>;
  /** What a create request should carry, or null while nothing is chosen. */
  value: ThreadOptionsBody | null;
  setHarness: (id: HarnessId) => void;
  setMode: (modeId: string) => void;
  setConfig: (optionId: string, value: string) => void;
  /**
   * Writes the choice back as this harness's dialog default, so the next
   * dialog on any device opens on it. Called by the submit, not by every
   * change: what is remembered is what was started, not what was passed
   * through on the way to it.
   */
  remember: () => void;
}

/**
 * What a harness starts the block on: the last dialog's answer for it, over
 * the registry's defaults.
 *
 * Merged rather than replaced, so an option added to the adapter since the
 * last choice arrives at its default instead of missing.
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

/** Everything the block needs, wired to the harness store. */
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

  // The first answer picks the agent: the first that can run, because
  // offering a box an agent whose credential is missing is offering a thread
  // that fails at its first prompt. A deployment where none can run still
  // shows one chosen, so the block says what would happen rather than
  // nothing.
  useEffect(() => {
    if (!harnesses || harnessId !== null) return;
    const first = harnesses.find((harness) => harness.runnable) ?? harnesses[0];
    if (first) choose(first, dialogs[first.id]);
  }, [harnesses, harnessId, dialogs, choose]);

  const setHarness = useCallback(
    (id: HarnessId) => {
      const info = harnesses?.find((harness) => harness.id === id);
      // A mode and a model belong to one adapter and mean nothing to another,
      // so switching agents starts that agent's own answer over rather than
      // carrying this one's across.
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
 * What a select shows for one option.
 *
 * The block's own answer where it has one the adapter still offers; the
 * adapter's current value where it does not — a model that was dropped
 * between one thread and the next would otherwise leave a select with nothing
 * selected in it.
 */
function valueOf(option: ThreadConfigOption, config: Record<string, string>): string {
  const offered = (value: string | undefined): boolean =>
    value !== undefined && (option.options?.some((entry) => entry.value === value) ?? false);
  const chosen = config[option.id];
  if (offered(chosen)) return chosen as string;
  if (offered(option.currentValue)) return option.currentValue as string;
  return option.options?.[0]?.value ?? '';
}

/** The block itself. State comes from `useThreadOptions`; see above. */
export function ThreadOptions({ state }: { state: ThreadOptionsState }) {
  const { harnesses, chosen, config } = state;

  if (!harnesses) {
    return state.error ? (
      <Notice className="rounded-md border px-3 py-2 text-xs">{state.error}</Notice>
    ) : (
      <p className="text-xs text-muted-foreground">Loading agents…</p>
    );
  }

  // The catalogue's modes with the block's own answer in them: the cached
  // `currentModeId` is whatever the last thread of this harness was in, and
  // what the picker has to show is what this thread would start in.
  const cached = chosen?.catalog?.modes ?? null;
  const modes = cached ? { ...cached, currentModeId: state.modeId ?? cached.currentModeId } : null;
  const hasModes = (modes?.availableModes.length ?? 0) > 1;
  const options = (chosen?.catalog?.configOptions ?? []).filter(
    (option) => option.category !== 'mode' && isSelectable(option),
  );
  // The model first among them, by category rather than by id: what an option
  // is for is part of the protocol, the name the adapter gives it is not.
  const ordered = [
    ...options.filter((option) => option.category === 'model'),
    ...options.filter((option) => option.category !== 'model'),
  ];
  const blocked = harnesses.filter((harness) => !harness.runnable);

  return (
    <div className="flex flex-col gap-3">
      {/* Which agent, always — including on a deployment that runs one, where
          it is what the dialog says the thread will be. A harness whose
          credential is missing or broken is shown greyed out with the reason
          rather than left out: a list that silently loses an agent looks like
          a deployment that never had it. */}
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

      {/* The mode next: of everything here it is the one that decides what
          the agent may do without asking. */}
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

      {/* Then the model and whatever else the adapter offered the last time
          one ran — an effort level, a fast mode, anything a later version
          adds. Codex advertises its efforts per model, so what is offered
          here is what was last seen rather than what this model supports;
          the adapter corrects the thread on its first answer. */}
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

      {/* A deployment that has never run this agent has nothing cached to
          offer, and starting a box to find out would cost a container per
          dialog. The thread starts on the registry's defaults instead. */}
      {chosen && !chosen.catalog ? (
        <p className="text-xs text-muted-foreground">
          {chosen.label} has not run here yet, so its modes and models are not known. The thread
          starts on its defaults, and its settings are on its own header afterwards.
        </p>
      ) : null}
    </div>
  );
}
