# Boxes — personal AI agent orchestrator

Runs AI coding-agent sessions (Claude Code first, other ACP agents later) in
isolated Docker containers, controlled from a mobile-friendly web UI, behind
an existing Traefik reverse proxy.

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
| `frontend/` | acp-ui web build as a static nginx image, at `/ui` |
| `proxy/` | The in-house egress proxy — the security boundary |
| `session-image/` | The per-session container image |
| `shared/types.ts` | REST shapes imported by both orchestrator and dashboard |
| `scripts/smoke-test.sh` | Security smoke test (plan §10) |

## Setup

1. **Configure.** `cp .env.example .env`, `chmod 600 .env`, fill it in.
   - `WS_AUTH_TOKEN`: `openssl rand -hex 32`
   - `BASICAUTH_USERS`: `htpasswd -nB owner` (escape every `$` as `$$`)
   - `PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token`
     locally and paste the result. This uses your subscription; no API key.
   - `PROFILE_DEFAULT_GH_TOKEN`: a **classic** PAT for a separate bot account.
   - `ACP_UI_REPO` / `ACP_UI_COMMIT`: pin the acp-ui upstream and commit.
     These are required build args with no defaults, on purpose — see below.

2. **Build the session image** (it is not part of compose):
   ```
   docker build -t boxes-session:latest session-image/
   ```

3. **Bring it up:** `docker compose up -d`

4. **Verify isolation:** `API_BASE=http://localhost:3000 ./scripts/smoke-test.sh`

5. **Connect.** Open `/`, create a session, open it, and tap **Open in
   acp-ui**. That's it — nothing to type, on any device.

   acp-ui has no URL-prefill mechanism, but it is served at `/ui` on the same
   host as the dashboard, so it is the *same origin* and its agent config
   lives in `localStorage` we can write. The button upserts this session into
   acp-ui's agent list and navigates there. If acp-ui already has an agent
   stored, we clone that entry's field shape rather than imposing our own, so
   the format stays correct even if acp-ui changes it. A collapsed "Connect
   manually instead" disclosure keeps the URL and token available as a
   fallback.

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
  Acceptable for a personal tool; rotate by editing `.env` and tapping
  **Open in acp-ui** again, which overwrites the stored entry in place.
- **The one-click connect depends on acp-ui's storage key.** If acp-ui renames
  `acp-ui:agents`, the *image build fails* with a pointer to the two places to
  update (`dashboard/src/acpui.ts` and the `ACP_UI_AGENTS_KEY` build arg) —
  deliberately loud, so you never get a button that silently does nothing.
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

The dashboard uses **esbuild alone** — native JSX/TS and native CSS bundling,
no plugins, no Vite. Styling rules, enforced in review: no inline `style=`
attributes, no Tailwind, no CSS-in-JS; every component imports its co-located
`.css`; cross-component values travel only through `tokens.css` custom
properties.
