/** Words for the work a thread or a box has left running. */

/**
 * What a box with background work is called where there is only room for a
 * word, such as a card in the box list. It carries no count.
 */
export const JOBS = 'jobs';

/**
 * How much background work something has running, as a badge label.
 *
 * @param count The pieces of work, or zero where they are not counted.
 * @returns "1 job", "3 jobs", or {@link JOBS} without a number.
 */
export function jobsLabel(count: number): string {
  if (count < 1) return JOBS;
  return count === 1 ? '1 job' : `${count} jobs`;
}

/** The number of commands still running, as a phrase: "2 commands still running". */
export function commandsRunning(count: number): string {
  return count === 1 ? '1 command still running' : `${count} commands still running`;
}
