import { useEffect, useRef } from 'react';
import {
  followGrew,
  followScrolled,
  followStart,
  followTouched,
  isFollowing,
  type FollowState,
} from '@/lib/follow-output.ts';

/**
 * The follow state of each scroller.
 *
 * Kept in a map, not in an attribute: the runtime reads every attribute
 * change in the viewport, except to style, as new content and scrolls.
 */
const state = new WeakMap<Element, FollowState>();

/** The nearest thing that scrolls, which for a thread is its viewport. */
function scrollerOf(node: Element | null): Element | null {
  for (let el = node; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'scroll' || overflowY === 'auto') return el;
  }
  return null;
}

/**
 * Whether the scroller that contains `node` follows its own output right now.
 *
 * False for a scroller that no {@link useFollowOutput} watches, such as the
 * playground's.
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
 * If the runtime renames the attribute, the check finds nothing and the hook
 * jumps to the bottom at once instead of letting the anchor scroll smoothly.
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
 * viewport but does not follow the output. Without this hook, output past
 * the first screen would stay below the fold until the turn ends.
 *
 * @returns The ref to put on the scroller.
 */
export function useFollowOutput(): React.RefObject<HTMLDivElement | null> {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;

    state.set(el, followStart());

    /** How much of the thread is below the fold. */
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
     * The gestures that scroll by hand. Keys are left out, because the
     * composer sits inside the viewport and every key typed into it arrives
     * here too.
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
