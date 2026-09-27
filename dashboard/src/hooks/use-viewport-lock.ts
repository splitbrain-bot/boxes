import { useEffect } from 'react';

/**
 * How many mounted views hold the lock. The last one to unmount removes the
 * class.
 */
let held = 0;

/**
 * Keeps the document from scrolling while a full-viewport view is on screen.
 *
 * On a phone, the browser chrome, the keyboard and rounding can make the
 * document a few pixels taller than the screen. The browser then scrolls the
 * document, and the header goes off the top. Touches land in the view's own
 * scroller, so no gesture could scroll the document back.
 *
 * Only for views that fill the viewport. The reading-column views scroll the
 * document.
 */
export function useViewportLock(): void {
  useEffect(() => {
    held += 1;
    document.documentElement.classList.add('viewport-locked');

    /*
     * The lock removes the overflow but not an existing offset. iOS can also
     * scroll the document when the keyboard opens or closes.
     */
    const top = (): void => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    top();
    // The browser may scroll the document whenever the visible area resizes.
    // The window resize event covers a browser without visualViewport.
    window.visualViewport?.addEventListener('resize', top);
    window.addEventListener('resize', top);

    return () => {
      window.visualViewport?.removeEventListener('resize', top);
      window.removeEventListener('resize', top);
      held -= 1;
      if (held === 0) document.documentElement.classList.remove('viewport-locked');
    };
  }, []);
}
