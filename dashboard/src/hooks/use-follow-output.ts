import { useEffect, useRef } from 'react';

/**
 * How near the bottom counts as against it.
 *
 * The same distance `use-scroll-away.ts` calls pinned, for the same reason: a
 * scroller a few pixels short of its end is at its end as far as a reader is
 * concerned, and a turn's anchor leaves exactly that much rounding behind.
 */
const AT_BOTTOM = 8;

/**
 * How long after a hand touches the scroller its scrolling is still that
 * hand's.
 *
 * A wheel notch is not a scroll: it starts one, which the browser animates out
 * over a frame or ten, and a flick is several of those. Long enough to cover
 * the tail of one, short enough that the next thing to move the scroller by
 * itself is not blamed on a reader who has let go.
 */
const REACH = 400;

/**
 * How recently a scroller has to have moved with its output to still count as
 * following it.
 *
 * A thread parked at the bottom with nothing arriving is not following
 * anything; it is being read. The difference matters to the disclosures,
 * which hold the position still for a reader and must not for a turn.
 */
const ACTIVE = 1000;

/**
 * The scrollers following their own output, and when each last moved with it.
 *
 * Maps rather than attributes on the scroller: the runtime watches the
 * viewport's subtree for mutations and reads every non-style attribute change
 * as content arriving, so a flag written on the element would itself be a
 * reason to scroll.
 */
const following = new WeakMap<Element, boolean>();
const followed = new WeakMap<Element, number>();

/** The nearest thing that scrolls, which for a thread is its viewport. */
function scrollerOf(node: Element | null): Element | null {
  for (let el = node; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'scroll' || overflowY === 'auto') return el;
  }
  return null;
}

/**
 * Whether the scroller `node` sits inside is following its own output right
 * now — at the bottom of it, and lately moved to stay there.
 *
 * For the disclosures in a message, which hold the viewport still while they
 * animate and must not do that to a thread that is chasing its own bottom.
 * See `use-disclosure-lock.ts`. A node in a view that never called
 * `useFollowOutput` — the playground, which streams nothing — is not
 * following anything, and the answer is no.
 */
export function isFollowingOutput(node: Element | null): boolean {
  const scroller = scrollerOf(node);
  if (!scroller || following.get(scroller) !== true) return false;
  return performance.now() - (followed.get(scroller) ?? 0) < ACTIVE;
}

/**
 * Asks whether the turn's anchor still has room to give, of the scroller.
 *
 * A turn anchors the message that started it to the top of the viewport, and
 * pays for the empty space under a short answer with a reserve element the
 * runtime shrinks as the answer grows. While that reserve has height the
 * position is the anchor's business and the viewport is already against its
 * bottom; when it reaches nothing, the answer has outgrown the screen and the
 * anchor stops moving.
 *
 * Read from the DOM because the reserve is a DOM detail: a renamed attribute
 * costs the smooth scroll that opens a turn — this hook would take the
 * viewport to the same place at once instead — and nothing else. Kept for as
 * long as it stays in the document, because the question is asked on every
 * chunk of a turn and a thread is a large thing to search.
 */
function reserveOf(el: Element): () => boolean {
  let reserve: HTMLElement | null = null;

  return () => {
    if (!reserve?.isConnected) {
      reserve = el.querySelector<HTMLElement>('[data-aui-top-anchor-reserve]');
    }
    return !!reserve && reserve.offsetHeight > 0;
  };
}

/**
 * Keeps a thread against the bottom of its own output, and says so.
 *
 * The runtime follows the bottom for everything except the one case it hands
 * to the turn anchor: while a turn runs, the position belongs to the anchor
 * holding the prompt at the top of the viewport, and the anchor only holds —
 * it never follows. That works for as long as the reserve under the answer
 * lasts, which is one screenful. Past that, every tool call and every line of
 * reasoning the turn goes on to write lands below the fold and stays there
 * until the turn ends, which is the whole of a long one.
 *
 * So the reserve running out is the handover: from there to the end of the
 * turn this hook keeps the viewport at the bottom. A reader who takes the
 * scroller away from it is left where they put it, and arriving back at the
 * bottom — by hand or by the button — rejoins the turn.
 *
 * @returns The ref to put on the scroller.
 */
export function useFollowOutput(): React.RefObject<HTMLDivElement | null> {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;

    following.set(el, true);

    /** How much of the thread is below the fold. */
    const behind = (): number => el.scrollHeight - el.clientHeight - el.scrollTop;
    const reserving = reserveOf(el);

    /**
     * When a hand was last on the scroller.
     *
     * Which is asked instead of reading it off the position, because the
     * position cannot answer it. A reader going up a hundred pixels and the
     * browser holding the page still while a block above them collapses by a
     * hundred both subtract a hundred from `scrollTop`, and a turn writing
     * into the same frame moves the numbers again underneath both. Nothing
     * the browser does to a scroller of its own accord arrives with a wheel
     * or a finger attached, so that is the question worth asking.
     */
    let gesture = 0;
    const touched = (event: Event): void => {
      // A press lands on something for every reason there is — a disclosure,
      // the composer, a link — and only a press on the scroller itself is a
      // hand on its scrollbar.
      if (event.type === 'pointerdown' && event.target !== el) return;
      gesture = performance.now();
    };

    const onScroll = (): void => {
      // At the bottom is following, however it got there — a reader arriving
      // back at it is rejoining the turn.
      if (behind() <= AT_BOTTOM) following.set(el, true);
      else if (performance.now() - gesture < REACH) following.set(el, false);
    };

    const onGrow = (): void => {
      if (following.get(el) !== true) return;
      // Nothing to catch up with, or somebody else's turn to: the runtime's
      // own autoscroll while no turn is running, the anchor while one is.
      if (behind() <= AT_BOTTOM || reserving()) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
      followed.set(el, performance.now());
    };

    el.addEventListener('scroll', onScroll);
    /**
     * The three ways a hand scrolls this, and no more than those.
     *
     * A key is not one of them, however much it looks like input: the
     * composer sits inside the viewport, so every letter typed into it — and
     * the Return that starts the turn — arrives here as well.
     */
    const gestures = ['wheel', 'touchmove', 'pointerdown'] as const;
    for (const kind of gestures) el.addEventListener(kind, touched, { passive: true });

    /**
     * The scroller and what it holds, both measured.
     *
     * The scroller itself for a viewport that changes size — a keyboard
     * opening under the composer, a rotation. What it holds because content
     * arriving is not the only thing that grows a thread: a disclosure
     * opening or closing animates its height for a fifth of a second without
     * touching the DOM again, and a run of tool calls and reasoning is one of
     * those every few hundred milliseconds. Watching for mutations alone
     * leaves the bottom drifting out of view for the length of every
     * animation, and catching up only when the next chunk lands.
     */
    const size = new ResizeObserver(onGrow);
    size.observe(el);
    const measured = new WeakSet<Element>();
    const measure = (): void => {
      for (const child of el.children) {
        if (measured.has(child)) continue;
        measured.add(child);
        size.observe(child);
      }
    };
    measure();

    const content = new MutationObserver(() => {
      measure();
      onGrow();
    });
    content.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      for (const kind of gestures) el.removeEventListener(kind, touched);
      size.disconnect();
      content.disconnect();
      following.delete(el);
      followed.delete(el);
    };
  }, []);

  return viewport;
}
