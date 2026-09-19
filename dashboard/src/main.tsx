import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Loading } from './components/Loading.tsx';
import { installWorker, refreshPush } from './stores/push.ts';
import './globals.css';

/**
 * Every view is its own chunk.
 *
 * A browser opens one route at a time, and most of them have nothing to do
 * with each other: the review carries the code pane and behind it Shiki's
 * engine and one grammar per file type, the agent-set editor carries an
 * editor, the playground carries the whole component registry. Loaded this
 * way, opening a conversation from a notification downloads the conversation
 * and none of the rest.
 */
const AgentSetEditor = lazy(async () => ({
  default: (await import('./views/AgentSetEditor.tsx')).AgentSetEditor,
}));
const AgentSets = lazy(async () => ({
  default: (await import('./views/AgentSets.tsx')).AgentSets,
}));
const Playground = lazy(async () => ({
  default: (await import('./views/Playground.tsx')).Playground,
}));
const SessionCreate = lazy(async () => ({
  default: (await import('./views/SessionCreate.tsx')).SessionCreate,
}));
const SessionInfo = lazy(async () => ({
  default: (await import('./views/SessionInfo.tsx')).SessionInfo,
}));
const SessionList = lazy(async () => ({
  default: (await import('./views/SessionList.tsx')).SessionList,
}));
const SessionReview = lazy(async () => ({
  default: (await import('./views/SessionReview.tsx')).SessionReview,
}));
const SessionTerminal = lazy(async () => ({
  default: (await import('./views/SessionTerminal.tsx')).SessionTerminal,
}));
const SessionThread = lazy(async () => ({
  default: (await import('./views/SessionThread.tsx')).SessionThread,
}));
const Shell = lazy(async () => ({
  default: (await import('./views/Shell.tsx')).Shell,
}));

/**
 * One app, one origin. The session list is the thread list, and a session's
 * conversation is a route inside this same dashboard.
 */
function App() {
  return (
    <BrowserRouter>
      {/* One boundary for every route, so each view's chunk is fetched while
          this stands in its place. The review states its own below, because a
          whole-viewport wait wants to say what it is waiting for. */}
      <Suspense fallback={<Loading className="flex h-dvh items-center justify-center" />}>
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
                  <Loading className="flex h-dvh items-center justify-center">
                    Loading the review…
                  </Loading>
                }
              >
                <SessionReview />
              </Suspense>
            }
          />
          {/* A shell in the box, which owns the viewport for the same reason
              the review does: a terminal in a reading column is not a
              terminal. It names no thread — the box is one box however many
              conversations it holds, and every terminal on it is the same
              shell. */}
          <Route
            path="/sessions/:id/terminal"
            element={
              <Suspense
                fallback={
                  <Loading className="flex h-dvh items-center justify-center">
                    Loading the terminal…
                  </Loading>
                }
              >
                <SessionTerminal />
              </Suspense>
            }
          />
          {/* The installed components over a canned store: where a registry
              upgrade is reviewed as a diff and a screenshot. */}
          <Route path="/playground" element={<Playground />} />
          <Route element={<Shell />}>
            <Route path="/" element={<SessionList />} />
            <Route path="/new" element={<SessionCreate />} />
            {/* What the agent is configured with, which belongs to the
                deployment rather than to any one box. */}
            <Route path="/agents" element={<AgentSets />} />
            <Route path="/agents/:setId" element={<AgentSetEditor />} />
            <Route path="/sessions/:id/info" element={<SessionInfo />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
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
  // The service worker first and unconditionally: it is what makes the app
  // installable, and installing is what an iPhone has to do before push is
  // even offered to it.
  void installWorker();
  // Then re-register a browser that is already subscribed — a push service
  // may have handed it a new subscription since the last load, and this is
  // the only place the orchestrator hears about that. Never asks for
  // permission: that needs a click, and the toggle in the session list is
  // where it happens.
  void refreshPush();
}
