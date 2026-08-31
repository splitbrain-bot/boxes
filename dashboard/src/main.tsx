import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { refreshPush } from './stores/push.ts';
import { startPolling } from './stores/sessions.ts';
import { Playground } from './views/Playground.tsx';
import { SessionCreate } from './views/SessionCreate.tsx';
import { Shell } from './views/Shell.tsx';
import { SessionInfo } from './views/SessionInfo.tsx';
import { SessionList } from './views/SessionList.tsx';
import { SessionThread } from './views/SessionThread.tsx';
import './globals.css';

/**
 * The review view is its own chunk.
 *
 * Everything it needs — the code pane, the tree, the sheet primitives, and
 * behind them Shiki's engine and one grammar per file type — is weight the
 * thread view must not carry. Lazily loaded here, none of it is in the bundle
 * a browser opening a conversation downloads.
 */
const SessionReview = lazy(async () => ({
  default: (await import('./views/SessionReview.tsx')).SessionReview,
}));

/**
 * One app, one origin. The session list is the thread list, and a session's
 * conversation is a route inside this same dashboard.
 */
function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* The thread owns the whole viewport; every other route sits in the
            narrow reading column.

            Two routes onto the same view: one naming a thread, which is what
            makes two tabs on two conversations of one box possible, and one
            naming none, which means whichever thread the session has current
            — so every link and bookmark from before survives. */}
        <Route path="/sessions/:id" element={<SessionThread />} />
        <Route path="/sessions/:id/threads/:threadId" element={<SessionThread />} />
        {/* Reviewing owns the whole viewport too: a code pane in the reading
            column is not a code pane. The open file is in the search string,
            so a file is linkable and the back button works. */}
        <Route
          path="/sessions/:id/review"
          element={
            <Suspense
              fallback={
                <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
                  Loading the review…
                </div>
              }
            >
              <SessionReview />
            </Suspense>
          }
        />
        {/* The installed components over a canned store: where a registry
            upgrade is reviewed as a diff and a screenshot. */}
        <Route path="/playground" element={<Playground />} />
        <Route element={<Shell />}>
          <Route path="/" element={<SessionList />} />
          <Route path="/new" element={<SessionCreate />} />
          <Route path="/sessions/:id/info" element={<SessionInfo />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  startPolling();
  // Registers the service worker and re-registers a browser that is already
  // subscribed — a push service may have handed it a new subscription since
  // the last load, and this is the only place the orchestrator hears about
  // that. Never asks for permission: that needs a click, and the toggle in
  // the session list is where it happens.
  void refreshPush();
}
