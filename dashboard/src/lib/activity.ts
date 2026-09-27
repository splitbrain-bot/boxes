/** Words for the work a thread or a box has left running. */

/**
 * What a box with work still running is called where there is only room for a
 * phrase, such as a card in the box list. It carries no count.
 */
export const STILL_RUNNING = 'still running';

/** The number of commands still running, as a phrase: "2 commands still running". */
export function commandsRunning(count: number): string {
  return count === 1 ? '1 command still running' : `${count} commands still running`;
}
