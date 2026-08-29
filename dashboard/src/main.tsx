import { render } from 'preact';
import { LocationProvider, Route, Router } from 'preact-iso';
import { startPolling } from './store.ts';
import { SessionCreate } from './views/SessionCreate.tsx';
import { SessionDetail } from './views/SessionDetail.tsx';
import { SessionList } from './views/SessionList.tsx';
import './main.css';

/** The dashboard's routes. */
function App() {
  return (
    <LocationProvider>
      <div class="App">
        <Router>
          <Route path="/" component={SessionList} />
          <Route path="/new" component={SessionCreate} />
          <Route path="/sessions/:id" component={SessionDetail} />
          <Route default component={SessionList} />
        </Router>
      </div>
    </LocationProvider>
  );
}

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
  startPolling();
}
