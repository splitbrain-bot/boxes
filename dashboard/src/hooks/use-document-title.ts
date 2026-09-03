import { useEffect } from 'react';

/**
 * Keeps `document.title` in step with what the view is showing.
 *
 * Set rather than saved and restored: every route sets its own, so there is
 * no arrangement between them to get wrong. The one in index.html is what a
 * cold load shows for the moment before React mounts.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
