# Boxes — personal AI agent orchestrator

Runs AI coding-agent sessions (Claude Code first, other ACP agents later) in
isolated Docker containers, controlled from a mobile-friendly web UI. It runs
behind an existing Traefik reverse proxy, or on a single local port with no
proxy at all.

The design, decisions and milestones live in [`plan.md`](./plan.md). This
README covers running it and the risks you are accepting by doing so.

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
| `dashboard/` | Preact SPA, esbuild only, served by the orchestrator at `/` |
| `proxy/` | The in-house egress proxy — the security boundary |
| `session-image/` | The per-session container image |
| `shared/types.ts` | REST shapes imported by both orchestrator and dashboard |
| `scripts/smoke-test.sh` | Security smoke test (plan §10), no credentials needed |
| `scripts/live-test.sh` | The checks that need a real Claude token (plan M1, M3, M4) |

acp-ui has no directory of its own: the orchestrator image clones it at a
pinned commit, builds it, and serves it at `/ui`. That is deliberate — see
[One origin](#one-origin).

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

5. **Connect.** Open `/`, create a session, and tap **Open** on its card.
   That's it — one tap from the list, nothing to type, on any device.

   acp-ui has no URL-prefill mechanism, but it is the same origin as the
   dashboard, so its `localStorage` agent config is ours to write. The button
   upserts this session into acp-ui's agent list and navigates there. The
   session detail view has the same button, plus a collapsed "Connect manually
   instead" disclosure with the URL and token as a fallback.

## One origin

The orchestrator serves everything on one port: the dashboard at `/`, the API
at `/api`, the gateway at `/ws`, and acp-ui at `/ui`. acp-ui is cloned at a
commit pinned in `orchestrator/Dockerfile`, built into the orchestrator image,
and served from there. That pin is a build dependency, like the adapter
version in `session-image/Dockerfile` — it is not deployment configuration and
no `.env` entry can change it.

That single property carries a lot of weight:

- **The connect button works at all.** Writing acp-ui's `localStorage` is only
  legal from the same origin.
- **Nothing needs configuring.** The dashboard derives the WebSocket URL from
  the browser's own location, so it is right behind TLS and right on
  `localhost` with no setting to get wrong. There is no `wsUrl` in the API for
  a deployment to disagree with.
- **The stack runs with no reverse proxy.** One service, one published port.

Three things about acp-ui are asserted at image build time, because each fails
silently otherwise: its `acp-ui:agents` storage key still exists, the bundle
references its assets under `/ui/`, and no Application Insights connection
string survived into it. A failed assertion names the file to update.

## Keeping the token out of `.env`

`.env` is an ordinary file in the working directory. Anything with access to
that directory can read it — including a coding agent you run in this repo.
It is gitignored, not hidden.

If you would rather the Claude token not sit there, either works:

- **Keep the file elsewhere.** Nothing requires it to be in the repo:
  ```
  docker compose --env-file ~/.config/boxes.env -f compose.yaml -f compose.local.yaml up -d
  ```
- **Skip the token entirely and log in inside the session.** This is plan
  §12.4's fallback, and it means no token exists in any file or in the
  container's environment — the credential lands in that session's own home
  volume:
  ```
  docker exec -it session-<id> claude /login
  ```

Either way the value is still visible to anything that can run `docker
inspect` or `docker exec` on this host, so treat these as "not lying around in
the repo", not as isolation. The token is inference-only and rotatable; plan
§11 covers what it can and cannot do if it leaks.

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
  built on are pinned to `claude-agent-acp` 0.70.0 and a pinned acp-ui commit.
  On upgrade, re-check: initialize capabilities, the client-bound method set,
  and WS framing/subprotocol handling. Unknown methods get a JSON-RPC
  method-not-found rather than silent misbehaviour, so drift is visible.
- **Prompt injection can leak session env tokens.** Bounded by: read-only
  access on upstream private repos, fork-only writes, a rotatable classic PAT,
  and an inference-only Claude token. Rotate on suspicion.
- **The orchestrator holds the Docker socket** (root-equivalent). Mitigated by
  a fixed `HostConfig` template that user input never reaches, no shell-exec
  of user strings, and Traefik basicauth in front.
- **`WS_AUTH_TOKEN` lives in browser localStorage** (acp-ui's agent config).
  It is also returned by `GET /api/sessions`, which is behind the same
  basicauth as the rest of `/api`. Acceptable for a personal tool; rotate by
  editing `.env` and tapping **Open** again, which overwrites the stored entry
  in place.
- **The one-click connect depends on acp-ui's storage key and its stored
  shape.** If acp-ui renames `acp-ui:agents`, the *image build fails* with a
  pointer to the two places to update (`dashboard/src/acpui.ts` and the
  `ACP_UI_AGENTS_KEY` build arg). The shape itself is covered by
  `acpui.test.ts`, which asserts against a copy of acp-ui's own reader rather
  than against our output.
- **acp-ui's telemetry is disabled by patching its source at build time.** The
  Application Insights connection string is hardcoded upstream, not read from
  the environment, so the build blanks that line and then greps the bundle to
  prove it. If upstream restructures that module, the build fails rather than
  quietly shipping telemetry.
- **Fine-grained GitHub PATs cannot act as a collaborator on another user's
  private repos** (a documented GitHub gap), hence the classic PAT. Migrating
  the repos to an org is the upgrade path.

## Why `/ws` bypasses basicauth

Browsers do not reliably attach Basic credentials to a cross-path WebSocket
upgrade and cannot answer a 401 challenge on one. So the gateway authenticates
the upgrade itself: acp-ui offers `['acp.v1', 'bearer.<token>']` as
subprotocols, the gateway validates the token against `WS_AUTH_TOKEN` in
constant time and selects `acp.v1`. Everything else stays behind basicauth.

## Development

Each package type-checks independently, and every Docker build runs
`tsc --noEmit` *before* esbuild, so an image cannot be built from code that
fails type-checking.

```
cd orchestrator && npm run check && npm test
cd proxy        && npm run check && npm test
cd dashboard    && npm run check && npm test && npm run build
```

`scripts/smoke-test.sh` needs no credentials and is the security gate.
`scripts/live-test.sh` covers what only a real inference call can prove —
subscription auth, a turn surviving the browser leaving, thread replay on
reattach, and a permission request held with nobody watching — so it needs
`PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN` set.

The dashboard uses **esbuild alone** — native JSX/TS and native CSS bundling,
no plugins, no Vite. Styling rules, enforced in review: no inline `style=`
attributes, no Tailwind, no CSS-in-JS; every component imports its co-located
`.css`; cross-component values travel only through `tokens.css` custom
properties.
