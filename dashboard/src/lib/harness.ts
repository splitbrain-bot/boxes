import type { HarnessHealth, HarnessId, SessionModeState } from '../../../shared/types.ts';

/**
 * What the dashboard knows about a harness beyond what the API sends it.
 *
 * Almost nothing, deliberately: the label, the defaults and the catalogue all
 * come from `GET /api/harnesses`, because the registry is the orchestrator's
 * and a second copy of it here would be a second thing to keep in step. What
 * is left is what only a reader needs — why a harness cannot run, said in
 * three words rather than a sentence, and the one caveat a mode carries that
 * no adapter can know about itself.
 */

/**
 * Codex modes whose sandbox a hardened container is likely to refuse.
 *
 * Both run every command under bubblewrap, which needs unprivileged user
 * namespaces that a box with `CapDrop: ALL` and Docker's default seccomp
 * profile very likely does not grant (PLAN.md section 3, verify step 3). The
 * adapter advertises them regardless — it cannot know what the container it
 * was started in allows — so the picker offers them and says so, rather than
 * hiding a mode that may well work on somebody's deployment.
 */
const SANDBOXED_CODEX_MODES: ReadonlySet<string> = new Set(['read-only', 'agent']);

/** The caveat itself, in the words the plan settled on. */
export const MAY_BE_UNAVAILABLE = 'May be unavailable in this deployment.';

/** Whether a mode carries that caveat. */
function modeIsDoubtful(harness: HarnessId | null, modeId: string): boolean {
  return harness === 'codex' && SANDBOXED_CODEX_MODES.has(modeId);
}

/** One of an adapter's modes, as both the catalogue and a live thread carry it. */
type Mode = SessionModeState['availableModes'][number];

/**
 * What a mode is called in the picker.
 *
 * The adapter's own name, which says what the mode does — "Ask for approval"
 * rather than `read-only` — with the deployment's caveat appended where there
 * is one. Falls back to the id for an adapter that names nothing, which is
 * worse than the name and better than an empty row.
 */
export function modeLabel(harness: HarnessId | null, mode: Mode): string {
  const name = mode.name ?? mode.id;
  return modeIsDoubtful(harness, mode.id) ? `${name} (may be unavailable here)` : name;
}

/** What the picker says the mode does, with the caveat spelled out under it. */
export function modeDescription(harness: HarnessId | null, mode: Mode): string | null {
  const doubtful = modeIsDoubtful(harness, mode.id);
  if (!doubtful) return mode.description ?? null;
  return mode.description ? `${mode.description} ${MAY_BE_UNAVAILABLE}` : MAY_BE_UNAVAILABLE;
}

/**
 * Why this harness cannot run a turn, in the fewest words that are still an
 * instruction. Null when it can.
 *
 * The same three cases the settings page describes at length, shortened to
 * what fits beside a greyed-out agent in a dialog.
 */
export function unavailableReason(harness: HarnessHealth): string | null {
  if (harness.runnable) return null;
  const { credential } = harness;
  if (!credential) return 'no credential';
  if (credential.status === 'expired') return 'credential expired';
  if (credential.status === 'failing') return 'credential failing';
  // Runnable is the orchestrator's answer and this is only its reason, so a
  // credential that looks fine and a harness that says it is not means the
  // reason is something this build has not heard of.
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
