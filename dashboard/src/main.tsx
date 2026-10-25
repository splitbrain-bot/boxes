/**
 * The entry point of the dashboard.
 *
 * Every view is a chunk of its own, loaded on first use, so opening a thread
 * downloads only the thread view.
 */

import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Loading } from './components/Loading.tsx';
import { installWorker, refreshPush } from './stores/push.ts';
import './globals.css';

/** The agent-set editor view. Loaded on first use. */
const AgentSetEditor = lazy(async () => ({
  default: (await import('./views/AgentSetEditor.tsx')).AgentSetEditor,
}));
/** The list of agent sets. Loaded on first use. */
const AgentSets = lazy(async () => ({
  default: (await import('./views/AgentSets.tsx')).AgentSets,
}));
/** The egress profile editor view. Loaded on first use. */
const EgressProfileEditor = lazy(async () => ({
  default: (await import('./views/EgressProfileEditor.tsx')).EgressProfileEditor,
}));
/** The list of egress profiles. Loaded on first use. */
const EgressProfiles = lazy(async () => ({
  default: (await import('./views/EgressProfiles.tsx')).EgressProfiles,
}));
/** The component playground. Loaded on first use. */
const Playground = lazy(async () => ({
  default: (await import('./views/Playground.tsx')).Playground,
}));
/** The form that creates a box. Loaded on first use. */
const BoxCreate = lazy(async () => ({
  default: (await import('./views/BoxCreate.tsx')).BoxCreate,
}));
/** A box's details. Loaded on first use. */
const BoxInfo = lazy(async () => ({
  default: (await import('./views/BoxInfo.tsx')).BoxInfo,
}));
/** The box list. Loaded on first use. */
const BoxList = lazy(async () => ({
  default: (await import('./views/BoxList.tsx')).BoxList,
}));
/** The code review of a box's workspace. Loaded on first use. */
const BoxReview = lazy(async () => ({
  default: (await import('./views/BoxReview.tsx')).BoxReview,
}));
/** A terminal on a box's shell. Loaded on first use. */
const BoxTerminal = lazy(async () => ({
  default: (await import('./views/BoxTerminal.tsx')).BoxTerminal,
}));
/** One thread of a box. Loaded on first use. */
const BoxThread = lazy(async () => ({
  default: (await import('./views/BoxThread.tsx')).BoxThread,
}));
/** The credentials and settings page. Loaded on first use. */
const Settings = lazy(async () => ({
  default: (await import('./views/Settings.tsx')).Settings,
}));
/** The layout of the reading-column routes. Loaded on first use. */
const Shell = lazy(async () => ({
  default: (await import('./views/Shell.tsx')).Shell,
}));

/** The dashboard and its routes. */
function App() {
  return (
    <BrowserRouter>
      {/* Shows while the chunk of a view loads. The review and the terminal
          have their own fallbacks, which name what loads. */}
      <Suspense fallback={<Loading className="flex h-dvh items-center justify-center" />}>
        <Routes>
          {/* The thread, the review and the terminal fill the viewport. Every
              other route sits in the reading column. A box has no page of its
              own, because it is a card in the list. The URL names the thread, so two
              tabs can show two threads of one box. */}
          <Route path="/boxes/:id" element={<Navigate to="/" replace />} />
          <Route path="/boxes/:id/threads/:threadId" element={<BoxThread />} />
          {/* The search string holds the open file, so each file has a link
              and the back button works. */}
          <Route
            path="/boxes/:id/review"
            element={
              <Suspense
                fallback={
                  <Loading className="flex h-dvh items-center justify-center">
                    Loading the review…
                  </Loading>
                }
              >
                <BoxReview />
              </Suspense>
            }
          />
          {/* The path names no thread, because all terminals of a box attach
              to the same shell. */}
          <Route
            path="/boxes/:id/terminal"
            element={
              <Suspense
                fallback={
                  <Loading className="flex h-dvh items-center justify-center">
                    Loading the terminal…
                  </Loading>
                }
              >
                <BoxTerminal />
              </Suspense>
            }
          />
          {/* Shows the installed components with canned messages, to check a
              component upgrade from the registry. */}
          <Route path="/playground" element={<Playground />} />
          <Route element={<Shell />}>
            <Route path="/" element={<BoxList />} />
            <Route path="/new" element={<BoxCreate />} />
            <Route path="/agents" element={<AgentSets />} />
            <Route path="/agents/:setId" element={<AgentSetEditor />} />
            <Route path="/egress" element={<EgressProfiles />} />
            <Route path="/egress/:profileId" element={<EgressProfileEditor />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/boxes/:id/info" element={<BoxInfo />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

/** The element that the dashboard renders into. */
const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void installWorker();
  // Re-registers an existing subscription only. Asking for permission needs
  // a click on the toggle in the box list.
  void refreshPush();
}
