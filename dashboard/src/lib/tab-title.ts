/** Browser tab titles that show what a thread needs from the reader. */

/** The state that a tab shows, most urgent first. */
export type TabState = 'permission' | 'question' | 'running' | 'waiting' | 'idle';

/**
 * The symbol for each state.
 *
 * Plain BMP glyphs, not emoji, because every platform has them in a system
 * font.
 */
const SYMBOL: Record<TabState, string> = {
  permission: '⚠',
  question: '?',
  running: '⟳',
  // The agent is quiet, but work still runs. The ring is filled, and the idle ring is empty.
  waiting: '◍',
  idle: '○',
};

/**
 * Builds the tab title of a thread, with the state symbol, the box name and the thread
 * label.
 *
 * The symbol comes first, because a narrow tab still shows the start of its
 * title. The box comes before the thread, as in the thread's header.
 *
 * @param state The state of the thread.
 * @param boxName The name of the box.
 * @param threadLabel The label of the thread, or null when it has none.
 * @returns The tab title.
 */
export function threadTitle(state: TabState, boxName: string, threadLabel: string | null): string {
  const where = [boxName, threadLabel].filter(Boolean).join(' · ');
  return `${SYMBOL[state]} ${where}`;
}
