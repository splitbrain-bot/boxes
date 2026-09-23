import { Link } from 'react-router';
import type { HarnessHealth } from '../../../shared/types.ts';
import { Notice } from '@/components/Notice';
import { useBoxes } from '../stores/boxes.ts';

/**
 * One line per harness that cannot run a turn.
 *
 * A box still starts and the dashboard still works without a credential; only
 * an agent turn fails, and not until somebody sends a prompt. Saying so up
 * front is the whole point, and saying which agent it is about is what makes
 * it actionable on a deployment that runs more than one.
 *
 * Renders nothing while every harness is fine — including before the first
 * health probe has answered, since nothing is known to be wrong then.
 */
export function TokenWarning({ className }: { className?: string }) {
  const { harnesses } = useBoxes();
  const broken = harnesses.filter((h) => !h.runnable);
  if (broken.length === 0) return null;

  return (
    <Notice tone="warn" className={className}>
      {broken.map((h) => (
        <p key={h.id}>
          {reason(h)}{' '}
          <Link className="underline" to="/settings">
            Settings
          </Link>{' '}
          is where its credential is entered.
        </p>
      ))}
    </Notice>
  );
}

/** Why this harness cannot run, in the terms the settings page uses. */
function reason(harness: HarnessHealth): string {
  const { credential } = harness;
  if (!credential) return `No credential is set for ${harness.label}, so its threads cannot run.`;
  if (credential.status === 'expired') {
    return `${harness.label}'s credential has expired, so its threads cannot run.`;
  }
  return `${harness.label}'s credential is failing${
    credential.lastError ? `: ${credential.lastError}` : ''
  }.`;
}
