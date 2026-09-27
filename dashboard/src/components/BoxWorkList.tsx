import type { BoxWork } from '../../../shared/types.ts';
import { formatDuration } from '@/lib/task-notifications';

/**
 * Read-only list of the processes a reading of a box's process table found.
 *
 * It includes what an adapter left behind when it died. The reading does not
 * know which thread a process belongs to, so the list offers no per-process stop.
 *
 * @param work The processes from the reading.
 */
export function BoxWorkList({ work }: { work: readonly BoxWork[] }) {
  return (
    // Without `min-w-0`, an unbreakable command line widens the parent grid track.
    <ul className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {work.map((found) => (
        <li key={found.pid} className="flex items-baseline gap-2">
          {/* The title holds the full line, because a harness's shell preamble
              often pushes the identifying part past the row's width. */}
          <span className="min-w-0 flex-1 truncate font-mono" title={found.command}>
            {found.command}
          </span>
          {/* Elapsed time as of the reading, or a dash where `ps` gave none. */}
          <span className="shrink-0 tabular-nums opacity-80">
            {found.elapsedSeconds === null ? '—' : formatDuration(found.elapsedSeconds * 1000)}
          </span>
        </li>
      ))}
    </ul>
  );
}
