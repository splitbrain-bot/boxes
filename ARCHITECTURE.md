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
                    │  any reverse proxy        │  TLS and authentication,
                    │  (optional)               │  except on /ws
                    └─────────────┬─────────────┘
              ┌───────────────────▼───────────────────┐
              │            orchestrator               │
              │  /  dashboard   /api  REST            │
              │                 /ws   ACP gateway     │
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

`compose.yaml` publishes one port, on loopback, and names no reverse proxy:
what sits in front is a deployment decision, not part of the system. The one
constraint it places on that decision is that `/ws` must not be behind HTTP
authentication — see below.

## One origin, one port

The orchestrator serves everything a browser needs:

| Path | Handler |
|---|---|
| `/` | Dashboard bundle, with a single-page fallback |
| `/api/...` | REST |
| `/ws/sessions/:id/acp` | ACP gateway |
| `/healthz` | Version, session count and proxy warnings |

A GET that matches no route falls back to the dashboard's `index.html`, so
client-side routes survive a reload. Anything under `/api` or `/ws` gets a
404 instead.

The dashboard is the only frontend, and it is served from the orchestrator's
own image. Two things follow:

- The browser derives the WebSocket URL from its own location, so no
  deployment setting can make it wrong and the API carries no endpoint URL.
- The whole stack runs behind one published port, with no reverse proxy.

## REST API

`orchestrator/src/app.ts` defines the routes; `SessionManager` does the work.
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
| `POST /api/sessions/:id/exec` | Runs one command in the container, streaming its output |
| `GET /api/sessions/:id/exec` | Commands already run in this session |

The API carries no authentication of its own; a reverse proxy is expected to
provide it for `/` and `/api`, and the published port binds to loopback so
that an unproxied deployment is not an exposed one. `/ws` is the exception in
both directions: it must *not* be behind HTTP authentication, because a
browser cannot attach Basic credentials to a WebSocket upgrade, and it does
not need to be, because the gateway authenticates the upgrade itself.

### Local commands

A composer line starting with `!` is a local command: the dashboard
intercepts it, so it never reaches the model, costs no tokens, and cannot be
read as an instruction.

`exec.ts` runs it as `bash -lc <command>` inside the session container, as the
non-root `agent` user, in the container's existing isolation — internal
network, read-only rootfs, capabilities dropped. No new privilege is
introduced, and nothing shell-executes on the host: the command travels as an
argument to the container's own shell and never reaches a host command line.

The response is chunked `text/plain` rather than JSON, so the browser can
render the output as it arrives, and ends with a trailer line carrying the
exit code and whether either limit was hit. Both limits are enforced by the
orchestrator rather than trusted to the container: 120 seconds of wall clock
and 256 KiB of output, after which the exec is killed. Finished runs go into
`exec_log`, ring-pruned per session.

The browser appends stored runs *after* whatever the replay produced rather
than interleaving them. ACP replay carries no timestamps, so where they belong
in the transcript is not recoverable.

## The frontend

One React app, served at `/`. The session list is the thread list: tapping a
session opens its conversation at `/sessions/:id`, and the ops that used to
share that page — start, stop, delete, the details, the connection fields for
an external ACP client — live at `/sessions/:id/info`.

The chat itself is [assistant-ui](https://www.assistant-ui.com/). Its
components are installed into `src/components/assistant-ui/` by the official
CLI, in the shadcn distribution model: the sources are committed and are ours
to edit, and an upgrade is a CLI re-run reviewed as a diff rather than a
version bump that changes the UI silently. Three edits are ours so far, each
marked in the source: ArrowUp history on the composer, returning focus after
a send, and opening a tool group when a call inside it is waiting on the user.

Because those components are written in Tailwind utilities, Tailwind is a
build dependency rather than a style choice, and it compiles from source on
every build. `globals.css` is the whole design system: the tokens, and the
`@theme inline` block bridging them into Tailwind colours. That bridge is a
correctness requirement, not theming polish — Tailwind v4 emits a utility only
for a colour its theme defines, so without it `bg-background` and every other
token utility the installed components use would silently vanish.

The browser speaks plain ACP to the gateway, so it is a client like any other
and the gateway stays client-agnostic. That is not only tidiness: this
dashboard replaced a separate chat application served alongside it, and the
gateway needed no protocol change to swap one for the other. An external ACP
client still attaches to the same endpoint, with the URL and token from
`/sessions/:id/info`.

```
AcpClient    ⇄ /ws/sessions/:id/acp     JSON-RPC over one WebSocket
translate.ts   session/update*       →  an append-only message model (pure)
thread-store   the live thread          messages, modes, approvals, exec
convert.ts     that model            →  what useExternalStoreRuntime reads
```

`translate.ts` being pure is what makes replay and live streaming the same
code path: a reconnect repeats the handshake, `session/load` re-sends the
history as ordinary notifications, and folding them rebuilds the thread. An
update kind this build predates is kept and rendered as nothing, so a newer
adapter cannot break an older dashboard.

Two behaviours are worth knowing because they look like bugs otherwise. A turn
blocked on a permission request reports itself as *not running* — it is
waiting for the user, and the runtime derives a message's requires-action
status from its unresolved approval only while the thread is idle, so claiming
otherwise would hide the very question holding up the turn. And ACP's
permission vocabulary maps onto assistant-ui's approval vocabulary by rename
alone: `allow_once` to `allow-once`, `optionId`/`name` to `id`/`label`.

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
browser cannot set an `Authorization` header on a WebSocket, so a client
offers the token as a `bearer.<token>` subprotocol entry alongside `acp.v1`.
The gateway compares it against `WS_AUTH_TOKEN` in constant time and selects
`acp.v1` explicitly, rather than relying on the client to list it first.

Three methods are answered or reshaped rather than forwarded:

- `initialize` returns the cached upstream response, so its `_meta` extensions
  reach the browser intact.
- `session/new` returns the session's existing ACP thread id when there is one.
  One Boxes session means one thread.
- `$/ping`, which some ACP clients send every 25 seconds, is dropped before the
  SDK sees it. JSON-RPC forbids replying to a notification. The dashboard
  sends none.

Everything else in `FORWARDED_REQUESTS` and `FORWARDED_NOTIFICATIONS` goes
upstream untouched, `_meta` included. Detaching removes the handle from the
broadcast set and touches nothing else.

### Who each update goes to

`broadcast.ts` decides. Sending every update to every browser is almost
right, and wrong in two places that only appear with more than one attached —
a phone and a desktop watching the same session.

- **A forwarded prompt is echoed to every browser, the sender included.** The
  adapter is only required to replay a prompt later, not to echo it live, so
  without this the browser that sent it shows nothing until its next reload.
  While the gateway is echoing, an adapter that *does* echo is suppressed, so
  either kind of adapter produces exactly one copy. Replay is exempt: there
  the adapter is reading back history the gateway never saw.
- **A replay goes only to the browser that asked for it.** `session/load` is
  by definition a re-send of the whole thread, so broadcasting it rendered
  every other open tab's conversation twice.

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
| `exec_log` | Local commands and their output, ring-pruned to 200 rows per session |
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

That file is the only place a default is written down, and the only place
that knows which settings exist. `compose.yaml` hands the orchestrator an env
file wholesale (`BOXES_ENV`, defaulting to `.env` and optional) and names
nothing in it, so adding a setting means editing the schema and nothing else.
The two values it does set, `DATA_DIR` and `EGRESS_PROXY_CONTAINER`, are not
defaults being restated: they name the volume mount and the container that
same file creates, and are placed after the env file so that one cannot
change them and break the wiring.

An empty value counts as unset. `NTFY_URL=` in an env file arrives as an
empty string, and failing the boot on a setting nobody set would be a poor
way to read it.

`WS_AUTH_TOKEN` is the exception, because a shipped default for a secret would
be a published password. Left unset, `secret.ts` generates a token on first
boot and writes it to `DATA_DIR/ws-auth-token` with mode 0600, so it survives
restarts and rebuilds. Setting the variable wins, which is also how the token
is rotated.

Profile credentials — the Claude token, the GitHub token and the git identity —
are injected into a session container at create time and nowhere else.

## Build-time pins

The ACP adapter version is pinned in `session-image/Dockerfile` rather than in
configuration, so the running agent is the one this commit names and no `.env`
entry can change it.

Frontend dependencies are pinned in `dashboard/package.json` and resolved by
`package-lock.json`, which every Docker stage installs with `npm ci` rather
than `npm install`. `@assistant-ui/react` and `@assistant-ui/react-markdown`
carry exact versions rather than ranges: the composer's history behaviour
comes from a hook upstream documents as unstable, so the version that behaves
is the version that ships.

Every package type-checks before it bundles, in its own Docker stage, so an
image cannot be built from code that fails `tsc --noEmit`.

## Code map

```
orchestrator/src/
  index.ts              Boot, the WS upgrade, the background loops, shutdown
  app.ts                REST routes, the exec endpoint, the static bundle
  exec.ts               Local commands: limits, streaming, the exec log
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
    broadcast.ts        Which browsers each adapter update goes to
    pending.ts          Permission requests waiting for an answer

proxy/src/
  main.ts               The forward proxy: absolute-URI HTTP and CONNECT
  cidr.ts               Resolved-IP vetting, the security boundary

dashboard/
  index.html            Vite entry; sets the dark class before first paint
  vite.config.ts        React, Tailwind, the dev proxy, both test projects
  components.json       Where the shadcn and assistant-ui CLIs install to
  e2e/                  Browser tests, and the stub orchestrator and gateway
  src/
    main.tsx            React mount and the routes
    globals.css         The whole design system: tokens and the @theme bridge
    api.ts              Typed fetch client
    stores/
      sessions.ts       Polled session list, read by useSyncExternalStore
      thread/
        acp-types.ts    The slice of the ACP schema the browser speaks
        acp-client.ts   JSON-RPC over the WebSocket, and the handshake
        translate.ts    session/update notifications → a message model (pure)
        thread-store.ts The live thread: messages, modes, approvals, exec
        convert.ts      That model in the shape the runtime reads
        exec.ts         !bang commands against the exec endpoint
    views/              SessionList, SessionCreate, SessionThread, SessionInfo
    components/
      assistant-ui/     Installed registry sources, ours to edit
      ui/               Installed shadcn primitives

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
proxy's range checks, subnet allocation, the WebSocket upgrade check, update
routing with two browsers attached, the exec limits, and the translation of
ACP notifications into the thread's message model — including replay,
out-of-order tool updates, and an update kind this build predates.

The dashboard also runs a browser suite. It builds the production bundle and
serves it the way the orchestrator does, from a stub orchestrator and a stub
ACP gateway that speaks the agent side from canned scripts. That is what
asserts the six UX properties this frontend exists for, and it is where a
component upgrade is reviewed: `/playground` renders every part kind over a
canned store, so a registry re-run shows up on one page.

One runner throughout: `npm test` in each package is `vitest run`.
