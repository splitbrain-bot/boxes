import type { BoxWork } from '../../../shared/types.ts';
import { formatDuration } from '@/lib/task-notifications';

/**
 * What a reading of a box found running in it.
 *
 * The other half of what a session has going, and the half nothing else in
 * the dashboard shows. A thread's own bar lists the tasks its adapter
 * announced; this lists processes off the box's own table, which is the only
 * thing that still sees what an adapter left behind when it died.
 *
 * Read-only, because there is nothing here a stop could be addressed to: the
 * reading knows what runs in a box and not whose it is, so the only action
 * over it is the box-wide one, and that is all of this at once.
 */
export function BoxWorkList({ work }: { work: readonly BoxWork[] }) {
  return (
    // `min-w-0`, because a command line is one unbreakable word as far as
    // layout is concerned: a grid track sized to its own content grows to fit
    // the longest of them and takes whatever it is placed in with it.
    <ul className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {work.map((found) => (
        <li key={found.pid} className="flex items-baseline gap-2">
          {/* Truncated with the whole of it on the title, because a command an
              agent ran carries its harness's shell preamble in front of it and
              what identifies it is usually past the width of a row. The
              readable line is often the row below, which is that command's
              own child. */}
          <span className="min-w-0 flex-1 truncate font-mono" title={found.command}>
            {found.command}
          </span>
          {/* Since it started, and as of the reading rather than of now: the
              answer is polled, and a clock ticking over it would claim a
              precision the number behind it does not have. Absent where the
              host's own `ps` would not give one. */}
          <span className="shrink-0 tabular-nums opacity-80">
            {found.elapsedSeconds === null ? '—' : formatDuration(found.elapsedSeconds * 1000)}
          </span>
        </li>
      ))}
    </ul>
  );
}
