/** Display helpers for a background task's report. */

import type { TaskUsage } from '../../../shared/task-notifications.ts';

/** The name of the converted part, which selects its renderer. */
export const TASK_NOTIFICATION_PART = 'task-notification';

/**
 * Formats a token count as text, in tokens, thousands or millions.
 *
 * @param tokens The token count.
 * @returns The formatted count, e.g., "48.2k tokens".
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  if (tokens < 1000 * 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${(tokens / (1000 * 1000)).toFixed(1)}M tokens`;
}

/**
 * Formats a duration as text: seconds below a minute, then minutes and seconds, then
 * hours and minutes.
 *
 * Used for finished reports and for work still running.
 *
 * @param ms The duration in milliseconds.
 * @returns The formatted duration, e.g., "3m 4s".
 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Formats the usage of a task as one line. Leaves out each figure that the usage does not have.
 *
 * @param usage The usage of the task.
 * @returns The line.
 */
export function formatUsage(usage: TaskUsage): string {
  return [
    usage.tokens === undefined ? '' : formatTokens(usage.tokens),
    usage.toolUses === undefined
      ? ''
      : `${usage.toolUses} tool ${usage.toolUses === 1 ? 'call' : 'calls'}`,
    usage.durationMs === undefined ? '' : formatDuration(usage.durationMs),
  ]
    .filter(Boolean)
    .join(' · ');
}
