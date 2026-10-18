/**
 * Rough ages and sizes for a card in a list, where the reader scans rather
 * than reads.
 */

/** One second, in milliseconds. */
const SECOND = 1000;
/** One minute, in milliseconds. */
const MINUTE = 60 * SECOND;
/** One hour, in milliseconds. */
const HOUR = 60 * MINUTE;
/** One day, in milliseconds. */
const DAY = 24 * HOUR;

/**
 * Formats an age as one number and one letter: `5s`, `5m`, `5h`, `5d`.
 *
 * Uses the largest unit that leaves a whole number, and rounds down, so a
 * thread never looks older than it is. Days are the largest unit.
 *
 * A negative age is `0s`. It happens when the browser's clock and the
 * orchestrator's clock disagree.
 *
 * @param ms The age in milliseconds.
 * @returns The short age.
 */
export function shortAge(ms: number): string {
  if (ms < MINUTE) return `${Math.max(Math.floor(ms / SECOND), 0)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** The size units, smallest first. Each unit is 1024 times the previous unit. */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Formats a byte count in the largest fitting unit: `12 KB`, `5.2 MB`, `1.4 GB`.
 *
 * Uses one decimal below ten and none from ten up. A count in bytes has no
 * decimal. The units go up to TB, so the size of a whole workspace fits.
 *
 * @param bytes The byte count.
 * @returns The short size.
 */
export function shortSize(bytes: number): string {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}
