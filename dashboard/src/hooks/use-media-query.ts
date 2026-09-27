import { useEffect, useState } from 'react';

/**
 * Whether a CSS media query matches right now.
 *
 * For layout choices CSS cannot make, such as a component rendered into a
 * portal, or an inline height and `inert` that a breakpoint cannot undo.
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
