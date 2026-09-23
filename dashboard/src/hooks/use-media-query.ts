import { useEffect, useState } from 'react';

/**
 * Whether a CSS media query matches right now.
 *
 * Almost everything in this dashboard picks its arrangement in CSS, which is
 * where a breakpoint belongs. This exists for the cases that cannot. A
 * component rendered into a portal — a Sheet — is not inside the element a
 * `md:hidden` wrapper would hide, so which of two arrangements to mount has to
 * be a JavaScript decision. And a header that scrolls away is collapsed by an
 * inline height and made inert, neither of which a breakpoint can undo.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
