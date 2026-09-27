/**
 * The index of the current entry in the browser's history stack.
 *
 * React Router stores a running index as `idx` in the state of each entry.
 * Returns zero when the state has none, as in a tab opened straight onto
 * this page, with no entry of the app beneath it.
 */
export function historyIndex(): number {
  const idx = (window.history.state as { idx?: number | null } | null)?.idx;
  return typeof idx === 'number' ? idx : 0;
}
