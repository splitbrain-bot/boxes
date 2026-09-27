import { useEffect } from 'react';

/**
 * Sets `document.title` for the view. It does not restore the old title,
 * because every route sets its own.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
