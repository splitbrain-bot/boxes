import { cn } from '@/lib/utils';

/**
 * The one spinner in the dashboard: a 3×3 wave of blocks.
 *
 * This is `blocks-wave` from svg-spinners (n3r4zzurr0, MIT, no attribution
 * required — the collection magecdn.com/tools/svg-loaders serves), reproduced
 * rather than pasted. Upstream animates x, y, width and height on every rect,
 * which needs nine keyframe pairs because each block carries its own
 * coordinates; every one of them describes the same thing — a block shrinking
 * about its own centre and growing back. So it is one keyframe here
 * (`.spinner-block` in globals.css), and the wave is the diagonal it already
 * was: a block starts (row + col) tenths of a second after the first.
 *
 * A spinner is not a status: it says work is in progress and nothing about
 * what kind. So it is hidden from assistive technology unless the caller has
 * something to call it — a label here, or a sibling that already says it.
 */

/** The grid: 24 units, one of margin each side, the rest in three. */
const CELL = 7.33;
const MARGIN = 1;
const TRACK = [0, 1, 2] as const;

export type SpinnerProps = Omit<React.ComponentProps<'svg'>, 'children'> & {
  /**
   * What this spinner is waiting for, for a screen reader. Leave unset where
   * the text beside it already says — a second announcement of the same fact
   * is noise.
   */
  label?: string;
};

export function Spinner({ className, label, ...props }: SpinnerProps) {
  return (
    <svg
      data-slot="spinner"
      viewBox="0 0 24 24"
      fill="currentColor"
      /* size-4 and the current colour, which is what every icon it stands in
         for was: a caller sizes it by passing its own size-*. */
      className={cn('size-4 shrink-0', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...props}
    >
      {TRACK.map((row) =>
        TRACK.map((col) => (
          <rect
            key={`${row}-${col}`}
            className="spinner-block"
            x={MARGIN + col * CELL}
            y={MARGIN + row * CELL}
            width={CELL}
            height={CELL}
            style={{ animationDelay: `${(row + col) * 100}ms` }}
          />
        )),
      )}
    </svg>
  );
}
