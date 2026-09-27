import type { HarnessHealth, HarnessId, ThreadModeState } from '../../../shared/types.ts';

/**
 * Display helpers for harnesses. The orchestrator sends the labels, defaults
 * and catalogues.
 */

/**
 * Whether the settings page offers the Codex login.
 *
 * The orchestrator can run the login and store its result. That credential
 * cannot run a turn yet: its traffic goes to a host the proxy does not
 * intercept, so a box gets nothing. Until a box can receive an `auth.json` of
 * its own, the card offers the API key alone.
 */
export const CODEX_LOGIN_OFFERED = false;

/**
 * Codex modes whose sandbox a box refuses.
 *
 * Both run every command under bubblewrap, which needs an unprivileged user
 * namespace. A box cannot create one, because `CapDrop: ALL` removes
 * `CAP_SYS_ADMIN`.
 *
 * The picker still offers them, with a caveat worded as a doubt. The adapter
 * cannot know what container it runs in, and a later Codex or container
 * template may lift the limit.
 */
const SANDBOXED_CODEX_MODES: ReadonlySet<string> = new Set(['read-only', 'agent']);

/** The caveat shown beside those modes. */
export const MAY_BE_UNAVAILABLE = 'May be unavailable in this deployment.';

/** Whether a mode carries that caveat. */
function modeIsDoubtful(harness: HarnessId | null, modeId: string): boolean {
  return harness === 'codex' && SANDBOXED_CODEX_MODES.has(modeId);
}

/** One of an adapter's modes, as both the catalogue and a live thread carry it. */
type Mode = ThreadModeState['availableModes'][number];

/**
 * What a mode is called in the picker: the adapter's name for it, or its id
 * when the adapter gives none, with a short caveat for a doubtful mode.
 */
export function modeLabel(harness: HarnessId | null, mode: Mode): string {
  const name = mode.name ?? mode.id;
  return modeIsDoubtful(harness, mode.id) ? `${name} (may be unavailable here)` : name;
}

/** What the picker says the mode does, with the caveat appended for a doubtful mode. */
export function modeDescription(harness: HarnessId | null, mode: Mode): string | null {
  const doubtful = modeIsDoubtful(harness, mode.id);
  if (!doubtful) return mode.description ?? null;
  return mode.description ? `${mode.description} ${MAY_BE_UNAVAILABLE}` : MAY_BE_UNAVAILABLE;
}

/**
 * Why this harness cannot run a turn, in a few words that fit beside a
 * disabled agent in a dialog. Null when it can.
 */
export function unavailableReason(harness: HarnessHealth): string | null {
  if (harness.runnable) return null;
  const { credential } = harness;
  if (!credential) return 'no credential';
  if (credential.status === 'expired') return 'credential expired';
  if (credential.status === 'failing') return 'credential failing';
  // The orchestrator decides `runnable`, and it may have a reason this build
  // does not know.
  return 'cannot run';
}

/** What a thread's harness is called, or null while nothing has said. */
export function harnessLabel(
  harnesses: readonly HarnessHealth[],
  id: HarnessId | null | undefined,
): string | null {
  if (!id) return null;
  return harnesses.find((harness) => harness.id === id)?.label ?? null;
}
