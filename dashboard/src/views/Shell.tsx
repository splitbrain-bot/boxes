import { Outlet } from 'react-router';
import { useDocumentTitle } from '@/hooks/use-document-title';

/** The reading column every route but the thread sits in. */
export function Shell() {
  // The plain app title, which is also what leaving a thread puts back: the
  // symbol and the box's name belong to the thread that was open, not to the
  // list of them.
  useDocumentTitle('Boxes');

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      <Outlet />
    </div>
  );
}
