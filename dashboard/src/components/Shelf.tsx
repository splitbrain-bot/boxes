import { useEffect, useRef, useState } from 'react';

/**
 * A row that collapses to zero height when put away, so the content below
 * gets the space.
 *
 * CSS cannot animate from `height: auto`, so a resize observer measures the
 * real height. Before the first measurement the row has no inline height.
 */
export function Shelf({
  away,
  children,
}: {
  /** True to put it away. */
  away: boolean;
  /** The row's content. */
  children: React.ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = content.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setHeight(el.offsetHeight);
      return;
    }
    // Fires once on observe, so the height is known from the first frame.
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      data-slot="shelf"
      // For tests, because the collapsed row's content keeps its own size.
      data-away={away ? '' : undefined}
      className="shrink-0 overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={height === null ? undefined : { height: away ? 0 : height }}
      // Keeps a hidden row out of the tab order and the screen reader, and
      // drops focus from a select that was open.
      inert={away}
    >
      <div ref={content}>{children}</div>
    </div>
  );
}
