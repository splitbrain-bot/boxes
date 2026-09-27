/** Browser tab titles that show what a thread needs from the reader. */

/** What a tab is doing, most urgent first. */
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
  // The agent is quiet, but work still runs: a filled ring beside the empty one.
  waiting: '◍',
  idle: '○',
};

/**
 * The title of a thread's tab: the state symbol, the box name and the thread
 * label.
 *
 * The symbol comes first, because a narrow tab still shows the start of its
 * title. The box comes before the thread, as in the thread's header.
 */
export function threadTitle(
  state: TabState,
  boxName: string,
  threadLabel: string | null,
): string {
  const where = [boxName, threadLabel].filter(Boolean).join(' · ');
  return `${SYMBOL[state]} ${where}`;
}
