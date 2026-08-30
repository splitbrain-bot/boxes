# Boxes — personal AI agent orchestrator

Runs AI coding-agent sessions (Claude Code first, other ACP agents later) in
isolated Docker containers, controlled from a mobile-friendly web UI. It runs
behind an existing Traefik reverse proxy, or on a single local port with no
proxy at all.

How the system is put together is described in
[`ARCHITECTURE.md`](./ARCHITECTURE.md). This README covers running it and the
risks you are accepting by doing so.

## The one property that matters

**A running agent turn continues when the browser disconnects.** Lock your
phone mid-task, come back later, and the completed thread is there.

That works because the orchestrator — not the browser — is the ACP client of
record. It holds one persistent stdio connection per session to
`claude-agent-acp` inside the session container. Browsers attach and detach
as *views*; thread replay on reattach is the adapter's own `session/load`,
replayed from the session's home volume.

```
phone ──wss──▶ Traefik ──▶ orchestrator ──docker exec stdio──▶ claude-agent-acp
                            (ACP gateway)                       (in container)
   detaching here ─────────────┘  changes nothing upstream ────────────▲
```

## Layout

| Path | What |
|---|---|
| `orchestrator/` | Node 22 + TS: REST, SQLite, Docker lifecycle, ACP gateway, reaper |
| `dashboard/` | React SPA — session list and chat — served by the orchestrator at `/` |
| `proxy/` | The in-house egress proxy — the security boundary |
| `session-image/` | The per-session container image |
| `shared/types.ts` | REST shapes imported by both orchestrator and dashboard |
| `scripts/smoke-test.sh` | Security smoke test, no credentials needed |
| `scripts/live-test.sh` | The checks that need a real Claude token |

## Setup

**There is no configuration step.** Every setting has a working default, so
this is the whole local install:

```
docker build -t boxes-session:latest session-image/   # not part of compose
docker compose -f compose.yaml -f compose.local.yaml up -d
```

That serves everything on <http://localhost:3000>. The override publishes port
3000 on loopback and drops the Traefik network and labels; it has no
basicauth, which is why it binds to loopback only. Do not use it on a shared
or exposed host.

`WS_AUTH_TOKEN` has no default because a shipped secret is not a secret. The
orchestrator generates one on first boot instead and keeps it in the data
volume at `/data/ws-auth-token` (mode 0600), so it survives restarts. Set the
variable to pin or rotate it.

To run an agent turn you need one credential: a Claude token from
`claude setup-token`, as `PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`. Sessions
and the gateway work without it; only inference fails. See [Keeping the token
out of `.env`](#keeping-the-token-out-of-env).

**Behind Traefik** instead, `docker compose up -d`, with two values that
cannot have defaults — a domain and a password:

```
BASE_DOMAIN=agents.example.com
BASICAUTH_USERS=owner:$$apr1$$...      # htpasswd -nB owner, $ escaped as $$
```

Leave `BASICAUTH_USERS` unset and the proxied routes reject every request,
which is the right way for an unconfigured deployment to fail. `.env.example`
lists every other override; copy it only when you want to change something.

**Verify isolation:** `API_BASE=http://localhost:3000 ./scripts/smoke-test.sh`

5. **Use it.** Open `/`, create a session, and tap its card. That is the
   conversation — one tap from the list, nothing to configure, on any device.
   The ⓘ corner of a card opens the same session's controls and details.

   A stopped session is fine to open: attaching starts the container, and the
   adapter replays the thread.

## One origin

The orchestrator serves everything on one port: the dashboard at `/`, the API
at `/api`, and the gateway at `/ws`. The dashboard is built into the
orchestrator image and served from there, so there is no second frontend
service and no second origin.

That carries two things:

- **Nothing needs configuring.** The browser derives the WebSocket URL from
  its own location, so it is right behind TLS and right on `localhost` with no
  setting to get wrong. There is no `wsUrl` in the API for a deployment to
  disagree with.
- **The stack runs with no reverse proxy.** One service, one published port.

## Keeping the token out of `.env`

`.env` is an ordinary file in the working directory. Anything with access to
that directory can read it — including a coding agent you run in this repo.
It is gitignored, not hidden.

If you would rather the Claude token not sit there, either works:

- **Keep the file elsewhere.** Nothing requires it to be in the repo:
  ```
  docker compose --env-file ~/.config/boxes.env -f compose.yaml -f compose.local.yaml up -d
  ```
- **Skip the token entirely and log in inside the session.** No token then
  exists in any file or in the container's environment — the credential lands
  in that session's own home volume:
  ```
  docker exec -it session-<id> claude /login
  ```

Either way the value is still visible to anything that can run `docker
inspect` or `docker exec` on this host, so treat these as "not lying around in
the repo", not as isolation. The token is inference-only and rotatable; see
[Risks you are accepting](#risks-you-are-accepting) for what it can and cannot
do if it leaks.

## How isolation works

Two legs, both in Docker's own primitives — nothing touches the host firewall
and no service needs `NET_ADMIN`:

1. **Every session network is `internal`.** No NAT, no default route. An agent
   has zero L3 path to the LAN, the internet, or another session.
2. **One egress proxy is the sole way out.** `proxy/` is ~250 lines of
   dependency-free TypeScript, attached to each session network at create
   time with the alias `proxy`. Sessions get `HTTP_PROXY`/`HTTPS_PROXY`
   pointing at it.

The proxy's critical rule: resolve the target, reject if **any** resolved
address is private, then connect to a **specific vetted address** without
re-resolving. Checking every answer and pinning the connection is what closes
DNS rebinding — a hostname must not pass with a public A record and connect
with a private one. v4-mapped IPv6 forms (`::ffff:192.168.1.1`) are vetted as
the IPv4 address they actually reach, and unparseable input fails closed.
That logic is `proxy/src/cidr.ts`, unit-tested and exercised end-to-end by the
smoke test.

Fail-closed by construction: if the proxy is down or detached, sessions have
no egress at all. There is no direct route to fall back to.

Session containers additionally run non-root, with `ReadonlyRootfs`,
`CapDrop: ALL`, `no-new-privileges`, a tmpfs `/tmp`, and memory/CPU/pids
limits. No bind mounts, no docker socket, no published ports.

## Risks you are accepting

- **The host stays addressable at its per-bridge IP.** Docker's
  internal-network isolation filters *forwarded* traffic only, so host
  services bound to `0.0.0.0` (sshd, other stacks' published ports) are
  reachable from inside a session. This is an explicitly accepted residual
  surface: everything sensitive on this host is assumed to sit behind its own
  auth. The smoke test asserts and logs it rather than failing. If that
  assumption ever stops holding, the retrofit is a DOCKER-USER/INPUT firewall
  sidecar.
- **Version drift is the main residual risk.** The protocol facts this is
  built on are pinned to `claude-agent-acp` 0.70.0. On upgrade, re-check:
  initialize capabilities, the client-bound method set, and WS
  framing/subprotocol handling. Unknown methods get a JSON-RPC
  method-not-found rather than silent misbehaviour, and an unknown
  `session/update` kind renders as nothing rather than breaking the thread,
  so drift is visible without being fatal.
- **Prompt injection can leak session env tokens.** Bounded by: read-only
  access on upstream private repos, fork-only writes, a rotatable classic PAT,
  and an inference-only Claude token. Rotate on suspicion.
- **The orchestrator holds the Docker socket** (root-equivalent). Mitigated by
  a fixed `HostConfig` template that user input never reaches, no shell-exec
  of user strings, and Traefik basicauth in front.
- **`WS_AUTH_TOKEN` is returned by `GET /api/sessions`**, which is behind the
  same basicauth as the rest of `/api`. The dashboard reads it from there and
  holds it in memory for the length of a page view; it is never written to
  browser storage. Acceptable for a personal tool; rotate by editing `.env`
  and restarting.
- **`!bang` commands run arbitrary shell in the session container.** They add
  no privilege — the agent can already run anything there, and the command
  goes to the container's own shell as an argument, never to a host command
  line — but they are as powerful as the container is, so the basicauth in
  front of `/api` is what keeps them yours.
- **Fine-grained GitHub PATs cannot act as a collaborator on another user's
  private repos** (a documented GitHub gap), hence the classic PAT. Migrating
  the repos to an org is the upgrade path.

## Why `/ws` bypasses basicauth

Browsers do not reliably attach Basic credentials to a cross-path WebSocket
upgrade and cannot answer a 401 challenge on one. So the gateway authenticates
the upgrade itself: the client offers `['acp.v1', 'bearer.<token>']` as
subprotocols, the gateway validates the token against `WS_AUTH_TOKEN` in
constant time and selects `acp.v1`. Everything else stays behind basicauth.

## Development

One toolchain across the repository. Every package builds with Vite and tests
with Vitest, and every Docker build runs `tsc --noEmit` *before* the bundle,
so an image cannot be built from code that fails type-checking.

```
cd orchestrator && npm run check && npm test
cd proxy        && npm run check && npm test
cd dashboard    && npm run check && npm test && npm run build
```

The dashboard's `npm test` runs two projects: `unit` for the framework-free
stores, and `e2e`, which builds the production bundle and drives it in
Chromium against a stub orchestrator and a stub ACP gateway. `npm run dev`
serves the app with `/api`, `/healthz` and `/ws` proxied to a local
orchestrator on port 3000.

`scripts/smoke-test.sh` needs no credentials and is the security gate.
`scripts/live-test.sh` covers what only a real inference call can prove —
subscription auth, a turn surviving the browser leaving, thread replay on
reattach, and a permission request held with nobody watching — so it needs
`PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN` set.

### Frontend conventions

The dashboard's dependencies dictate its stack rather than the other way
round: assistant-ui's components are written in Tailwind utilities, so
Tailwind compiles from source on every build and is the one styling system.
Rules, enforced in review: Tailwind utilities and shadcn/assistant-ui
components everywhere, no inline `style=`, no CSS-in-JS, and design tokens
defined once in `src/globals.css` — including the `@theme inline` bridge,
without which Tailwind silently drops every token utility.

Components under `src/components/assistant-ui/` and `src/components/ui/` are
installed by their official CLIs and committed. They are ours to edit, and the
edits we have made carry a comment saying so. Upgrade by re-running the CLI
with `--overwrite` and reading the diff:

```
cd dashboard
npx assistant-ui add thread --overwrite     # or: npx shadcn add <name> --overwrite
npm run check && npm test
```

`/playground` renders every part kind over a canned store, which is where that
diff is reviewed by eye. The browser suite asserts the same page, so a
regression in an upgraded component fails the build rather than surprising you
in a live session.
