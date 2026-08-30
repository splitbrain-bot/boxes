import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { startPolling } from './stores/sessions.ts';
import { Playground } from './views/Playground.tsx';
import { SessionCreate } from './views/SessionCreate.tsx';
import { Shell } from './views/Shell.tsx';
import { SessionInfo } from './views/SessionInfo.tsx';
import { SessionList } from './views/SessionList.tsx';
import { SessionThread } from './views/SessionThread.tsx';
import './globals.css';

/**
 * One app, one origin. The session list is the thread list, and a session's
 * conversation is a route inside this same dashboard.
 */
function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* The thread owns the whole viewport; every other route sits in the
            narrow reading column. */}
        <Route path="/sessions/:id" element={<SessionThread />} />
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
}
