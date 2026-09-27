import { Link } from 'react-router';
import type { HarnessHealth } from '../../../shared/types.ts';
import { Notice } from '@/components/Notice';
import { useBoxes } from '../stores/boxes.ts';

/**
 * Warning with one line per harness that cannot run a turn.
 *
 * Without a credential only the agent turn fails, at the first prompt, so the
 * warning says so up front. It renders nothing while every harness can run,
 * and before the first health probe answers.
 *
 * @param className Layout classes from the caller.
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

/**
 * Explains why a harness cannot run, in the terms the settings page uses.
 *
 * @param harness The harness.
 * @returns One sentence.
 */
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
