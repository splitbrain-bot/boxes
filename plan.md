# Build Plan: Personal AI Agent Orchestrator ("Boxes")

Status: FINAL (revision 4). All previously open protocol/compatibility
questions have been resolved by source-level inspection of the actual
packages (see §2, "Verified facts"). There are no research spikes; every
milestone is implementation work with concrete acceptance criteria.
Audience: a coding agent. Follow milestones in order.
Decisions are fixed; deviations require asking the owner first.

---

## 1. Goal and hard requirements

Self-hosted system that runs AI coding-agent sessions (Claude Code first,
other ACP agents later) in isolated Docker containers, controlled from a
mobile-friendly web UI, deployed via docker compose behind an existing
Traefik reverse proxy.

Hard requirements:
- Each session runs in its own Docker container, created at runtime by an
  orchestrator service (NOT by docker compose).
- An agent must not be able to access the host system or the owner's LAN.
- Agents must not interfere with each other (separate containers, volumes,
  networks).
- **A running agent turn continues when the browser disconnects** (phone
  locked, tab closed, network drop). Reconnecting shows the full thread.
  The browser is a view, never the session owner.
- Uses the owner's Claude subscription (Claude Code OAuth), not API keys.
- Web-based UI, good on a phone. NO terminal/PTY interface.
- Simplest system satisfying the above: single orchestrator process, SQLite,
  no Redis, no queue.

Non-goals for v1: multi-user auth (Traefik basicauth; 1–3 trusted users),
gVisor/Sysbox (later flag), egress domain allowlisting (a small proxy code
change later, §8.4/M7; LAN isolation IS in scope), fleet features.

## 2. Verified facts (source-inspected 2026-08-29; pin these versions)

The following was established by installing and reading the actual code of
`@agentclientprotocol/claude-agent-acp@0.70.0` (dist JS) and the `acp-ui`
repository (current main). Treat as ground truth for these pinned versions;
re-verify only when upgrading.

**Adapter — `@agentclientprotocol/claude-agent-acp` v0.70.0**
- Package name/rename confirmed on npm. Old `@zed-industries/claude-code-acp`
  is stale at 0.16.2 — do not use. Deps: `@agentclientprotocol/sdk@1.3.0`,
  `@anthropic-ai/claude-agent-sdk@0.3.232`.
- Binary `claude-agent-acp`, ACP over stdio, newline-delimited JSON-RPC.
  stdout is reserved for protocol; all console logging is redirected to
  stderr by the entrypoint. (Gateway must therefore demux Docker exec
  streams and treat stderr as log-only.)
- `initialize` response (read from source): `protocolVersion: 1`,
  `agentCapabilities.loadSession: true`, sessionCapabilities include
  `list/resume/fork/close/delete`, promptCapabilities `image` +
  `embeddedContext`, MCP http+sse, `promptQueueing: true` and a steering
  extension (follow-up injection into a running turn) via `_meta`.
- **Session persistence/replay is built in.** The adapter imports
  `listSessions/getSessionMessages` from the Claude Agent SDK and implements
  `session/load` (and `session/list`) by replaying persisted messages as
  `session/update` notifications. Sessions live under the Claude config dir
  → our per-session `/home/agent` volume. Consequence: **the gateway does
  not need its own replay store**; it forwards `session/load` upstream.
- Client-bound traffic, verified exhaustively from the client wrapper:
  `session/update` (notification), `session/request_permission` (request),
  `fs/read_text_file` + `fs/write_text_file` (requests), elicitation
  create/complete. fs and elicitation are used only per advertised client
  capabilities; acp-ui's web build advertises `fs: {readTextFile:false,
  writeTextFile:false}` and no elicitation/terminal. **Net client-bound
  surface the gateway must proxy: `session/update` notifications and
  `session/request_permission` requests. Nothing else.** Unknown methods
  still get a method-not-found response + warn log for forward-compat.
- Auth: the adapter passes ambient process env through to the Claude Agent
  SDK/CLI. `CLAUDE_CODE_OAUTH_TOKEN` appears explicitly in its
  provider-routing env list (alongside `ANTHROPIC_API_KEY`); env-based
  credentials are only overridden when a client explicitly configures a
  provider via `providers/set` (we don't). Claude Code documents
  `claude setup-token` output as valid headless credential. The only thing
  not verifiable without the owner's real token is the live round-trip;
  that is Milestone 1's first acceptance check, not a design unknown.
- Also ships `claude-agent-acp --cli …` which delegates to the wrapped
  claude CLI — useful for in-container debugging.

**Frontend — acp-ui (web build)**
- Build: `npm run build:web` → static bundle in `dist-web/` (Vite,
  `--mode web`). No published Docker image; we build our own static-server
  image (multi-stage: node build → nginx/caddy static).
- Protocol: sends `initialize` with `protocolVersion: 1`; uses v1 method
  names (`session/new`, `session/load`, `session/update`,
  `session/request_permission`). Wire-compatible with the adapter despite
  its older SDK dep (0.13.x) — verified in its source, not assumed.
- Resume flow is exactly our gateway contract, verbatim from its code:
  it clears messages then calls `session/load`, expecting the agent to
  stream the replay via `session/update` notifications. It gates resume on
  `agentCapabilities.loadSession`.
- WebSocket transport: one JSON-RPC message per WS text frame (binary
  rejected); offers subprotocols `['acp.v1', 'bearer.<token>']` when an
  `Authorization: Bearer <token>` header is configured on the agent —
  browsers cannot set real headers on WebSockets, so the token rides the
  subprotocol list. Server must select `acp.v1`. Sends a `$/ping` JSON-RPC
  *notification* every 25 s — per JSON-RPC, the gateway must NOT reply,
  just ignore it.
- No auto-reconnect mid-session by design, but it auto-reattaches when the
  tab/app regains focus (mobile-tested), which with `session/load` gives the
  lock-phone/unlock-phone flow we need.
- Agent config is per-origin `localStorage` (key `acp-ui:agents`), managed
  in its Settings UI. There is NO URL-prefill mechanism (verified: no query
  param handling). **But acp-ui is served at `/ui` on the same host as the
  dashboard, so it is the same origin — the dashboard writes acp-ui's agent
  config itself and navigates to `/ui`.** Onboarding is therefore a single
  "Open in acp-ui" button, not a copy/paste. See §8.5.
- Telemetry: embeds Azure Application Insights with an in-app disable
  toggle. Our build step strips the connection string (set it empty at
  build) so the self-hosted bundle phones home nowhere.

**Auth consequence (decided):** the `/ws` route bypasses Traefik basicauth —
browsers don't reliably attach Basic credentials to a cross-path WS upgrade
and cannot answer a 401 challenge on one. Instead the gateway itself
authenticates every WS upgrade by validating the `bearer.<token>` subprotocol
entry against `WS_AUTH_TOKEN` (long random string from `.env`), and selects
`acp.v1`. Everything else (dashboard, API, acp-ui static) stays behind
Traefik basicauth.

## 3. Architecture

```
                    Internet / phone browser
                              │ https / wss
                        ┌─────▼─────┐
                        │  Traefik  │ TLS; basicauth on all routes
                        └─────┬─────┘ EXCEPT /ws (token-authed by gateway)
              ┌───────────────┼──────────────────┐
              │ /ui (static)  │ /api, /ws, /     │
        ┌─────▼─────┐   ┌─────▼──────────────┐   │
        │  acp-ui   │   │   orchestrator     │◄──┘
        │ web build │   │   Node 22 / TS     │
        └───────────┘   │  ┌──────────────┐  │
                        │  │ ACP GATEWAY  │  │ downstream: ACP agent to N browsers
                        │  │              │  │ upstream: ACP client, 1 persistent
                        │  └──────────────┘  │           adapter conn per session
                        │  REST · SQLite ·   │
                        │  reaper            │
                        └───┬────────────────┘
                            │ /var/run/docker.sock
              ──────────────┼────────────────────────────────
        ┌─────────────────┐   ┌─────────────────┐  per-session containers,
        │ session-a1b2    │   │ session-c3d4    │  created at runtime:
        │ net sn-a1b2     │   │ net sn-c3d4     │  own network + volumes,
        │ claude-agent-acp│   │ claude-agent-acp│  adapter as long-lived exec,
        │ (exec, stdio)   │   │ (exec, stdio)   │  no docker socket
        └─────────────────┘   └─────────────────┘
```

The ACP client of record is the orchestrator. It holds one persistent stdio
connection per session to `claude-agent-acp` inside the container. Browser
churn never reaches the adapter: turns run to completion; browsers attach and
detach as views; thread state is replayed by the adapter's own
`session/load`. Toward browsers the orchestrator speaks ACP as an agent
(mostly transparent proxy with id remapping).

## 4. Tech stack (fixed)

| Concern        | Choice |
|----------------|--------|
| Orchestrator   | Node 22 + TypeScript, Fastify + `ws` |
| ACP plumbing   | `@agentclientprotocol/sdk` (^1.3, matching the adapter) on both gateway sides; never hand-rolled JSON-RPC |
| Docker API     | dockerode |
| DB             | better-sqlite3, WAL mode |
| Adapter        | `@agentclientprotocol/claude-agent-acp` **pinned 0.70.0** |
| Frontend       | acp-ui web build (pinned commit), telemetry stripped |
| Dashboard      | Preact + preact-iso (router) + @preact/signals; built by **esbuild only** (native JSX/TS + native CSS bundling, no plugins, no config framework); static output served by Fastify |

TypeScript everywhere, strict mode (`"strict": true`) in both packages.
esbuild transpiles but does not type-check: each package has a `check`
script (`tsc --noEmit`) that runs in its Docker build stage before esbuild,
so an image cannot be built from code that fails type-checking. REST
request/response shapes (session records, status enum, create bodies) live
in a single `shared/types.ts` imported by both the orchestrator handlers and
the dashboard's `api.ts` so the API boundary cannot drift silently.

## 5. Repository layout

```
/
├── compose.yaml
├── .env.example
├── plan.md
├── shared/
│   └── types.ts               # REST API shapes shared by orchestrator + dashboard
├── orchestrator/
│   ├── Dockerfile
│   └── src/
│       ├── index.ts           # Fastify bootstrap, routes
│       ├── config.ts          # env parsing (zod)
│       ├── db.ts              # sqlite init + migrations
│       ├── docker.ts          # container/network/volume lifecycle,
│       │                      #   long-lived exec spawn + demux
│       ├── gateway/
│       │   ├── upstream.ts    # persistent ACP client per session
│       │   ├── downstream.ts  # ACP agent over WS (token auth, remap,
│       │   │                  #   broadcast, $/ping ignore)
│       │   └── pending.ts     # queued permission requests
│       ├── sessions.ts        # lifecycle state machine + REST
│       └── reaper.ts          # turn-aware idle stop
├── dashboard/                 # Preact SPA, built into orchestrator image
│   ├── package.json           # deps: preact, preact-iso, @preact/signals
│   │                          # build: esbuild src/main.tsx --bundle
│   │                          #   --minify --outdir=dist  (dev: --watch
│   │                          #   --servedir; proxy /api to :3000)
│   ├── tsconfig.json          # jsx: react-jsx, jsxImportSource: preact
│   └── src/
│       ├── main.tsx           # mount + <Router> ('/', '/new', '/sessions/:id')
│       ├── api.ts             # typed fetch client for /api
│       ├── store.ts           # signals: sessions list, 5 s polling
│       ├── styles/
│       │   ├── tokens.css     # CSS custom properties: colors, spacing,
│       │   │                  #   type scale, radii — the only global vocab
│       │   └── base.css       # reset + element defaults; imports tokens
│       ├── views/
│       │   ├── SessionList.tsx    + SessionList.css
│       │   ├── SessionCreate.tsx  + SessionCreate.css
│       │   └── SessionDetail.tsx  + SessionDetail.css
│       └── components/
│           ├── SessionCard.tsx    + SessionCard.css
│           ├── StatusBadge.tsx    + StatusBadge.css
│           ├── CopyField.tsx      + CopyField.css   # wss URL + token copy
│           └── ConfirmDialog.tsx  + ConfirmDialog.css
│       # CSS rule: no inline styles, no Tailwind, no CSS-in-JS. Each
│       # component imports its co-located .css (esbuild bundles CSS
│       # natively); class names prefixed with the component name; global
│       # values only via tokens.css custom properties.
├── frontend/
│   └── Dockerfile             # multi-stage: clone acp-ui @ pinned commit,
│                              #   npm run build:web with empty AI conn
│                              #   string, serve dist-web via caddy/nginx
├── session-image/
│   ├── Dockerfile
│   └── entrypoint.sh
├── proxy/
│   ├── Dockerfile             # node:22-alpine, single bundled file
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts            # HTTP forward proxy + CONNECT (§8.4)
│       ├── cidr.ts            # pure resolved-IP vetting fn (unit-tested)
│       └── cidr.test.ts
└── scripts/
    └── smoke-test.sh
```

## 6. Configuration (.env)

```
BASE_DOMAIN=agents.example.com
DATA_DIR=/data
SESSION_IMAGE=boxes-session:latest
SESSION_SUBNET_POOL=10.200.0.0/16
SESSION_MEM_LIMIT=4g
SESSION_CPUS=2
SESSION_PIDS_LIMIT=512
IDLE_STOP_MINUTES=30
WS_AUTH_TOKEN=<64 random hex chars>     # validates bearer.<token> subprotocol
PERMISSION_FALLBACK=hold                # hold | deny after timeout below
PERMISSION_HOLD_MINUTES=120
NTFY_URL=                               # optional push when approval pending

PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  # `claude setup-token`
PROFILE_DEFAULT_GH_TOKEN=ghp_...                          # bot classic PAT
PROFILE_DEFAULT_GIT_NAME=mybot
PROFILE_DEFAULT_GIT_EMAIL=mybot@users.noreply.github.com
```

Secrets only in `.env` (0600) and session env vars; never in SQLite or logs.
Redact `*_TOKEN`/`*_KEY`/`Authorization` in logging.

## 7. SQLite schema

```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  profile        TEXT NOT NULL DEFAULT 'DEFAULT',
  repo_url       TEXT,
  image          TEXT NOT NULL,
  agent_cmd      TEXT NOT NULL,            -- JSON array
  container_id   TEXT,
  network_name   TEXT NOT NULL,
  subnet         TEXT NOT NULL,
  ws_volume      TEXT NOT NULL,
  home_volume    TEXT NOT NULL,
  status         TEXT NOT NULL,            -- creating|running|stopped|error|deleted
  acp_session_id TEXT,
  turn_active    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE TABLE pending_requests (             -- permission prompts awaiting a browser
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL, method TEXT NOT NULL,
  params TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE acp_log (                      -- debug tap; ring-pruned
  id INTEGER PRIMARY KEY, session_id TEXT, direction TEXT,
  ts INTEGER, payload TEXT
);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
```

No replay table: `session/load` replay is the adapter's job (§2). Prune
`acp_log` per session to the newest 5,000 rows on insert (trigger or
periodic).

## 8. Components

### 8.1 Session image
- Base `node:22-bookworm`; install git, gh, curl, ripgrep, jq,
  build-essential, python3.
- `npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp@0.70.0`
- Non-root `agent` (uid 1000); `WORKDIR /workspace`;
  `ENV CLAUDE_CONFIG_DIR=/home/agent/.claude`.
- `entrypoint.sh` (as agent): set git identity from env → `gh auth setup-git`
  if `GH_TOKEN` → clone `REPO_URL` into `/workspace/repo` if set and empty →
  `exec sleep infinity` (PID 1 only holds the container; the adapter runs as
  a gateway-owned exec).
- Env injected at create: `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, `GIT_NAME`,
  `GIT_EMAIL`, `REPO_URL`, `TERM=dumb`, and the proxy set (§8.4):
  `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy=http://proxy:3128`,
  `NO_PROXY=localhost,127.0.0.1`.

### 8.2 Container lifecycle (docker.ts)
Create (tear down on failure, status=error):
1. Subnet `10.200.<counter mod 256>.0/24` from pool.
2. `docker network create sn-<id> --subnet <subnet> --internal` (no NAT, no
   default route; all egress via the proxy, §8.4).
3. `docker network connect sn-<id> <egress-proxy container>` with alias
   `proxy`.
4. Volumes `ws-<id>`, `home-<id>`.
5. Container `session-<id>`: `User "agent"`, `NetworkMode sn-<id>`, mounts
   `ws-<id>→/workspace` and `home-<id>→/home/agent`, `ReadonlyRootfs: true`,
   `Tmpfs {"/tmp":"rw,size=512m"}`, `CapDrop ["ALL"]`,
   `SecurityOpt ["no-new-privileges:true"]`, Memory/NanoCpus/PidsLimit from
   env, `RestartPolicy no`, label `boxes.session=<id>`. NO bind mounts, NO
   docker.sock, NO published ports. HostConfig built from a fixed template;
   user input never reaches it.
6. Start; persist container_id.

Delete: SIGTERM (10 s) → rm container → disconnect proxy from network → rm
network; volumes kept unless `purge=true`. Boot reconciliation: list by
label, adopt/mark, and re-ensure proxy attachment on every session network
(also done by the 60 s reconcile loop, §8.4); Docker is runtime truth, DB is
metadata; upstream connections re-established lazily.

### 8.3 ACP gateway
Use the ACP TS SDK on both sides.

**Upstream (per session, persistent):**
- Spawn exec: `Cmd agent_cmd, AttachStdin/out/err, Tty:false, User "agent",
  WorkingDir "/workspace/repo"` (fallback `/workspace`), `hijack:true,
  stdin:true`. **Tty:false ⇒ demux with `docker.modem.demuxStream`**;
  stdout = newline-delimited JSON-RPC; stderr → orchestrator log (session-tagged).
- `initialize` as client with capabilities `{}` (no fs, no terminal, no
  elicitation) — verified (§2) this confines client-bound traffic to
  `session/update` + `session/request_permission`. Cache the full initialize
  response verbatim.
- First prompt ever: `session/new` (cwd `/workspace/repo`); store
  `acp_session_id`. After container/adapter restarts: `session/load` with the
  stored id (adapter replays from the home volume).
- `session/update`: bump `last_active_at`, broadcast to attached
  downstreams, tap to `acp_log`.
- Turn tracking: `turn_active=1` on forwarding `session/prompt`, cleared on
  its response or cancel.
- `session/request_permission`: if ≥1 downstream attached → forward to the
  most recently active one (remapped id); else queue in `pending_requests`,
  optionally POST `NTFY_URL`; adapter blocks meanwhile (correct). After
  `PERMISSION_HOLD_MINUTES` apply `PERMISSION_FALLBACK` (`deny` responds
  with the reject option from the request's own options list).
- Exec death: retry spawn ×3 with backoff, re-`session/load`; then
  status=error.

**Downstream (`GET /ws/sessions/:id/acp`):**
- Upgrade handling: require subprotocol list containing `acp.v1` and
  `bearer.<WS_AUTH_TOKEN>`; select `acp.v1`; else close 4401. One JSON-RPC
  message per WS text frame. Ignore `$/ping` notifications (never reply).
- Multiple browsers allowed; all get broadcasts; prompts accepted from any.
- `initialize`: answered locally with the cached upstream response
  (preserves `_meta` extensions: steering, promptQueueing).
- `session/new`: forward upstream only if no `acp_session_id` exists; if one
  exists, respond with the existing sessionId (one thread per Boxes session).
- `session/load`, `session/prompt`, `session/cancel`, `session/list`, mode/
  model setters: forward upstream with id remapping. On attach after replay,
  deliver any `pending_requests` with fresh downstream ids.
- Unknown methods either direction: JSON-RPC method-not-found + warn log.
- Downstream disconnect: drop from broadcast set; upstream unaffected — this
  property is the point of the gateway.
- Id remapping: gateway terminates JSON-RPC on both sides; own id counters
  per connection; two in-flight maps (up→down, down→up).

### 8.4 Network isolation: internal networks + egress proxy (no iptables)
Isolation is expressed entirely in Docker's own primitives; nothing touches
the host firewall and no service needs NET_ADMIN.

**Owner-accepted assumption (document in README):** nothing security-relevant
on the host is reachable/exploitable by an agent. Docker's internal-network
isolation filters forwarded traffic only, so the host itself remains
addressable at its per-bridge IP — host services bound to 0.0.0.0 (sshd,
published ports of other stacks) are reachable from a session. The owner has
explicitly accepted this residual surface; everything sensitive on this host
is assumed to sit behind its own auth. If that ever changes, the previously
designed DOCKER-USER/INPUT firewall sidecar is the documented retrofit.

**Design:**
- Every session network is created with `Internal: true`. No NAT, no default
  route: agents have zero L3 path to the LAN or the internet. Cross-session
  traffic is impossible at the network level (distinct internal networks).
- One `egress-proxy` compose service is the sole way out: **a purpose-built
  forward proxy, ~120 lines of TypeScript, Node stdlib only** (see spec
  below; no Squid, no third-party proxy, no runtime deps). The orchestrator
  connects it to each session network at session create
  (`docker network connect`, alias `proxy`) and disconnects it at delete.
  Session containers get `HTTP_PROXY=http://proxy:3128`,
  `HTTPS_PROXY=http://proxy:3128` (+ lowercase variants),
  `NO_PROXY=localhost,127.0.0.1`. git-over-HTTPS, gh, curl, npm, pip, and
  Claude Code all honor these (Claude Code documents HTTPS_PROXY support).
  Proxy-unaware raw-socket traffic simply has no route — a feature, not a gap.
- DNS: proxy-aware clients pass hostnames to the proxy (`CONNECT host:443`),
  so sessions need no external DNS at all; the proxy resolves via the Docker
  daemon DNS on its external network. Docker's embedded DNS still resolves
  the `proxy` alias inside each session network.

**Proxy spec (`proxy/src/main.ts`) — this is the security boundary between
sessions, so its rules are precise:**
- `http.createServer` on :3128 handling two cases: absolute-URI plain-HTTP
  requests (forward with `http.request`) and the `'connect'` event (CONNECT
  tunnel via `net.connect` + duplex pipe). Nothing else; no caching, no
  auth, no config file. Ports: allow only 80 (plain) and 443 (CONNECT);
  refuse everything else with 403.
- **Resolved-IP vetting (the critical rule):** for every request, resolve
  the target hostname with `dns.promises.lookup(host, { all: true })` and
  reject (403) if ANY returned address falls in: `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `127.0.0.0/8`,
  `100.64.0.0/10`, `0.0.0.0/8`, or (v6) `::1/128`, `fc00::/7`, `fe80::/10`,
  or any v4-mapped form of those. Then connect to the specific vetted IP —
  never re-resolve at connect time. Checking every address and pinning the
  connection to a vetted one is what closes DNS-rebinding: a hostname must
  not be able to pass the check with a public A record and connect with a
  private one. IP-literal targets go through the same CIDR check directly.
- The CIDR matcher lives in a pure function with unit tests (v4, v6,
  v4-mapped-v6, multi-answer records); the smoke test (§10) exercises the
  boundary end-to-end. Rationale for in-house vs off-the-shelf: tinyproxy
  filters by hostname regex only (rebind-vulnerable — disqualified); Squid
  and 3proxy pass but mean auditing a config dialect for a 30-line rule we
  can own in the project's own language. Fallback if the in-house proxy
  proves problematic: 3proxy (~1 MB, CIDR ACLs on resolved destinations).
- Same toolchain as everything else: strict TS, `tsc --noEmit` +
  esbuild-bundled single file, distroless/alpine Node image, read-only
  root fs, non-root user, no volumes.
- Fail-closed by construction: if the proxy is down or detached, sessions
  have no egress at all (internal networks have no other route).
- Proxy attachment reconciliation: `compose up` may recreate the proxy
  container, which drops its dynamic network attachments. The orchestrator
  therefore ensures attachments in three places: at session create, at boot
  reconciliation, and in a 60 s reconcile loop (`docker network connect` is
  idempotent-by-check). The orchestrator's healthz warns if any running
  session's network lacks the proxy.
- `SESSION_SUBNET_POOL` and the per-session /24 allocator remain (Docker
  still requires non-overlapping subnets), but no component consumes the
  pool CIDR for filtering anymore; the proxy's private-range check covers
  all of RFC1918 regardless of pool choice.

This shape upgrades cleanly: M7 egress allowlisting is adding a
`const ALLOWED_DOMAINS` check to the proxy — a small code change in a file
we own, not new infrastructure.

### 8.5 REST API + dashboard
`/api` (JSON; behind Traefik basicauth):
`POST /api/sessions {name, repo_url?, profile?}` (https:// URLs only) ·
`GET /api/sessions` (+live Docker state) · `GET /api/sessions/:id`
(incl. wss URL, turn_active, pending count) · `POST .../start|stop` ·
`DELETE ...?purge=` · `GET /api/sessions/:id/log?after=&limit=` ·
`GET /healthz` (no auth).

Dashboard: Preact SPA (see layout in §5), built by esbuild only — no Vite,
no bundler plugins — and served as static files by Fastify at `/` (SPA
fallback: unknown non-/api, non-/ws GETs return index.html). Orchestrator
Dockerfile is multi-stage: stage 1 runs the esbuild command in `dashboard/`,
stage 2 copies `dashboard/dist` into the runtime image. Views: session list
with "running turn"/"waiting for approval" badges; create form; session
detail with a single "Open in acp-ui" button (`dashboard/src/acpui.ts`):
it upserts this session into acp-ui's own `localStorage` agent list — legal
because `/ui` and `/` are the same origin — then navigates to `/ui`. Nothing
is typed, on any device.

Two things keep that from depending on guesswork about acp-ui's internals:
`frontend/Dockerfile` fails the image build if `acp-ui:agents` is absent from
the built bundle (so a key rename is loud, not a dead button), and when
acp-ui has already stored an agent we clone *that* entry's field shape rather
than imposing ours. The wss URL + token remain available via CopyField behind
a collapsed "Connect manually instead" disclosure as a safety net.
Data via the signals store polling `GET /api/sessions` every 5 s while the
tab is visible (pause on `visibilitychange`); SSE is an M7 upgrade, not v1.
Styling rules (enforced in review): no inline `style=` attributes, no
Tailwind, no CSS-in-JS; every component imports its co-located `.css`;
cross-component values only through `tokens.css` custom properties;
mobile-first with thumb-sized controls.

### 8.6 Reaper
Every minute, stop container iff: `turn_active=0` AND no pending_requests
AND no downstream attached AND idle > `IDLE_STOP_MINUTES`. Never auto-delete.
Lazy start: downstream attach or `POST start` → start container → upstream
respawn → `session/load` restores the thread.

### 8.7 compose.yaml
External Traefik network (name via env; default `traefik`):
- `orchestrator`: mounts `/var/run/docker.sock` + `/data` volume. Routers:
  (a) Host && (PathPrefix `/api` || `/dashboard` || Path `/`) → :3000,
  middleware basicauth; (b) Host && PathPrefix `/ws` → :3000, NO basicauth
  (gateway token-auths the upgrade, §2).
- `acp-ui`: `frontend/Dockerfile` static image; Host && PathPrefix `/ui`,
  basicauth.
- `egress-proxy`: `proxy/Dockerfile` (in-house TS proxy, §8.4); attached
  to the compose default network (external egress);
  `restart: unless-stopped`, no ports published, no Traefik labels. The
  orchestrator dynamically connects it to each session's internal network
  (§8.2/§8.4).
- Session containers: not in compose, not on the Traefik network.

## 9. Milestones

### M1 — Session image + live auth validation
Build image; run one container manually with the owner's real
`CLAUDE_CODE_OAUTH_TOKEN`. Acceptance: `docker exec … claude -p "reply ok"`
answers via subscription (no API key present), and a 10-line SDK script
driving `claude-agent-acp` over stdio completes initialize → session/new →
prompt → updates. (Design is verified; this validates the deployment's
credentials.)

### M2 — Orchestrator core
config/db/docker.ts, REST CRUD, boot reconciliation. Acceptance: full CRUD
via curl; resources created/destroyed; failure paths clean up.

### M3 — Gateway upstream
Persistent exec + ACP client, turn tracking, new/load, crash-retry.
Acceptance: prompt sent by a test script runs to completion after the script
disconnects; `session/load` from a fresh client replays the full thread.

### M4 — Gateway downstream + dashboard + frontend image
Token-authed WS, remapping, broadcast, pending queue, dashboard, acp-ui
static image (telemetry stripped). Acceptance (headline demo, on a phone):
create session with repo URL → tap "Open in acp-ui" → start a
multi-minute task → lock phone for its duration → unlock → completed thread
renders after reattach; then trigger a permission prompt with no browser
attached → dashboard shows waiting badge → attach → approve → turn continues.

### M5 — Reaper + durability
Turn-aware reaper, lazy start, orchestrator-restart recovery, NTFY push,
acp_log pruning. Acceptance: stop/start and orchestrator restart both
preserve threads.

### M6 — Hardening + GitHub flow
Egress proxy + reconcile loop (§8.4) + smoke-test.sh; bot flow:
`gh repo fork --clone`, push branch, `gh pr create`. Acceptance: smoke test
green immediately after a plain `docker compose up -d` on a clean host (no
manual host steps); smoke test green again after `docker compose up -d
--force-recreate egress-proxy` once the reconcile loop has run (proxy
reattachment proven); real PR opened by the bot from inside a session.

### M7 — Later (do not build unless asked)
gVisor via `SESSION_RUNTIME=runsc` · second provider row (Gemini CLI is
natively ACP; image+cmd swap) · egress domain allowlist (add an
ALLOWED_DOMAINS check to the in-house proxy — small code change) · GitHub App
installation tokens · dashboard approve/deny buttons.

## 10. Security smoke test (scripts/smoke-test.sh)
Inside a fresh session container, must FAIL: direct (proxy-bypassing)
egress: `curl --noproxy '*' -m3 https://api.github.com` and
`nc -w3 1.1.1.1 443` (internal network has no route); via-proxy access to
private space: `curl -m3 http://192.168.1.1` and `curl -m3
http://10.200.<other-session>.2:8080`-style targets, plus a hostname that
resolves to a private IP (rebind check; proxy's resolved-IP vetting);
cross-session direct: `nc -w3 <sibling session IP> 22` (distinct internal
networks); `ls /var/run/docker.sock`; `touch /usr/local/bin/x`; `git push`
to upstream default branch; fork bomb contained by pids-limit without
affecting host or sibling session.
Must SUCCEED (all via the injected proxy env): `curl https://api.github.com`;
`git ls-remote https://github.com/<bot>/<fork>`; `claude -p "reply ok"`;
writes to /workspace and /home/agent.
Documented-but-accepted (assert and log, don't fail): the host's per-bridge
IP may accept TCP on ports of 0.0.0.0-bound host services (§8.4 assumption).

## 11. Risks and mitigations (README material)
- **Version drift is the main residual risk.** Facts in §2 are pinned to
  adapter 0.70.0 and the inspected acp-ui commit. Pin both; on upgrade,
  re-check: initialize capabilities, client-bound method set, WS framing/
  subprotocol handling. The gateway's warn-on-unknown-method makes drift
  visible instead of silent.
- Prompt injection can leak session env tokens; bounded by read-only
  upstream collaborator, fork-only writes, rotatable classic PAT,
  inference-only Claude token. Rotate on suspicion.
- Orchestrator holds the Docker socket (root-equivalent): fixed HostConfig
  template, no shell-exec of user strings, behind Traefik auth.
- Network isolation rests on two legs: Docker `internal` networks (no route
  out) and the in-house proxy's resolved-IP vetting (proxy must not bridge
  sessions/LAN). That vetting code is ours, so it is unit-tested (cidr.ts)
  and exercised end-to-end by the smoke test, including the DNS-rebind case. The host itself remains reachable
  at per-bridge IPs — an owner-accepted assumption (§8.4); the firewall
  sidecar (git history) is the retrofit if that assumption ever fails.
- If the egress proxy is down or detached from a session network, agents
  lose all egress (fail-closed — they cannot fall back to a direct route).
  The 60 s reconcile loop plus the healthz warning cover recovery.
- Fine-grained GitHub PATs cannot access another user's private repos as a
  collaborator (documented GitHub gap) → classic PAT now; org migration is
  the upgrade path.
- `WS_AUTH_TOKEN` appears in browser localStorage (acp-ui agent config) —
  acceptable for a personal tool; rotate by editing .env + settings.

## 12. Fixed decisions
1. Persistent ACP gateway; orchestrator is the client of record (dumb pipe
   rejected: turns must survive disconnects).
2. Frontend = acp-ui web build, pinned, telemetry stripped; replay via the
   adapter's native `session/load` (no gateway replay store). Connecting is
   one button: acp-ui is same-origin with the dashboard, so the dashboard
   seeds its `localStorage` agent config directly (revision 4; supersedes the
   copy/paste onboarding, at the owner's request).
3. TypeScript/Node 22; ACP TS SDK both sides; adapter pinned 0.70.0.
4. Claude auth = `claude setup-token` env var (code-verified pass-through);
   fallback if the live check in M1 fails: primed `/home/agent/.claude`
   volume via `docker exec -it … claude /login`.
5. runc + hardening now; gVisor later behind a flag.
6. Traefik basicauth everywhere except `/ws`, which is gateway token-authed
   via the `bearer.<token>` subprotocol (browser WS header limitation).
7. GitHub: separate bot account, classic PAT, read-only on private
   upstreams, work on forks, PRs as merge gate.
8. Isolation = per-session `internal` Docker networks (from 10.200.0.0/16)
   + one in-house ~120-line TS egress proxy with resolved-IP private-range
   vetting, dynamically attached per session (3proxy is the off-the-shelf
   fallback). No iptables, no NET_ADMIN, no host configuration. Owner
   explicitly accepts that the host's per-bridge IP remains addressable
   (nothing exploitable assumed on the host); the firewall sidecar is the
   documented retrofit if that changes.
9. Unattended permission requests: hold (default), optional ntfy, timeout
   fallback configurable; never auto-approve.
10. Reaper stops (never deletes) only idle sessions with no active turn and
    nothing pending; lazy start on reconnect.
11. Dashboard = Preact + preact-iso + @preact/signals, built by esbuild
    alone (native JSX/TS + native CSS bundling); plain per-component CSS
    files + tokens.css; no inline styles, no Tailwind, no CSS-in-JS, no
    Vite/webpack. Owner explicitly chose minimal tooling over framework
    features; do not introduce additional build tooling without asking.
