import { useCallback, useEffect, useRef, useState } from 'react';

/** How near the top the header is simply always there. */
const AT_TOP = 48;
/**
 * How near the bottom counts as pinned to it.
 *
 * A view that follows its own output sits exactly here for as long as the
 * output lasts: a thread streaming a reply, or writing the result of a `!bang`
 * command, keeps the scroller against its bottom and grows the content behind
 * it. Every one of those steps looks like reading down, and none of it is.
 *
 * Asking the scroller rather than the app is what makes that reliable. The
 * thread's own `isRunning` clears while the last chunks are still landing —
 * measured, not guessed — so a header that trusted it moved on its own right
 * at the end of every turn.
 */
const AT_BOTTOM = 8;
/** How far a downward run has to go before it gives way. */
const HIDE_AFTER = 32;
/**
 * And how far back up before it returns.
 *
 * The smaller of the two: going is a decision about the reading you are doing,
 * coming back is a request, and a request should not have to be repeated. Not
 * *much* smaller, though — a scroller settling after a smooth scroll drifts by
 * a dozen pixels in either direction, and a header that answered those would
 * flicker for a living. Any flick worth the name clears two dozen.
 */
const SHOW_AFTER = 24;
/**
 * A single step longer than this is a jump rather than reading.
 *
 * Both views scroll themselves sometimes — a review restoring the position a
 * file was left at, or putting a hunk in the middle of the pane; a thread
 * anchoring a new turn's message to the top. None of that is a reader's
 * decision about chrome, and all of it arrives as one enormous step, where a
 * hand on the glass arrives as a frame's worth at a time. Three hundred pixels
 * in a frame is faster than a fling and slower than any jump worth making.
 */
const JUMP = 320;
/**
 * How long a decision takes to settle, and small steps go unread for.
 *
 * Collapsing the row grows the scroller by its height, and Chrome answers a
 * container growing under anchored content by nudging `scrollTop` a few pixels
 * to hold that content still. Those pixels arrive as an upward run — which is
 * the signal to come back, which grows the scroller again. The row would sit
 * there flapping, and the reason would be itself.
 *
 * Only steps small enough to be that nudge are disregarded, and only for as
 * long as the transition runs. A real flick inside the window is still a
 * flick: swallowing it wholesale would strand the header until the next scroll
 * event, and a flick that changed nothing is exactly what this was supposed to
 * stop being.
 */
const SETTLE_MS = 300;
/** The most a settling scroller nudges itself by in one step. */
const NUDGE = 24;

/**
 * Whether a header should stand aside, for a scroller somewhere inside the
 * returned container.
 *
 * The rule is a run rather than a position: the header goes once you have
 * scrolled thirty-odd pixels further down without changing your mind, and
 * comes back on the first hint of going the other way. Runs are measured from
 * the last turn rather than from the last event, so the pixel of jitter a
 * finger leaves on the glass cannot toggle anything, and a slow drift down
 * still adds up to a decision.
 *
 * Listened for in the capture phase on the container, because a scroll event
 * does not bubble: React's own `onScroll` would never see the viewport's, and
 * reaching into a vendored component for a ref would be undone by the next
 * `npx assistant-ui add`.
 *
 * Nothing about either view is in here — a thread and a code pane are the
 * same shape of thing, and both call it the same way.
 *
 * @param scroller Selector for the one scroller that counts. A view has
 *   others — a wide table or a code block inside a message, the file tree
 *   beside a pane — and scrolling those is not reading the thing the header
 *   names.
 */
export function useScrollAway(scroller: string): {
  /** True while the header should be out of the way. */
  away: boolean;
  /** Put on the element the scroller lives inside. */
  container: React.RefObject<HTMLDivElement | null>;
} {
  const container = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);

  /**
   * Every path that moves the row, so none of them can forget the rest of what
   * moving it means.
   *
   * Deciding is idempotent — the listener decides on every event of a run, not
   * only the one that crosses the line — and a decision that changed nothing
   * starts no settling, because a drag down that kept re-arming the window
   * would swallow the flick back up. `current` is the row's real position;
   * reading `away` here would be reading a render behind.
   */
  const current = useRef(false);
  const settled = useRef(0);
  const decide = useCallback((next: boolean): void => {
    if (current.current === next) return;
    current.current = next;
    settled.current = performance.now() + SETTLE_MS;
    setAway(next);
  }, []);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    /** Where the scroller was at the last event. */
    let last = 0;
    /** Where the current run began: the last time direction changed. */
    let anchor = 0;
    let descending = false;

    const onScroll = (event: Event): void => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !el.matches(scroller)) return;

      const top = el.scrollTop;
      const step = top - last;
      last = top;
      if (step === 0) return;

      // The top is chrome rather than content, and a view too short to scroll
      // never leaves it. Nothing hides here.
      if (top <= AT_TOP) {
        anchor = top;
        descending = false;
        decide(false);
        return;
      }
      // Against the bottom: whatever moved the scroller, it was the content
      // arriving rather than a reader leaving. Follow the position so the next
      // run is measured from where reading actually resumes, and decide
      // nothing. This is also what keeps the collapse from flapping down here:
      // a taller viewport clamps the scroll position, and the clamp arrives as
      // an upward step that would otherwise read as a request to come back.
      if (el.scrollHeight - el.clientHeight - top <= AT_BOTTOM) {
        anchor = top;
        return;
      }
      // A jump — restoring where a file was left, anchoring a new turn's
      // message to the top — is not reading either. Nor is a step small enough
      // to be the collapse settling.
      const jumped = Math.abs(step) > JUMP;
      const nudged = Math.abs(step) < NUDGE && performance.now() < settled.current;
      if (jumped || nudged) {
        anchor = top;
        return;
      }

      const down = step > 0;
      if (down !== descending) {
        anchor = top - step;
        descending = down;
      }

      const run = top - anchor;
      if (down ? run > HIDE_AFTER : -run > SHOW_AFTER) decide(down);
    };

    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, [scroller, decide]);

  return { away, container };
}
