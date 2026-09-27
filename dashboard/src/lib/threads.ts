import type { ThreadSummary } from '../../../shared/types.ts';

/**
 * What a thread is called: its title, or "Thread" and its number when it has
 * no title yet.
 */
export function threadName(thread: ThreadSummary): string {
  return thread.title?.trim() || `Thread ${thread.ordinal}`;
}
