import type { ThreadSummary } from '../../../shared/types.ts';

/**
 * What a thread is called.
 *
 * The agent generates a title at the end of a turn, so a thread that has
 * never been prompted has none. Until then it goes by its ordinal, which is
 * per session and never reused, so the name a thread is given first is the
 * name it keeps.
 */
export function threadName(thread: ThreadSummary): string {
  return thread.title?.trim() || `Thread ${thread.ordinal}`;
}
