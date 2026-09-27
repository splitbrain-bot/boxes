import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Loading } from './components/Loading.tsx';
import { installWorker, refreshPush } from './stores/push.ts';
import './globals.css';

/**
 * The agent-set editor view.
 *
 * Every view is a chunk of its own, loaded on first use, so opening a thread
 * downloads only the thread view.
 */
const AgentSetEditor = lazy(async () => ({
  default: (await import('./views/AgentSetEditor.tsx')).AgentSetEditor,
}));
/** The list of agent sets. Loaded on first use. */
const AgentSets = lazy(async () => ({
  default: (await import('./views/AgentSets.tsx')).AgentSets,
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
      {/* Shown while a view's chunk loads. The review and the terminal have
          their own, which say what they load. */}
      <Suspense fallback={<Loading className="flex h-dvh items-center justify-center" />}>
        <Routes>
          {/* The thread, the review and the terminal fill the viewport. Every
              other route sits in the reading column. A box has no page of its
              own: it is a card in the list. The URL names the thread, so two
              tabs can show two threads of one box. */}
          <Route path="/boxes/:id" element={<Navigate to="/" replace />} />
          <Route path="/boxes/:id/threads/:threadId" element={<BoxThread />} />
          {/* The open file is in the search string, so a file has a link and
              the back button works. */}
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
          {/* Names no thread: every terminal on a box attaches to the same
              shell. */}
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
          {/* The installed components over a canned store, for reviewing a
              registry upgrade. */}
          <Route path="/playground" element={<Playground />} />
          <Route element={<Shell />}>
            <Route path="/" element={<BoxList />} />
            <Route path="/new" element={<BoxCreate />} />
            <Route path="/agents" element={<AgentSets />} />
            <Route path="/agents/:setId" element={<AgentSetEditor />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/boxes/:id/info" element={<BoxInfo />} />
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
  void installWorker();
  // Re-registers an existing subscription only. Asking for permission needs
  // a click on the toggle in the box list.
  void refreshPush();
}
