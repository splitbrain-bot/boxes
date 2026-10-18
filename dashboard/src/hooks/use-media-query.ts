import { useEffect, useState } from 'react';

/**
 * Checks if a CSS media query matches now.
 *
 * Use it for layout choices that CSS cannot make, e.g., a component rendered
 * into a portal, or an inline height and `inert` that a breakpoint cannot undo.
 *
 * @param query The CSS media query.
 * @returns True while the query matches.
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
