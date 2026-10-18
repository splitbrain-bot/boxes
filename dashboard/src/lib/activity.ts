/** Words for the work a thread or a box has left running. */

/**
 * The label for a box with background work where there is room for one word
 * only, e.g., a card in the box list. The label has no count.
 */
export const JOBS = 'jobs';

/**
 * The badge label for the amount of background work that runs.
 *
 * @param count The number of tasks, or zero when the count is not known.
 * @returns "1 job", "3 jobs", or {@link JOBS} without a number.
 */
export function jobsLabel(count: number): string {
  if (count < 1) return JOBS;
  return count === 1 ? '1 job' : `${count} jobs`;
}

/**
 * The phrase for the number of commands that still run, e.g., "2 commands still running".
 *
 * @param count The number of commands.
 * @returns The phrase with the count.
 */
export function commandsRunning(count: number): string {
  return count === 1 ? '1 command still running' : `${count} commands still running`;
}
