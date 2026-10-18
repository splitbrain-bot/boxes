import { useEffect, useRef } from 'react';
import {
  type FollowState,
  followGrew,
  followScrolled,
  followStart,
  followTouched,
  isFollowing,
} from '@/lib/follow-output.ts';

/**
 * The follow state of each scroller.
 *
 * A DOM attribute cannot hold the state, because the runtime treats each
 * attribute change in the viewport, except a change to style, as new content
 * and scrolls.
 */
const state = new WeakMap<Element, FollowState>();

/**
 * Finds the nearest element from `node` upwards that scrolls. For a thread, the element is its viewport.
 *
 * @param node The element to start from.
 * @returns The scroller, or null when no element scrolls.
 */
function scrollerOf(node: Element | null): Element | null {
  for (let el = node; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'scroll' || overflowY === 'auto') return el;
  }
  return null;
}

/**
 * Checks if the scroller that contains `node` follows its own output now.
 *
 * False for a scroller that no {@link useFollowOutput} watches, e.g., the
 * scroller of the playground.
 *
 * @param node An element inside the scroller.
 * @returns True while the scroller follows its output.
 */
export function isFollowingOutput(node: Element | null): boolean {
  const scroller = scrollerOf(node);
  const current = scroller && state.get(scroller);
  return !!current && isFollowing(current, performance.now());
}

/**
 * Returns a check for whether the turn anchor's reserve element in `el` still
 * has height.
 *
 * The runtime anchors a turn's message to the top of the viewport and fills
 * the space under a short answer with the reserve, which shrinks as the answer
 * grows. The check caches the element while it stays in the document, because
 * it runs on every chunk.
 *
 * If the runtime renames the attribute, the check finds nothing, and the hook
 * jumps to the bottom at once.
 *
 * @param el The thread viewport.
 * @returns The check, which returns true while the reserve has height.
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
 * Keeps a thread at the bottom of its output once the turn anchor's reserve
 * runs out, and records the follow state for {@link isFollowingOutput}.
 *
 * During a turn, the runtime's anchor holds the prompt at the top of the
 * viewport, but the anchor does not follow the output.
 *
 * @returns The ref to put on the scroller.
 */
export function useFollowOutput(): React.RefObject<HTMLDivElement | null> {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;

    state.set(el, followStart());

    /** The height of the thread below the fold, in pixels. */
    const behind = (): number => el.scrollHeight - el.clientHeight - el.scrollTop;
    const reserving = reserveOf(el);
    const now = (): number => performance.now();

    const touched = (event: Event): void => {
      // Only a press on the scroller itself is a press on its scrollbar.
      if (event.type === 'pointerdown' && event.target !== el) return;
      state.set(el, followTouched(state.get(el) ?? followStart(), now()));
    };

    const onScroll = (): void => {
      const current = state.get(el);
      if (!current) return;
      state.set(el, followScrolled(current, { behind: behind(), now: now() }));
    };

    const onGrow = (): void => {
      const current = state.get(el);
      if (!current) return;
      const grew = followGrew(current, { behind: behind(), reserving: reserving(), now: now() });
      state.set(el, grew.state);
      if (grew.catchUp) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    };

    el.addEventListener('scroll', onScroll);
    /**
     * The gestures of a reader who scrolls. The list has no keys, because the
     * composer is inside the viewport and every key typed into it also arrives
     * here.
     */
    const gestures = ['wheel', 'touchmove', 'pointerdown'] as const;
    for (const kind of gestures) el.addEventListener(kind, touched, { passive: true });

    /**
     * Watches the size of the scroller and of each child. The scroller
     * resizes when a keyboard opens or the screen rotates. A child resizes
     * while a disclosure animates, which changes no DOM node.
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
      state.delete(el);
    };
  }, []);

  return viewport;
}
