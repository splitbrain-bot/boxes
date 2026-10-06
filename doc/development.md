# Development

This document gives an overview of the repository layout, the technologies
in use, and how to run the tests.

## Layout

Each top-level directory is a self-contained package with its own lock
file.

| Directory | Contains |
|---|---|
| `orchestrator/` | The backend service. Node.js and Fastify, written in TypeScript. Serves the REST API, the dashboard bundle and the `/ws` gateways, drives Docker through dockerode, stores state in SQLite (better-sqlite3). Request and response bodies are validated with zod. |
| `dashboard/` | The frontend. A React 19 single-page app with React Router, zustand for state, assistant-ui (shadcn-style, sources committed under `src/components/assistant-ui/`) for the chat, Tailwind CSS 4 for styling, xterm.js for the terminal, shiki for syntax highlighting. |
| `proxy/` | The egress proxy. Node.js and TypeScript, built on mockttp. The only route out of a box network; swaps placeholder tokens for real credentials on the wire. |
| `shared/` | Plain TypeScript modules imported by both the orchestrator and the dashboard: the ACP vocabulary, the REST types, the terminal subprotocol. There is no build step; the consumers import the sources directly. |
| `box-image/` | The Dockerfile and support files for the box containers the orchestrator creates at runtime. Ubuntu-based, ships the agent CLIs and their ACP adapters, Nix for agent-installed tooling, tmux for the terminal. |
| `tests/` | `smoke-test.sh`, the security smoke test (see below). |
| `doc/` | Topic documentation. |
| `.github/workflows/` | The CI pipeline. |

## Technologies

- **Language:** TypeScript (ESM) throughout. The images and CI use Node.js
  26.
- **Build:** Vite. The orchestrator and the proxy are bundled in SSR mode
  (dependencies stay external, the runtime images install them); the
  dashboard is bundled as a browser app. Every package also type-checks
  with `tsc --noEmit` (`npm run check`).
- **Tests:** Vitest everywhere, Playwright for browser tests.
- **Containers:** Docker with Compose v2 for deployment; the orchestrator
  talks to the daemon directly through the Docker socket.
- **Protocol:** The dashboard and the orchestrator speak the Agent Client
  Protocol (ACP) over WebSocket as JSON-RPC.

## Prerequisites

- Node.js, any recent release (the images and CI use 26).
- Docker with the daemon running. The orchestrator needs the Docker socket
  to create box containers, and it pulls the box image on first boot.

## Installing dependencies

Install each package from its directory:

```sh
cd orchestrator && npm ci
cd proxy && npm ci
cd dashboard && npm ci
```

`shared/` has no dependencies and is imported as source.

## Building

Each package builds from its directory:

```sh
cd orchestrator && npm run build   # bundle in dist/
cd proxy && npm run build          # bundle in dist/
cd dashboard && npm run build      # static app in dist/
```

The three production images build from the repository root, because the
orchestrator and proxy Dockerfiles also copy `shared/`:

```sh
docker build -f orchestrator/Dockerfile .
docker build -f proxy/Dockerfile .
docker build -f box-image/Dockerfile box-image
```

## Running locally

Run the orchestrator in its container, per the shipped `compose.yaml`:

```sh
docker compose up -d
```

For frontend work, the dashboard's dev server proxies the API, `/healthz`
and `/ws` to a running orchestrator (`ORCHESTRATOR_URL`, default
`http://localhost:3000`):

```sh
cd dashboard && npm run dev
```

## Running the tests

Each package runs its own suite. Run them from the package directories:

```sh
cd orchestrator && npm test
cd proxy && npm test
cd dashboard && npm test
```

Type checking is separate, also run from each package directory:

```sh
cd orchestrator && npm run check
cd proxy && npm run check
cd dashboard && npm run check
```

The orchestrator and proxy suites are plain Vitest unit tests; Docker
interactions are faked, no daemon is needed.

The dashboard suite has two projects, both run by `npm test`:

- **unit** — tests under `src/`, run in Node.
- **e2e** — tests under `e2e/`, which build the production bundle, start a
  real orchestrator in-process against a fake Docker daemon and a stub ACP
  gateway, and drive it in Chromium through Playwright. To run only one
  project: `npx vitest run --project unit` or `--project e2e`. The e2e
  project needs a Chromium; `npx playwright install --with-deps chromium`
  installs it, or set `CHROMIUM_PATH` to an existing binary.

The box image carries its own checks: its Dockerfile has a `test` stage
between the build and the shipped stage, so a failed property fails the
image build.

### Smoke test

`tests/smoke-test.sh` is not a unit test. It runs against a live
deployment on a Docker host (`docker compose up -d`), creates throwaway
boxes through the API and asserts the isolation properties from inside
their containers:

```sh
API_BASE=http://localhost:3000 ./tests/smoke-test.sh
```

The header of the script documents the environment variables for
credential translation checks and optional probes.

## CI

`.github/workflows/publish.yml` runs the three test suites in parallel,
builds the three images, runs the smoke test against the built images, and
publishes to GHCR on pushes to `main`.
