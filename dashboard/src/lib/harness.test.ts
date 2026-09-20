import { describe, expect, test } from 'vitest';
import type { HarnessHealth } from '../../../shared/types.ts';
import { MAY_BE_UNAVAILABLE, harnessLabel, modeDescription, modeLabel, unavailableReason } from './harness.ts';

/**
 * The little the dashboard knows about a harness on its own.
 *
 * Everything else comes from the API; what is worth a test here is the one
 * thing that does not — the caveat on Codex's two sandboxed modes, which no
 * adapter can say about itself because it is a fact about the container the
 * deployment runs it in.
 */

/** A harness as the health probe reports one. */
function health(over: Partial<HarnessHealth> = {}): HarnessHealth {
  return {
    id: 'claude',
    label: 'Claude Code',
    credential: null,
    runnable: false,
    ...over,
  };
}

describe('mode labels', () => {
  test('say what the mode does, in the adapter’s own words', () => {
    expect(modeLabel('claude', { id: 'plan', name: 'Plan' })).toBe('Plan');
    expect(modeDescription('claude', { id: 'plan', name: 'Plan', description: 'Reads only.' })).toBe(
      'Reads only.',
    );
  });

  test('fall back to the id for an adapter that names nothing', () => {
    expect(modeLabel('claude', { id: 'acceptEdits' })).toBe('acceptEdits');
    expect(modeDescription('claude', { id: 'acceptEdits' })).toBeNull();
  });

  test('warn on the two Codex modes whose sandbox a hardened box may refuse', () => {
    expect(modeLabel('codex', { id: 'read-only', name: 'Ask for approval' })).toContain(
      'may be unavailable here',
    );
    expect(modeLabel('codex', { id: 'agent', name: 'Approve for me' })).toContain(
      'may be unavailable here',
    );
    // The one that needs no sandbox is offered without a caveat.
    expect(modeLabel('codex', { id: 'agent-full-access', name: 'Full access' })).toBe('Full access');
    expect(
      modeDescription('codex', { id: 'read-only', name: 'Ask for approval', description: 'Asks.' }),
    ).toBe(`Asks. ${MAY_BE_UNAVAILABLE}`);
    // The sentence stands on its own where the adapter described nothing.
    expect(modeDescription('codex', { id: 'agent' })).toBe(MAY_BE_UNAVAILABLE);
  });

  test('are not applied to another harness that happens to share an id', () => {
    expect(modeLabel('claude', { id: 'read-only', name: 'Read only' })).toBe('Read only');
    expect(modeLabel(null, { id: 'agent', name: 'Agent' })).toBe('Agent');
  });
});

describe('why a harness cannot run', () => {
  test('is nothing at all when it can', () => {
    expect(unavailableReason(health({ runnable: true }))).toBeNull();
  });

  test('names the credential, in the fewest words that are still an instruction', () => {
    expect(unavailableReason(health())).toBe('no credential');
    const stored = {
      id: 'claude' as const,
      method: 'token' as const,
      account: '1234',
      lastError: null,
      expiresAt: null,
      refreshedAt: null,
      updatedAt: 0,
    };
    expect(unavailableReason(health({ credential: { ...stored, status: 'expired' } }))).toBe(
      'credential expired',
    );
    expect(unavailableReason(health({ credential: { ...stored, status: 'failing' } }))).toBe(
      'credential failing',
    );
    // A credential that looks fine on a harness that says it cannot run means
    // a reason this build has not heard of, which is still not runnable.
    expect(unavailableReason(health({ credential: { ...stored, status: 'ok' } }))).toBe(
      'cannot run',
    );
  });
});

describe('the label on a thread', () => {
  test('is the deployment’s own name for the agent', () => {
    expect(harnessLabel([health(), health({ id: 'codex', label: 'Codex' })], 'codex')).toBe('Codex');
  });

  test('is null while nothing has said, rather than an id nobody recognises', () => {
    expect(harnessLabel([], 'claude')).toBeNull();
    expect(harnessLabel([health()], null)).toBeNull();
  });
});
