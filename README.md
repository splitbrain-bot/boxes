# Boxes

Boxes runs AI coding-agent sessions in isolated Docker containers and gives you
a mobile-friendly web UI to drive them. Each session is a long-lived container
with its own workspace volume, its own internal network, and no route out
except through a proxy that vets every destination.

Agent turns keep running when your browser goes away. The orchestrator — not
the browser — is the agent's client of record, so you can lock your phone
mid-task and find the finished thread when you come back.

- **Isolated sessions.** One container, one network, one workspace per session.
  Non-root, read-only rootfs, no capabilities, no host mounts, no published
  ports.
- **Vetted egress only.** Session networks are `internal`; the sole way out is
  an egress proxy that rejects private addresses, pins the connection to a
  vetted IP, and can be given a host allowlist.
- **No credentials in the sandbox.** Sessions hold placeholder tokens. The
  proxy swaps in the real ones on the wire, and refuses any other credential
  to those hosts — so a leaked placeholder is worth nothing.
- **One service, one port.** The orchestrator serves the UI, the REST API and
  the WebSocket gateway on `:3000`. No second origin, nothing to configure.
- **Claude Code today**, other agents later — sessions speak the Agent Client
  Protocol (ACP).

`ARCHITECTURE.md` describes how it is built.

## Requirements

- Docker with Compose v2, on Linux or macOS
- A Claude token from `claude setup-token` (subscription-based, inference only)
- Node 22+ — only if you want to develop on Boxes itself

## Install

```sh
git clone https://github.com/splitbrain/experiments.git boxes
cd boxes

docker build -t boxes-session:latest session-image/
docker compose up -d
```

The session image is deliberately **not** part of `compose.yaml` — the
orchestrator creates session containers at runtime. Build it once as shown,
and rebuild it whenever `session-image/` changes.

Boxes is now on <http://localhost:3000>, bound to loopback because it ships
with no authentication of its own. See
[Behind a reverse proxy](#behind-a-reverse-proxy) before moving it.

## Configure

There is no required configuration — every setting has a working default. To
change one, copy `.env.example` to `.env` and edit it. To keep the file out of
the repo, point at it instead:

```sh
BOXES_ENV=~/.config/boxes.env docker compose up -d
```

To actually run an agent turn you need one credential:

```sh
claude setup-token          # then put the value in your env file
PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

Without it, sessions still start and the UI still works — only inference
fails. Alternatively skip the variable and log in inside a session, which
keeps the credential in that session's home volume and out of every file:

```sh
docker exec -it session-<id> claude /login
```

### Settings

| Variable | Default | What |
|---|---|---|
| `BIND_ADDR` | `127.0.0.1` | Interface the port is published on |
| `HOST_PORT` | `3000` | Published port |
| `PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN` | — | Claude token; without it no turn can run |
| `PROFILE_DEFAULT_GH_TOKEN` | — | Classic GitHub PAT for the bot account |
| `PROFILE_DEFAULT_GIT_NAME` | `boxes-bot` | Git author name in sessions |
| `PROFILE_DEFAULT_GIT_EMAIL` | `boxes-bot@users.noreply.github.com` | Git author email |
| `WS_AUTH_TOKEN` | generated | Gateway bearer token; generated on first boot into `/data/ws-auth-token` and reused |
| `SESSION_IMAGE` | `boxes-session:latest` | Image sessions run |
| `SESSION_SUBNET_POOL` | `10.200.0.0/16` | Pool sessions get a `/24` from |
| `SESSION_MEM_LIMIT` | `4g` | Per-session memory cap |
| `SESSION_CPUS` | `2` | Per-session CPU cap |
| `SESSION_PIDS_LIMIT` | `512` | Per-session pids cap |
| `IDLE_STOP_MINUTES` | `30` | Idle time before a session container is stopped |
| `PERMISSION_FALLBACK` | `hold` | `hold` or `deny` for an unanswered permission request |
| `PERMISSION_HOLD_MINUTES` | `120` | How long before that fallback applies |
| `NTFY_URL` | — | POSTed when a permission request is waiting |
| `DATA_DIR` | `/data` | Database and generated token, inside the volume |
| `EGRESS_PROXY_CONTAINER` | `boxes-egress-proxy` | Proxy container the orchestrator attaches to session networks |
| `EGRESS_ALLOWED_HOSTS` | — | Hosts sessions may reach; empty means every public host |

Everything is parsed and validated at boot, so a bad value fails startup
rather than surfacing later. `orchestrator/src/config.ts` is the full list.

## Run

```sh
docker compose up -d          # start
docker compose logs -f        # follow
docker compose down           # stop
```

Health check and verification:

```sh
curl localhost:3000/healthz
API_BASE=http://localhost:3000 ./scripts/smoke-test.sh
```

The smoke test needs no credentials: it creates throwaway sessions, asserts the
isolation properties from inside a container, and cleans up. Run it after any
change to networking, the proxy, or the session image. Where the deployment
*has* configured credentials or an allowlist, it additionally proves that no
real credential is inside a session and that the allowlist bites.

## Use

Open <http://localhost:3000>.

**Create a session.** Give it a name and, optionally, an `https://` repository
URL — it is cloned into `/workspace/repo` on first start. The session gets its
own container, network and volumes.

**Talk to the agent.** Tap a session card to open its thread. That is the whole
interface: type, and the turn runs in the container. Close the tab or lock your
phone whenever you like; reattaching replays the thread from the session's own
history. Opening a stopped session starts it again.

**Run a shell command with `!`.** A composer line starting with `!` runs as
`bash -lc` in the session container and never reaches the model — no tokens
spent, no chance of it being read as an instruction:

```
!npm test
!git diff --stat
```

Output streams back and ends with the exit code. Commands are capped at 120
seconds and 256 KiB of output.

**Answer permission requests.** When the agent asks to do something requiring
consent, the request goes to your attached browser. With nobody attached it is
queued (and posted to `NTFY_URL` if set) and delivered to the next browser to
attach. Nothing is ever auto-approved.

**Manage the session.** The ⓘ corner of a card opens its details and controls:
start, stop, delete, the container and network names, and the WebSocket URL and
bearer token for attaching your own ACP client. Deleting keeps the volumes
unless you tick purge, because they hold the agent's work.

Idle sessions — no turn, no waiting request, no attached browser — are stopped
after `IDLE_STOP_MINUTES`. They are never deleted.

## Behind a reverse proxy

Boxes has no authentication and holds the Docker socket, so as shipped it binds
to `127.0.0.1`. Anything beyond a single-user machine needs a reverse proxy in
front — Caddy, nginx, Traefik, whatever you already run. Proxy to
`127.0.0.1:3000`, or join the `boxes_default` network and use
`orchestrator:3000` if the proxy is itself a container. Only widen `BIND_ADDR`
once something else is doing the authenticating.

Two rules:

1. **Authenticate `/` and `/api`, and terminate TLS there.** Every route is
   otherwise open, including the one that creates containers.
2. **Do not put HTTP authentication in front of `/ws`.** Browsers cannot attach
   Basic credentials to a WebSocket upgrade, so guarding it breaks every thread
   view. It does not need guarding: the gateway authenticates the upgrade
   itself against `WS_AUTH_TOKEN`.

Also forward `Upgrade` and `Connection` on `/ws`, and give it a long read
timeout — a turn can hold the socket open for minutes with nothing on it.

## What a session can reach

Two settings shape it, and both default to something safe.

**The allowlist.** `EGRESS_ALLOWED_HOSTS` is a comma or whitespace separated
list of exact hostnames and one-label wildcards:

```
EGRESS_ALLOWED_HOSTS=github.com,*.github.com,*.githubusercontent.com,api.anthropic.com,registry.npmjs.org
```

`*.example.com` matches `a.example.com`, but neither `example.com` nor
`a.b.example.com`. An address literal matches only as a literal. Leave it unset
and behaviour is what it has always been: any public host, private ranges still
denied. The hosts of a credential you configured are always reachable, so a
narrow list can never sever inference or GitHub.

**Token translation.** It is always on, and it applies to whichever credentials
you configured:

- Set `PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`, and `api.anthropic.com`
  becomes a translated host.
- Set `PROFILE_DEFAULT_GH_TOKEN`, and the GitHub hosts do.
- Leave one unset and its host stays an ordinary tunnel, which is what keeps
  the "log in inside a session with `claude setup-token`" flow working.

For a translated host the session holds a placeholder of the same shape as the
real token, and:

```
docker exec session-<id> env | grep -c sk-ant-oat01-...   # 0
```

The proxy terminates TLS for that host under a CA generated once for your
deployment, swaps the placeholder for the real credential, and refuses any
*other* credential outright — so "api.anthropic.com is allowlisted" no longer
implies "any Anthropic account is reachable". Everything else stays an opaque
tunnel the proxy cannot read.

The real credentials live in the orchestrator's environment and in the proxy's
memory, and nowhere else. The proxy has no config file, no database and no CA
on disk: it boots empty and is handed its policy over an authenticated channel
on the compose network, which no session can route to. Restart it and the
orchestrator's reconciler pushes again within a minute.

The CA certificate reaches each session as `BOXES_PROXY_CA`, written by the
entrypoint to `~/.boxes/proxy-ca.crt`, with `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `GIT_SSL_CAINFO` and `CURL_CA_BUNDLE` pointing at it.

### When a new tool fails TLS

A tool that honours none of those variables fails TLS against *translated
hosts only*, which is a confusing shape — everything else keeps working. The
fix is to point that tool at the same file:

| Tool | Variable | Notes |
|---|---|---|
| node, npm, anything on Node | `NODE_EXTRA_CA_CERTS` | Already set |
| curl | `CURL_CA_BUNDLE` | Already set |
| git | `GIT_SSL_CAINFO` | Already set |
| gh, and most Go tools | `SSL_CERT_FILE` | Already set |
| Python `requests` | `REQUESTS_CA_BUNDLE` | Add it, pointing at `$BOXES_PROXY_CA`'s file |
| Python `httpx`, `aiohttp` | `SSL_CERT_FILE` | Already set |
| Deno | `DENO_CERT` | Add it |
| Rust `reqwest` (rustls) | `SSL_CERT_FILE` | Already set |

Rotating the CA is deleting `egress-secrets.json` from the data volume and
restarting; sessions created before that keep the old certificate and must be
recreated.

## Security model

Isolation rests on two Docker primitives, with nothing touching the host
firewall:

- **Session networks are `internal`.** No NAT, no default route: no L3 path to
  your LAN, the internet, or another session.
- **The egress proxy is the only way out.** It checks the allowlist, resolves
  the target, rejects the request if *any* resolved address is private, then
  connects to that specific vetted address without re-resolving — which is what
  closes DNS rebinding. Every connection it makes goes through that one check,
  including the ones it makes on behalf of a translated host. If the proxy is
  down, sessions have no egress at all.
- **Credentials never enter the sandbox.** See
  [What a session can reach](#what-a-session-can-reach).

Session containers additionally run as a non-root user with `ReadonlyRootfs`,
`CapDrop: ALL`, `no-new-privileges`, a tmpfs `/tmp`, and memory, CPU and pids
limits.

Known residual risks, accepted deliberately:

- Host services bound to `0.0.0.0` stay reachable from inside a session at the
  host's per-bridge IP; Docker's internal-network isolation filters forwarded
  traffic only. Anything sensitive on the host must have its own auth.
- The orchestrator holds the Docker socket, which is root-equivalent. It is
  mitigated by a fixed container template that user input never reaches and by
  never shell-executing user strings — but the auth you put in front of `/api`
  is what keeps it yours.
- `GET /api/sessions` returns `WS_AUTH_TOKEN`, behind that same auth.
- A compromised proxy sees the credentials it injects. That is true of any
  injecting proxy; what this one adds is that it leaves nothing at rest.
- A credential you do *not* configure is not translated. A session that logs
  itself in with `claude setup-token` holds its own token, and prompt injection
  can leak that one.
- Sibling sessions share a deployment's placeholders, so they map to the same
  real credentials. Per-session placeholders arrive with per-session
  credentials.
- Protocol behaviour is pinned to `claude-agent-acp` 0.70.0. Re-check
  capabilities and WebSocket framing on upgrade.

## Development

One toolchain across the repository: every package builds with Vite, tests with
Vitest, and type-checks before its Docker bundle, so an image cannot be built
from code that fails `tsc`.

```sh
cd orchestrator && npm run check && npm test
cd proxy        && npm run check && npm test
cd dashboard    && npm run check && npm test && npm run build
```

`npm run dev` in `dashboard/` serves the SPA with `/api`, `/healthz` and `/ws`
proxied to an orchestrator on port 3000. The dashboard's tests run in two
projects: `unit` for the framework-free stores, and `e2e`, which builds the
production bundle and drives it in Chromium against stub backends.
`/playground` renders every message part kind over a canned store, and the
browser suite asserts that page.

`scripts/live-test.sh` covers what only real inference can prove — a turn
surviving the browser leaving, thread replay on reattach, a permission request
held with nobody watching — and needs
`PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`.

### Frontend conventions

Tailwind utilities and shadcn/assistant-ui components only: no inline `style=`,
no CSS-in-JS, and design tokens defined once in `src/globals.css` — including
the `@theme inline` bridge, without which Tailwind silently drops every token
utility.

Components under `src/components/assistant-ui/` and `src/components/ui/` are
installed by their official CLIs and committed. Our edits carry a comment
saying so. Upgrade by re-running the CLI and reading the diff:

```sh
cd dashboard
npx assistant-ui add thread --overwrite     # or: npx shadcn add <name> --overwrite
npm run check && npm test
```

## Layout

| Path | What |
|---|---|
| `orchestrator/` | Node 22 + TypeScript: REST API, SQLite, Docker lifecycle, ACP gateway, idle reaper |
| `dashboard/` | React SPA — session list and chat — built into the orchestrator image and served at `/` |
| `proxy/` | The egress proxy: allowlist, address vetting and token translation — the security boundary |
| `session-image/` | The per-session container image |
| `shared/types.ts` | REST shapes imported by both orchestrator and dashboard |
| `scripts/smoke-test.sh` | Security smoke test, no credentials needed |
| `scripts/live-test.sh` | The checks that need a real Claude token |
| `ARCHITECTURE.md` | How the system is put together |
