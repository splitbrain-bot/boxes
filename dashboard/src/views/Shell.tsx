import { Outlet } from 'react-router';

/** The reading column every route but the thread sits in. */
export function Shell() {
  return (
    <div className="mx-auto max-w-2xl px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      <Outlet />
    </div>
  );
}
