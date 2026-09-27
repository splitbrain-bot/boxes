import { cn } from '@/lib/utils';

/** The side of one block, in viewBox units: 22 units split in three. */
const CELL = 7.33;
/** The margin on each side of the 24-unit viewBox. */
const MARGIN = 1;
/** The row and column indexes of the 3×3 grid. */
const TRACK = [0, 1, 2] as const;

/** The props of {@link Spinner}: any svg prop but children, plus a label. */
export type SpinnerProps = Omit<React.ComponentProps<'svg'>, 'children'> & {
  /**
   * What the spinner waits for, for a screen reader. Without it the spinner is
   * hidden from assistive technology, for use beside text that already says so.
   */
  label?: string;
};

/**
 * The dashboard's spinner: a 3×3 wave of blocks.
 *
 * It reproduces `blocks-wave` from svg-spinners by n3r4zzurr0 (MIT). Each
 * block runs the one `.spinner-block` keyframe from globals.css, and starts
 * (row + col) tenths of a second after the first.
 */
export function Spinner({ className, label, ...props }: SpinnerProps) {
  return (
    <svg
      data-slot="spinner"
      viewBox="0 0 24 24"
      fill="currentColor"
      /* size-4 and the current colour, like the icons. A caller passes its own size-*. */
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
