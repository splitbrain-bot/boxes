/**
 * Display helpers for harnesses. The orchestrator sends the labels, defaults
 * and catalogues.
 */

import type { HarnessHealth, HarnessId, ThreadModeState } from '../../../shared/types.ts';

/**
 * True when the settings page offers the Codex login.
 *
 * The orchestrator can run the login and store its result. The credential
 * cannot run a turn, because its traffic goes to `chatgpt.com`, which the proxy
 * does not intercept. While the flag is false, the card offers only the API key.
 */
export const CODEX_LOGIN_OFFERED = false;

/**
 * Codex modes whose sandbox cannot start in a box container.
 *
 * Both run every command under bubblewrap, which needs an unprivileged user
 * namespace. The box container cannot create one. Docker's default seccomp
 * profile allows a new user namespace only with `CAP_SYS_ADMIN`, and
 * `CapDrop: ALL` leaves the container without capabilities.
 *
 * The picker still offers them, with a caveat worded as a doubt, because the
 * adapter cannot know the container that it runs in.
 */
const SANDBOXED_CODEX_MODES: ReadonlySet<string> = new Set(['read-only', 'agent']);

/** The caveat that the picker shows beside the sandboxed Codex modes. */
export const MAY_BE_UNAVAILABLE = 'May be unavailable in this deployment.';

/**
 * Checks if a mode gets the {@link MAY_BE_UNAVAILABLE} caveat.
 *
 * @param harness The harness of the thread, or null when it is not known.
 * @param modeId The id of the mode.
 * @returns True for a sandboxed Codex mode.
 */
function modeIsDoubtful(harness: HarnessId | null, modeId: string): boolean {
  return harness === 'codex' && SANDBOXED_CODEX_MODES.has(modeId);
}

/** One mode of an adapter, in the shape that the catalogue and a live thread both use. */
type Mode = ThreadModeState['availableModes'][number];

/**
 * Gives the label of a mode in the picker. The label is the name from the
 * adapter, or the id when the adapter gives no name, with a short caveat for a
 * doubtful mode.
 *
 * @param harness The harness of the thread, or null when it is not known.
 * @param mode The mode.
 * @returns The label.
 */
export function modeLabel(harness: HarnessId | null, mode: Mode): string {
  const name = mode.name ?? mode.id;
  return modeIsDoubtful(harness, mode.id) ? `${name} (may be unavailable here)` : name;
}

/**
 * Gives the description of a mode in the picker, with the caveat appended for a doubtful mode.
 *
 * @param harness The harness of the thread, or null when it is not known.
 * @param mode The mode.
 * @returns The description, or null when there is none.
 */
export function modeDescription(harness: HarnessId | null, mode: Mode): string | null {
  const doubtful = modeIsDoubtful(harness, mode.id);
  if (!doubtful) return mode.description ?? null;
  return mode.description ? `${mode.description} ${MAY_BE_UNAVAILABLE}` : MAY_BE_UNAVAILABLE;
}

/**
 * Gives the reason why a harness cannot run a turn, in a few words that fit
 * beside a disabled agent in a dialog.
 *
 * @param harness The harness as the health probe reports it.
 * @returns The reason, or null when the harness can run.
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

/**
 * Gives the label of the harness of a thread.
 *
 * @param harnesses The harnesses of the deployment.
 * @param id The harness of the thread.
 * @returns The label, or null while the harness is not known.
 */
export function harnessLabel(
  harnesses: readonly HarnessHealth[],
  id: HarnessId | null | undefined,
): string | null {
  if (!id) return null;
  return harnesses.find((harness) => harness.id === id)?.label ?? null;
}
