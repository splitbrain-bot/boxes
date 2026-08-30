# Plan: Egress allowlist and token translation

Status: PROPOSED (revision 2). Owner decision incorporated: (2026-08-30 a)
**no TLS interception** — MITMing session traffic is overkill for two
well-known credentials; the design below does token translation without a
CA. Research facts in §2 were verified against primary sources (project
repos, Anthropic/GitHub/LiteLLM docs) on 2026-08-30. Audience: the owner
first, then a coding agent. Do not begin implementation until the owner
approves this plan and decides the open questions in §9.

---

## 1. Why, and what must be true afterwards

Two gaps in today's egress design:

1. **No allowlist.** The proxy denies private ranges and non-80/443 ports,
   and nothing else. A prompt-injected agent can POST anything it holds to
   any public host. Wanted: an optional host allowlist, so a deployment can
   say "sessions reach the Anthropic API, GitHub and npm, and nothing else".
2. **Real tokens sit inside the sandbox.** `CLAUDE_CODE_OAUTH_TOKEN` and
   `GH_TOKEN` are session-container env vars; README lists "prompt injection
   can leak a session's env tokens" as an accepted risk. Wanted: the
   long-lived real credentials never enter a session container. What a
   session holds is either a per-session placeholder that only works through
   our proxy, or a disposable short-lived scoped token whose leak is
   near-worthless.

Afterwards, all of these must hold:

- With `EGRESS_ALLOWED_HOSTS` set, a session completes a turn and pushes to
  GitHub, and a request to any unlisted host is denied with a logged reason.
  Unset, behavior is today's (any public host). No session traffic is ever
  decrypted; the proxy never holds a CA.
- `docker exec <session> env` and the session volumes contain neither the
  Claude credential nor any long-lived GitHub credential.
- The Claude credential authenticates only requests arriving with the
  session's placeholder; GitHub operations run on 1-hour tokens scoped to
  the session's repo.
- Everything already true stays true: DNS-rebinding pinning, private-range
  blocking, fail-closed egress, `scripts/smoke-test.sh` green (extended, §8).

## 2. Research: the no-MITM landscape

Credential injection needs plaintext. Without TLS interception there are
exactly two places to get it, and both are established, reused patterns:

- **Trusted gateway endpoint**: the client is *pointed at* the proxy (base
  URL, or plain-`http://` requests through it); the proxy attaches the real
  secret and re-originates TLS upstream. The client-side hook exists for
  every credential we carry: Claude Code's documented gateway mode
  (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, provider key stays
  server-side), and git's credential-helper mechanism.
- **Short-lived scoped credential brokering**: the sandbox gets a
  disposable token minted outside it. This is how GitHub Actions itself
  works — the `GITHUB_TOKEN` in every runner is a 1-hour, repo-scoped
  GitHub App installation token, not anyone's real credential.

### Existing projects, verified

| Project | Pattern | Fit | State |
|---|---|---|---|
| **superfly/tokenizer** (Fly.io) | Secret-injecting HTTP proxy, **no MITM**: client sends plain `http://` requests plus a sealed-secret header; proxy unseals, injects, upgrades to HTTPS. Per-secret `allowed_hosts`; client auth via `Proxy-Authorization`. Has a **`github_app_processor`** (mints 1 h installation tokens, pinned to api.github.com). Stateless, Docker-ready | The generic version of what we need; production-deployed inside Fly; a Fly community thread proposes exactly this pattern for sandboxed AI agents | Apache-2.0, active (July 2026), ~500★ |
| **LiteLLM proxy** | LLM gateway with virtual keys; official Claude Code integration docs (`ANTHROPIC_BASE_URL=http://…:4000`, virtual key as `ANTHROPIC_AUTH_TOKEN`); native `/v1/messages` passthrough | Purpose-built for the Anthropic leg — but virtual keys require Postgres, and **it cannot hold a subscription OAuth token (`sk-ant-oat01…`) as the upstream credential — API keys only** (the subscription tutorial only *forwards* the client's own token, which defeats us). Boxes runs on `claude setup-token` today, so this is a blocker unless the deployment switches to an API key | MIT core, very active |
| **CyberArk secretless-broker** | Localhost plaintext listener → header injection → `forceSSL` upstream | Right pattern, but no per-client auth, no allowlist role, no token minting; releases are dependency churn (maintenance mode) | Apache-2.0 |
| **actions/create-github-app-token**, **octo-sts** (self-hostable), git-credential-github-app, ghtkn, … | GitHub App key → 1 h repo/permission-scoped installation tokens; several git credential helpers exist that mint per git operation | The GitHub-leg pattern, many implementations; octo-sts needs an OIDC issuer (too heavy here), the credential-helper shape is exactly right | Official/active |
| **anthropic-experimental/sandbox-runtime** | Claude Code's own sandbox: CONNECT-time domain allowlist, **no MITM by default** (TLS-terminate is an optional experimental mode) | Validates the allowlist half of this plan as the standard technique; its proxy isn't packaged standalone | Apache-2.0, beta |
| **anthropics/claude-code `.devcontainer/init-firewall.sh`** | iptables/ipset default-deny allowlist (anthropic, GitHub CIDRs from `api.github.com/meta`, npm, …) | Anthropic's own reference allowlist for devcontainers — IP-layer alternative to a proxy allowlist | in-repo reference |
| **coder/httpjail**, **Infisical agent-vault**, alibaba/OpenSandbox credential sidecar | Agent-egress projects that do inspect/inject | All reach for TLS interception to be client-transparent — the road not taken here | active/new |
| smokescreen (Stripe) | Allowlisting CONNECT proxy, no injection | Allowlist only; our existing proxy already does the harder part (DNS-pin vetting) | active |

Two conclusions. First: the reusable substance is the **patterns and the
client-side hooks** — gateway mode for Claude Code, credential helper +
App tokens for git/gh — all documented, all verified. Second: the
transparent tools (httpjail, agent-vault, mitmproxy) all MITM because
transparency is the thing that *requires* it; with exactly two known
credentials and clients that support being pointed at a gateway, we don't
need transparency, so we don't need a CA.

### Client-side facts this plan stands on (verified)

- `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` is Claude Code's documented
  gateway mode; the token is an opaque string (no format constraint
  documented); plain `http://` base URLs work in practice (LiteLLM's own
  Claude Code docs use one). The agent SDK (and therefore
  `claude-agent-acp`) passes these through as env vars.
- Gateway caveats to carry into config: the fast-mode availability check
  calls `api.anthropic.com` directly (allowlist it); gateways passing
  subscription OAuth upstream must send the OAuth capability in
  `anthropic-beta`.
- git auth is pluggable per operation via credential helpers (`gh auth
  setup-git` is itself just a helper registration). `gh` reads `GH_TOKEN`
  fresh on every invocation, and has **no** dynamic token hook (upstream
  issues open since 2022) — a wrapper script that fetches-then-execs is the
  standard answer, and each `gh` command is a new process so expiry between
  invocations is harmless.
- GitHub App installation tokens: 1 h expiry, mintable scoped to chosen
  repositories and permissions. The mint call is one authenticated POST —
  small enough to do ourselves with no new dependency.

## 3. Architecture after the change

No new engine. The existing Node proxy grows two roles it is already
structurally suited for (it has HTTP forwarding, vetting and pinning code
today), and the orchestrator becomes the credential broker.

```
┌────────────────── session network sn-<id> (internal) ──────────────────┐
│ session container                                                      │
│   HTTPS_PROXY=http://proxy:3128        NO_PROXY=localhost,127.0.0.1,proxy
│   ANTHROPIC_BASE_URL=http://proxy:3129                                 │
│   ANTHROPIC_AUTH_TOKEN=<per-session placeholder>                       │
│   BOXES_SESSION_TOKEN=<same placeholder> (credential helper + gh wrap) │
│   — no CLAUDE_CODE_OAUTH_TOKEN, no GH_TOKEN —                          │
└───────────────┬──────────────────────────┬─────────────────────────────┘
                │ :3128 forward proxy      │ :3129 credential gateway
        ┌───────▼──────────────────────────▼───────┐
        │              egress proxy                │
        │ :3128 CONNECT/HTTP as today              │
        │   + optional host allowlist (wildcards)  │
        │   + vet-and-pin (unchanged)              │
        │ :3129 plain-HTTP gateway, three routes:  │
        │   /v1/*  → verify placeholder, swap in   │
        │            the real Claude credential,   │
        │            https to api.anthropic.com    │
        │   /github/token → forward to orchestrator│
        │   anything else → 403                    │
        └───────┬──────────────────────────▲───────┘
                │ internet                 │ policy.json (ro volume):
                ▼                          │ allowlist + placeholder map
                                  orchestrator: writes policy.json; serves
                                  /internal/broker/github-token → mints a
                                  1 h repo-scoped App installation token
```

- **Anthropic leg — placeholder translation.** The adapter runs in gateway
  mode against `proxy:3129`. The gateway verifies the per-session
  placeholder, replaces the `Authorization` header with the real credential
  (plus the `anthropic-beta` OAuth capability header when the upstream
  credential is a subscription token), and re-originates TLS to
  `api.anthropic.com`, streaming (SSE) piped as the proxy already pipes
  today. A request with a missing, unknown, or foreign credential is 403 —
  which also means an allowlisted `api.anthropic.com` is no longer an
  exfiltration channel to arbitrary Anthropic accounts, since :3128 tunnels
  to it can be closed once :3129 is the sanctioned path (§9.3).
- **GitHub leg — ephemeral scoped tokens, the GitHub Actions model.** The
  owner registers a GitHub App on the bot account; the orchestrator holds
  its private key and mints installation tokens scoped to the session's
  repo (contents read/write; PRs optionally, §9.2), 1 h expiry. Inside the
  session, a git credential helper (replacing `gh auth setup-git`) and a
  thin `gh` wrapper fetch a fresh token from `proxy:3129/github/token`
  (authenticated by the placeholder; the proxy forwards to the orchestrator
  over the compose network — sessions still cannot reach the orchestrator).
  git and gh work natively, against real `github.com`/`api.github.com` TLS.
  What exists inside the sandbox is a token that dies within the hour and
  opens one repository. The App key — the real credential — never enters.
- **Placeholders** are per-session random values minted at session create.
  The placeholder identifies the session at the proxy (no source-IP
  mapping), is individually revocable (delete the session), and is useless
  outside the proxy. `NO_PROXY` must include the proxy alias so gateway
  requests do not recurse through :3128 (whose private-range vetting would
  correctly refuse them).
- **Policy transport**: the orchestrator writes `policy.json` (allowlist +
  placeholder→profile map + real Claude credential) atomically, 0600, to a
  new named volume mounted read-only by the proxy; the proxy reloads on
  mtime change. No secrets on the compose network, both containers can
  restart independently, and the existing 60-second proxy reconciler gains
  "policy file is current" as a second assertion.
- **Fallback without a GitHub App** (`PROFILE_DEFAULT_GH_TOKEN` still set,
  no App configured): behavior stays exactly today's — PAT in the session —
  and `/healthz` says so. Translation of a PAT without MITM would only
  cover git (a rewrite to the gateway), while `gh` would silently lose
  auth; shipping that foot-gun is worse than being honest that the App is
  the upgrade path.

**Adopt instead of build?** superfly/tokenizer is the honest alternative
for the gateway container: right pattern, maintained, Apache-2.0, and its
`github_app_processor` overlaps the broker. It is not chosen here because
its contract needs the *client* to attach sealed-secret headers and speak
plain `http://` per request — trivial for curl, but for our actual clients
it means custom-header plumbing through Claude Code and git config, plus
sealing infrastructure, to reach the same two header swaps. Our proxy
already contains the forwarding, vetting and logging halves; the delta is
~150 lines against a codebase whose doctrine is stdlib-only. If a third or
fourth credential ever needs carrying, that is the moment tokenizer earns
the slot (§10). This is owner question §9.1.

## 4. Behavior, precisely

**Allowlist** (`:3128`, and `:80` absolute-URI requests): exact hostnames
and `*.example.com` wildcards (one label, no bare `*`), case-insensitive,
checked before DNS vetting; IP-literal targets match only as literals.
Empty/unset = off (today's behavior). When token translation is on, the
gateway-reachable hosts are implied so a narrow allowlist cannot sever
inference or brokering. Denials are logged with host and reason, never with
credentials.

**Credential gateway** (`:3129`, plain HTTP, session networks only):
- `POST/GET /v1/*` — require `Authorization: Bearer <known placeholder>`
  (constant-time compare); rewrite `Authorization` to the profile's real
  Claude credential; add the OAuth `anthropic-beta` capability when that
  credential is `sk-ant-oat…`; forward to `https://api.anthropic.com` with
  the path and remaining headers intact; pipe the response (SSE included).
  Long-turn streams must not trip the 120 s idle timeout — idle resets on
  any data, as the CONNECT path already behaves.
- `POST /github/token` — same placeholder check, forwarded to the
  orchestrator's `/internal/broker/github-token`; the orchestrator verifies
  the placeholder→session mapping, mints (and caches until ~5 min before
  expiry) an installation token scoped to the session's repo, and returns
  `{token, expiresAt}`.
- Everything else 403. The port is never published; it exists only on
  session networks and the compose network.

**Session image**: entrypoint installs `git credential.helper` = a
five-line script calling `/github/token` (replacing `gh auth setup-git`),
and `/usr/local/bin/gh` becomes a wrapper that fetches a token into
`GH_TOKEN` and execs the real binary. Both no-ops when translation is off.

## 5. Repository changes

```
proxy/src/
├── main.ts            # + allowlist check in vetTarget path; + :3129 listener
├── gateway.ts         # NEW: placeholder verify, header swap, upstream pipe,
│                      #   broker forward — pure request-classification logic
│                      #   factored for unit tests
├── policy.ts          # NEW: policy.json load/watch/validate (fails closed:
│                      #   unreadable policy = translation routes all 403)
└── cidr.ts            # unchanged
orchestrator/src/
├── config.ts          # + EGRESS_ALLOWED_HOSTS ('' = off)
│                      # + EGRESS_TOKEN_TRANSLATION ('on'|'off')
│                      # + PROFILE_DEFAULT_GITHUB_APP_ID / _INSTALLATION_ID /
│                      #   _GITHUB_APP_KEY_FILE
├── policy.ts          # NEW: placeholder minting; atomic policy.json writer
├── broker.ts          # NEW: installation-token mint (one POST + JWT signing
│                      #   via node:crypto — no dependency) + expiry cache
├── app.ts             # + /internal/broker/github-token (compose-network only)
├── docker.ts          # sessionEnv: gateway env + placeholder when on;
│                      #   real tokens only when off
├── sessions.ts        # placeholder lifecycle on create/delete
└── reaper.ts          # reconciler re-asserts policy.json
session-image/         # credential helper script, gh wrapper, entrypoint wiring
compose.yaml           # boxes-egress-policy volume (orchestrator rw, proxy ro)
shared/types.ts        # healthz gains translation/allowlist status fields
scripts/smoke-test.sh  # extended, §8
README.md, ARCHITECTURE.md, .env.example   # rewritten sections
db migration           # sessions + placeholder (hashed; plaintext only in
                       #   policy.json)
```

No new runtime dependency, no new language, no new container. The GitHub
App JWT is RS256 over `node:crypto` (~20 lines), the same standard the
official action implements.

## 6. Milestones

### M0 — Spike: the two unknowns (throwaway code allowed)
1. **Subscription OAuth through gateway mode.** Adapter in a session-image
   container, `ANTHROPIC_BASE_URL` at a 30-line injector holding a
   `setup-token` credential; establish which extra headers
   (`anthropic-beta` capability) make `api.anthropic.com` accept it, that
   streaming works, and whether the credential refreshes via other hosts
   mid-session. If gateway-mode subscription auth cannot be made to work,
   the Anthropic leg needs an owner decision: API-key profile (everything
   here works unchanged, LiteLLM also becomes viable) or subscription token
   staying in-session as today (translation ships GitHub-only). This is the
   plan's main unknown.
2. **App-token flow end to end**: mint scoped installation token, git push
   and `gh pr list` via helper + wrapper from inside a container.

### M1 — Allowlist
In the existing proxy, config through policy.json (orchestrator-written,
reconciler-asserted) with `EGRESS_ALLOWED_HOSTS` as its source. Unit tests:
wildcard matching table, literal-IP handling, off-means-today. Smoke test
gains the allowlist probes (§8.4–5). Ships alone — value independent of
translation.

### M2 — Credential gateway + Anthropic leg
`gateway.ts`, `policy.ts` both sides, placeholder lifecycle, sessionEnv
switch, `/healthz` surface. Acceptance: live session completes a turn with
no `CLAUDE_CODE_OAUTH_TOKEN` in its env; foreign/missing placeholder → 403;
translation off → today's env exactly.

### M3 — GitHub leg
`broker.ts`, internal route, proxy forward, credential helper + gh wrapper,
App config in config.ts. Acceptance: live session clones, pushes, and runs
`gh api user` with no `GH_TOKEN` in env; the token seen by a probe inside
the session expires ≤ 1 h and lists only the session repo; App unset →
today's PAT path plus `/healthz` notice.

### M4 — The gate and the docs
Smoke-test suite below green in all modes; README/ARCHITECTURE network and
risks sections rewritten (env-token leak risk moves to mitigated-by-default
for App deployments); `live-test.sh` gains the translated turn. Owner flips
`EGRESS_TOKEN_TRANSLATION` default to `on`.

## 7. Risks

- **Gateway-mode subscription auth (M0.1)** — the one item that can
  reshape a leg; contained by the two named fallbacks, and GitHub-leg value
  survives it either way.
- **Long-turn SSE through the gateway**: idle-timeout and backpressure
  handling get explicit tests; the CONNECT path's behavior is the model.
- **Broker availability**: an expired cached token plus an orchestrator
  restart mid-push surfaces as one failed git operation, retried clean —
  helpers fetch per operation, nothing long-lived to invalidate.
- **`gh` edge cases**: the wrapper covers CLI invocations; a tool exec'ing
  the real binary by absolute path would see no token — acceptable; PATH
  order is ours in the image.
- **Policy file as secret store**: real Claude credential now also lives in
  a volume file (0600, proxy-readable) — same trust domain as today's env
  var on the orchestrator, one more resting place; accepted and documented.
- **Doctrine creep in the proxy**: it stops being configurable standalone
  (policy.json required for the new roles). Accepted — config.ts is already
  the single config authority; the proxy still boots and forwards with no
  policy file, translation routes simply refuse.

## 8. Smoke-test additions (the acceptance definition)

From inside a throwaway session (allowlist `api.anthropic.com,github.com,
*.github.com,*.githubusercontent.com,registry.npmjs.org`, translation on,
App configured):

1. Neither the Claude credential nor any `ghs_`/PAT value from the host
   config appears in `env`, `/proc/*/environ`, or the session volumes
   (host-side grep with the known values).
2. `curl proxy:3129/v1/models` with the placeholder → 200; with an invented
   token → 403; `POST /github/token` likewise.
3. The minted GitHub token authenticates `api.github.com` but its
   `/installation/repositories` lists only the session repo; a probe 65
   minutes later (or a second mint after forced expiry) shows the first
   token dead. [The 65-minute probe is live-test, not smoke.]
4. `curl https://example.com` → denied (allowlist); `https://1.1.1.1` →
   denied; private ranges → denied (unchanged).
5. Allowlist unset: `example.com` reachable (optionality); private ranges
   still denied.
6. Translation off: env matches today's exactly (regression guard).
7. `git push` and `gh api user` succeed with no `GH_TOKEN` in env.

## 9. Open questions for the owner

1. **Build the ~150-line gateway into our proxy (recommended) or run
   superfly/tokenizer as the gateway container?** Tokenizer is the genuine
   reuse option; the cost is sealing infrastructure plus custom-header
   plumbing in every client for what is, for us, two header swaps. If you
   pick tokenizer, M2/M3 become integration milestones instead.
2. **GitHub App scope**: `contents:rw` only, or also `pull_requests:rw`
   (agents opening PRs via `gh`)? And is the one-time App registration on
   the bot account acceptable? (Without it, the PAT stays in-session as
   today — documented, `/healthz`-visible.)
3. **Close the direct tunnel to `api.anthropic.com`** on :3128 once :3129
   is the sanctioned path (recommended — it turns the API host into a
   non-channel for foreign-key exfiltration), or leave it tunnel-able?
4. **Default allowlist**: ship `.env.example` with the working set from §8
   commented in, or leave it fully to the deployment?
5. `EGRESS_TOKEN_TRANSLATION` default `on` at M4 (recommended)?

## 10. Enabled later, out of scope now

- **Adopting tokenizer** if a third credential (npm publish token, cloud
  keys) ever needs carrying — the placeholder/env plumbing built here is
  exactly what it would slot into.
- **Push policy at the broker**: the App token can be minted per-operation;
  refusing pushes to protected branches is a broker rule, no proxy change.
- **Per-session allowlists and an egress audit view** in the dashboard
  (denials already log per placeholder = per session).
- **API-key profiles + LiteLLM** for deployments that want budgets/quotas
  per session on the Anthropic leg.
