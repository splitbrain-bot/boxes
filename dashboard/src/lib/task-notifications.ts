import type { TaskUsage } from '../../../shared/task-notifications.ts';

/** Display helpers for a background task's report. */

/** The name of the converted part, which selects its renderer. */
export const TASK_NOTIFICATION_PART = 'task-notification';

/** A token count as text, in tokens, thousands or millions. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  if (tokens < 1000 * 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${(tokens / (1000 * 1000)).toFixed(1)}M tokens`;
}

/**
 * A duration as text: seconds below a minute, then minutes and seconds, then
 * hours and minutes.
 *
 * Used for finished reports and for work still running.
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

/** What a task cost, as one line. Leaves out every figure the usage lacks. */
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
