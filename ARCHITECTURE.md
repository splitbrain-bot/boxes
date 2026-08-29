# Architecture

Boxes runs AI coding-agent sessions in isolated Docker containers and lets a
browser drive them over the Agent Client Protocol (ACP). One orchestrator
process owns everything: the REST API, the web assets, the agent connections,
the container lifecycle and the database.

This document describes how the system is put together. [`README.md`](./README.md)
covers running it and the risks that come with it.

## The property everything else serves

**A running agent turn continues when the browser disconnects.**

The orchestrator, not the browser, is the ACP client of record. It holds one
persistent stdio connection per session to the `claude-agent-acp` adapter
inside the session container. Browsers attach and detach as views, and nothing
a browser does reaches the adapter except the messages the gateway forwards.

Two consequences shape the rest of the design:

- The agent connection outlives any browser, so a long-lived process has to own
  it and be able to rebuild it without losing the thread.
- Thread history is replayed by the adapter's own `session/load` from the
  session's home volume, so the orchestrator stores no transcript of its own.

## Processes

```
                        phone or desktop browser
                                  │ https / wss
                    ┌─────────────▼─────────────┐
                    │  Traefik (optional)       │  TLS and basicauth,
                    └─────────────┬─────────────┘  except on /ws
                                  │
              ┌───────────────────▼───────────────────┐
              │            orchestrator               │
              │  /  dashboard   /api  REST            │
              │  /ui  acp-ui    /ws   ACP gateway     │
              │                                       │
              │  SQLite · reaper · Docker client      │
              └───┬───────────────────────────────┬───┘
                  │ /var/run/docker.sock          │ docker exec, stdio
   ┌──────────────▼──────────────┐                │
   │       egress proxy          │                │
   │  attached to every session  │                │
   │  network under the alias    │                │
   │  "proxy"                    │                │
   └──────┬───────────────┬──────┘                │
          │               │                       │
   ┌──────▼───────┐ ┌─────▼────────┐              │
   │ session-a1b2 │ │ session-c3d4 │◄─────────────┘
   │ net sn-a1b2  │ │ net sn-c3d4  │  claude-agent-acp runs as a
   │ (internal)   │ │ (internal)   │  long-lived exec, not as PID 1
   └──────────────┘ └──────────────┘
```

| Process | Built from | Role |
|---|---|---|
| orchestrator | `orchestrator/Dockerfile` | Serves every route, owns the sessions, holds the Docker socket |
| egress proxy | `proxy/Dockerfile` | The only route out of a session network |
| session container | `session-image/Dockerfile` | Runs the agent and the ACP adapter, one container per session |

The orchestrator and the proxy are compose services. Session containers are
created at runtime through the Docker API, so they appear in no compose file.
Traefik is optional: `compose.local.yaml` publishes port 3000 on loopback and
drops the Traefik network and labels.

## One origin, one port

The orchestrator serves everything a browser needs:

| Path | Handler |
|---|---|
| `/` | Dashboard bundle, with a single-page fallback |
| `/ui` | acp-ui bundle, built with `--base=/ui/` |
| `/api/...` | REST |
| `/ws/sessions/:id/acp` | ACP gateway |
| `/healthz` | Version, session count and proxy warnings |

A GET that matches no route falls back to the `index.html` of the bundle its
prefix belongs to, so client-side routes survive a reload. Anything under
`/api` or `/ws` gets a 404 instead.

Serving acp-ui from the orchestrator image, rather than from a second
container, puts it on the same origin as the dashboard. Three things follow:

- The dashboard can write acp-ui's `localStorage` agent config, which is what
  makes the one-click connect possible. Same-origin is the only way that is
  legal.
- The dashboard derives the WebSocket URL from the browser's own location, so
  no deployment setting can make it wrong and the API carries no endpoint URL.
- The whole stack runs behind one published port, with no reverse proxy.

## REST API

`orchestrator/src/index.ts` defines the routes; `SessionManager` does the work.
Request and response shapes live in `shared/types.ts`, which both the
orchestrator handlers and the dashboard's `api.ts` import.

| Method and path | Does |
|---|---|
| `GET /api/sessions` | Summaries of every live session |
| `POST /api/sessions` | Creates a session and returns it |
| `GET /api/sessions/:id` | One session with its Docker object names |
| `POST /api/sessions/:id/start` | Starts a stopped container |
| `POST /api/sessions/:id/stop` | Stops the container and drops the upstream |
| `DELETE /api/sessions/:id?purge=` | Deletes the session, and its volumes when purging |
| `GET /api/sessions/:id/log?after=&limit=` | A page of tapped ACP messages |

The API carries no authentication of its own. Behind Traefik, basicauth covers
every route but `/ws`; locally, the port binds to loopback.

## The ACP gateway

Two halves, in `orchestrator/src/gateway/`.

### Upstream: one connection per session

`upstream.ts` holds the connection to the adapter. `SessionManager` creates one
`UpstreamSession` per session on first use and keeps it for the process's life.

Starting it, in `ensureStarted`:

1. Start the container and make sure the egress proxy is attached.
2. Spawn `claude-agent-acp` as a `docker exec` with `Tty: false`. Docker frames
   stdout and stderr into one stream, so the streams are demuxed. stdout
   carries newline-delimited JSON-RPC; stderr is log-only.
3. Send `initialize` with empty client capabilities: no filesystem, no
   terminal, no elicitation. That confines adapter-to-client traffic to
   `session/update` and `session/request_permission`. The response is cached
   verbatim.
4. Replay the stored thread with `session/load`, or start a fresh one with
   `session/new` and store its id.

A spawn that fails is retried three times, waiting 1, 3 and 8 seconds. After
that the session's status becomes `error`.

The guard on `ensureStarted` is the cached `initialize` response rather than
the connection object. The connection exists as soon as the exec stream is
wired up, but its handshake takes a few hundred milliseconds, and a browser
arriving inside that window has to wait rather than be told the upstream is
unavailable.

A `session/load` that comes back with `resourceNotFound` is not a failure. The
agent SDK writes a transcript only once a prompt has run, so an id minted by
`session/new` and never prompted does not survive the container stopping. Any
other error is rethrown, which keeps a transient fault from discarding a live
thread.

When the adapter exits on its own, the connection is torn down and nothing
reconnects immediately. The next forwarded message calls `ensureStarted` again,
which re-spawns and re-issues `session/load`. A deliberate stop sets a flag
that suppresses even that.

### Downstream: one connection per browser

`downstream.ts` speaks ACP as an agent toward browsers. JSON-RPC terminates on
both sides, so each connection runs its own id space and the SDK correlates
request and response within it.

The upgrade at `/ws/sessions/:id/acp` is authenticated on the handshake. A
browser cannot set an `Authorization` header on a WebSocket, so acp-ui offers
the token as a `bearer.<token>` subprotocol entry alongside `acp.v1`. The
gateway compares it against `WS_AUTH_TOKEN` in constant time and selects
`acp.v1` explicitly, rather than relying on the client to list it first.

Three methods are answered or reshaped rather than forwarded:

- `initialize` returns the cached upstream response, so its `_meta` extensions
  reach the browser intact.
- `session/new` returns the session's existing ACP thread id when there is one.
  One Boxes session means one thread.
- `$/ping`, which acp-ui sends every 25 seconds, is dropped before the SDK sees
  it. JSON-RPC forbids replying to a notification.

Everything else in `FORWARDED_REQUESTS` and `FORWARDED_NOTIFICATIONS` goes
upstream untouched, `_meta` included. Adapter updates are broadcast to every
attached browser. Detaching removes the handle from the broadcast set and
touches nothing else.

### Permission requests

The adapter blocks on `session/request_permission` until it gets an answer,
which is the behaviour Boxes wants: an unattended turn pauses instead of
proceeding without consent.

- With browsers attached, the request goes to the most recently active one. If
  that browser vanishes mid-question, the request falls back to the queue
  rather than failing the turn.
- With none attached, the request is stored in `pending_requests` and, when
  `NTFY_URL` is set, a notification is posted. The next browser to attach gets
  every queued request delivered to it.
- After `PERMISSION_HOLD_MINUTES`, `PERMISSION_FALLBACK` decides. `hold` keeps
  waiting. `deny` answers with a reject option taken from the request's own
  options list, never an invented one, and cancels the request when none is
  offered. Nothing auto-approves.

## Session lifecycle

Creating a session, in `SessionManager.create`:

1. Validate the name and the optional repo URL, which must be `https://`.
2. Generate a session id server-side. User input never reaches a Docker object
   name.
3. Allocate a `/24` out of `SESSION_SUBNET_POOL` and insert the row as
   `creating`.
4. Create the network `sn-<id>`, attach the egress proxy, create the volumes
   `ws-<id>` and `home-<id>`, create the container `session-<id>`, and start it.

Any failed step tears the whole session down and marks it `error`.

The container's `HostConfig` is a fixed template that user input never reaches.
It runs as the non-root `agent` user with `ReadonlyRootfs`, `CapDrop: ALL`,
`no-new-privileges`, a tmpfs `/tmp`, memory, CPU and pids limits, and
`Init: true`. That last one matters: the kernel discards default-disposition
signals for PID 1, so without docker-init the entrypoint's `sleep` would never
see SIGTERM and every stop would wait out the grace period. The only
caller-supplied values are the session id, the repo URL, which travels as an
env var and never as argv, and the profile secrets.

The entrypoint sets the git and gh identity, clones `REPO_URL` into
`/workspace/repo` when the target is absent or empty, and then holds the
container open. The adapter is spawned separately by the gateway, so browser
churn never restarts the container.

| Status | Means |
|---|---|
| `creating` | The row exists, the Docker objects are being built |
| `running` | The container is up |
| `stopped` | Stopped deliberately, reaped, or found missing at boot |
| `error` | Creation failed, or the adapter would not start |
| `deleted` | Removed. Nothing moves a row out of this state |

Deleting stops and removes the container, detaches the proxy, removes the
network, and clears the session's pending requests and log rows. The volumes
survive unless `purge=true`, because they hold the agent's work and the
adapter's thread history.

At boot, `reconcile` lists containers by the `boxes.session` label and aligns
the stored rows with them: live containers are adopted, missing ones are marked
stopped, and every running session's proxy attachment is re-checked. Turn flags
are cleared, because a turn cannot survive the restart that killed the
connection owning it.

## Network isolation

Two legs, both in Docker's own primitives. Nothing touches the host firewall
and no service needs `NET_ADMIN`.

Every session network is created `internal`: no NAT, no default route. An agent
has no L3 path to the LAN, the internet, or another session. The egress proxy
is then attached to that network under the alias `proxy`, and the container
gets `HTTP_PROXY` and `HTTPS_PROXY` pointing at it. Every proxy-aware client
honours those; anything else has no route out, which is the intended failure
mode.

The proxy itself (`proxy/src/`) has no dependencies and handles two cases:
plain HTTP with an absolute request URI, and CONNECT. Only ports 80 and 443 are
allowed. Its critical rule is in `vetTarget`: resolve the hostname, reject if
**any** resolved address is private, then connect to one **vetted address**
without resolving again. Checking every answer and pinning the connection is
what closes DNS rebinding, since a hostname must not pass with a public record
and connect with a private one. `cidr.ts` holds the range checks; v4-mapped and
v4-compatible IPv6 forms are vetted as the IPv4 address they reach, and
unparseable input fails closed.

The design fails closed. If the proxy is down or detached, sessions have no
egress at all, because there is no direct route to fall back to.

## State, and where truth lives

Docker is the runtime truth. SQLite holds metadata, and the two are reconciled
at boot and on every read that reports container state.

`orchestrator/src/db.ts` opens the database in WAL mode under `DATA_DIR` and
applies migrations tracked by `user_version`.

| Table | Holds |
|---|---|
| `sessions` | One row per session: names, Docker object names, status, ACP thread id, timestamps |
| `pending_requests` | Permission requests waiting for a browser |
| `acp_log` | A debug tap of forwarded messages, ring-pruned to 5000 rows per session |
| `counters` | The subnet allocation counter |

Two kinds of state deliberately stay out of the database. Secrets live only in
the environment, in the session containers, and in the generated token file;
`log.ts` redacts anything credential-shaped before it reaches stderr. Thread
transcripts live in the session's home volume, read back by the adapter.

Pending requests are the one place where the database and memory both matter.
The row lets the dashboard show that something is waiting and survives a
restart; the resolver that answers the request is in memory only, so
`clearStale` drops rows left behind by a previous process.

## Background loops

| Loop | Interval | Does |
|---|---|---|
| Reaper (`reaper.ts`) | 60s | Stops sessions that are idle on all four counts: no running turn, no waiting permission request, no attached browser, and no activity for `IDLE_STOP_MINUTES`. It never deletes |
| Proxy reconciler (`reaper.ts`) | 60s | Re-attaches the egress proxy to every running session's network, because `compose up` can recreate the proxy container and drop its dynamic attachments. Sessions still missing it show up in `/healthz` |
| Maintenance | 60s, with the reaper | Prunes each session's debug log to its ring size |

The dashboard polls `GET /api/sessions` every 5 seconds while its tab is
visible, and pauses while it is hidden.

## Configuration and secrets

`config.ts` parses the environment once at boot with zod, so a misconfigured
deployment fails at startup rather than at first use. Every setting has a
working default, which is why the stack runs with no `.env` at all.

`WS_AUTH_TOKEN` is the exception, because a shipped default for a secret would
be a published password. Left unset, `secret.ts` generates a token on first
boot and writes it to `DATA_DIR/ws-auth-token` with mode 0600, so it survives
restarts and rebuilds. Setting the variable wins, which is also how the token
is rotated.

Profile credentials — the Claude token, the GitHub token and the git identity —
are injected into a session container at create time and nowhere else.

## Build-time pins

Two versions are pinned in Dockerfiles rather than in configuration, so the
running code is the code this commit names and no `.env` entry can change it:
the ACP adapter in `session-image/Dockerfile`, and the acp-ui commit in
`orchestrator/Dockerfile`.

The acp-ui build stage then asserts three things about the bundle it produced,
because each of them fails silently otherwise:

- The `acp-ui:agents` storage key is still present, so the connect button still
  has something to write.
- Assets are referenced under `/ui/`, so the bundle does not ask the dashboard's
  routes for its own files.
- No Application Insights connection string survived. acp-ui hardcodes it in
  source rather than reading it from the environment, so the build blanks that
  line and greps the result to prove the edit landed.

Every package type-checks before it bundles, in its own Docker stage, so an
image cannot be built from code that fails `tsc --noEmit`.

## Code map

```
orchestrator/src/
  index.ts              Routes, static bundles, WS upgrade, boot and shutdown
  config.ts             Environment parsing, one pass at boot
  secret.ts             WS auth token: configured, stored, or generated
  db.ts                 SQLite, schema migrations, the debug log
  sessions.ts           Session lifecycle, the owner of every UpstreamSession
  docker.ts             Containers, networks, volumes, the adapter exec
  subnet.ts             Per-session /24 allocation
  reaper.ts             The idle reaper and the proxy reconciler
  log.ts                Structured stderr logging with secret redaction
  gateway/
    upstream.ts         One persistent ACP client per session
    downstream.ts       One ACP agent connection per browser
    pending.ts          Permission requests waiting for an answer

proxy/src/
  main.ts               The forward proxy: absolute-URI HTTP and CONNECT
  cidr.ts               Resolved-IP vetting, the security boundary

dashboard/src/
  store.ts              Polled session list, as signals
  api.ts                Typed fetch client
  acpui.ts              One-click connect: writes acp-ui's agent config
  views/, components/   Preact views and their co-located CSS

shared/types.ts         REST shapes, imported by both sides
session-image/          The per-session container image and its entrypoint
scripts/                Security smoke test and credentialed live test
```

## Testing

`scripts/smoke-test.sh` is the security gate and needs no credentials. It
creates two throwaway sessions and asserts the isolation properties from inside
one of them: no proxy-bypassing egress, no private-range access through the
proxy, no cross-session reachability, no docker socket, a read-only root
filesystem, a contained fork bomb, and that the intended egress and writes do
work. Every probe passes `curl -f`, so a 403 from the proxy leaves a non-zero
exit status.

`scripts/live-test.sh` covers what only a real inference call can prove:
subscription auth inside the container, a turn running to completion after the
browser leaves, the thread replaying on reattach, and a permission request held
with nobody watching.

Unit tests cover the pure logic that is easiest to get quietly wrong: the
proxy's range checks, subnet allocation, the WebSocket upgrade check, and the
acp-ui config write, which is asserted against a copy of acp-ui's own reader
rather than against the output shape.
