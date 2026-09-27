import { Outlet } from 'react-router';
import { useDocumentTitle } from '@/hooks/use-document-title';

/** Layout with the reading column for the routes that do not fill the viewport. */
export function Shell() {
  // Resets the tab title that a thread view set.
  useDocumentTitle('Boxes');

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      <Outlet />
    </div>
  );
}
