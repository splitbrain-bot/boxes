import type { ThreadSummary } from '../../../shared/types.ts';

/**
 * Gives the name of a thread. The name is the title, or "Thread" and the
 * thread number when the thread has no title yet.
 *
 * @param thread The thread.
 * @returns The name.
 */
export function threadName(thread: ThreadSummary): string {
  return thread.title?.trim() || `Thread ${thread.ordinal}`;
}
