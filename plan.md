# Plan: Egress allowlist and token translation

Status: PROPOSED (revision 1). Audience: the owner first, then a coding
agent. Research facts in §2 were verified against primary sources on
2026-08-30 (proxy tool docs, Anthropic engineering posts, Claude Code and
GitHub docs). Do not begin implementation until the owner approves this
plan and the open questions in §9 are decided.

---

## 1. Why, and what must be true afterwards

Two gaps in today's egress design:

1. **No allowlist.** The proxy denies private ranges and non-80/443 ports,
   and nothing else. A prompt-injected agent can POST anything it has to any
   public host. Wanted: an optional host allowlist, so a deployment can say
   "sessions reach the Anthropic API, GitHub and npm, and nothing else".
2. **Real tokens sit inside the sandbox.** `CLAUDE_CODE_OAUTH_TOKEN` and
   `GH_TOKEN` are session-container env vars; README lists "prompt injection
   can leak a session's env tokens" as an accepted risk. Wanted: **token
   translation** — the session holds per-session placeholder tokens, and the
   proxy swaps them for the real credentials on the wire, so a real token
   never exists inside a session container and a leaked placeholder is
   useless anywhere else.

Afterwards, all of these must hold:

- With `EGRESS_ALLOWED_HOSTS` set, a session can complete a turn and push to
  GitHub, and a request to any host not on the list is denied with a logged
  reason. Unset, behavior is today's (any public host).
- `docker exec <session> env` shows no real credential, and no file in the
  session's volumes contains one. Placeholders only.
- The real tokens authenticate only requests that arrive carrying the
  matching placeholder. A request to an injection host carrying any *other*
  credential is denied — so "api.anthropic.com is allowlisted" no longer
  implies "data can be exfiltrated to an arbitrary Anthropic account".
- Everything already true stays true: DNS-rebinding pinning, private-range
  blocking, fail-closed egress, `scripts/smoke-test.sh` green (extended, §8).

## 2. Research: what exists, and what the constraint really is

Token injection into HTTPS traffic is only possible where the proxy can see
plaintext. That means either (a) TLS interception (MITM with a
deployment-local CA the session trusts), or (b) the client is explicitly
pointed at the proxy as its API endpoint (base-URL / reverse-proxy pattern,
no CA needed). Everything surveyed falls on one of those two sides.

### Reference design (Anthropic, verified from their engineering posts)

Claude Code on the web / Cowork containment does exactly what this plan
wants: sandboxes hold **custom scoped placeholder credentials**; a proxy
outside the sandbox verifies the placeholder, inspects the operation (for
git: is this push going to the configured branch?), then attaches the real
GitHub token and forwards. Their egress proxy also enforces a domain
allowlist, and they run a *defensive* MITM on `api.anthropic.com` traffic
that rejects any request not carrying the session's own provisioned token —
closing the "allowlisted API host as exfiltration channel" hole. This
session's own environment (`/root/.ccr`) is that design in production: TLS
re-terminated at the proxy, per-deployment CA bundle, standard CA env vars
pre-set in the sandbox. The design is proven; the exact service is not
released. The open-sourced piece, `anthropic-experimental/sandbox-runtime`,
has domain allowlisting and an *experimental* TLS-terminate mode, but its
proxy is not packaged standalone and its injection hooks are thinly
documented — a source to crib from, not a dependency to take.

### Off-the-shelf candidates

| Tool | Allowlist | TLS intercept | Token injection | Verdict for Boxes |
|---|---|---|---|---|
| **mitmproxy** (MIT, v12, official Docker image) | yes (addon rejects CONNECT pre-tunnel) | yes — mature CA + per-host cert forging | yes — small Python addon rewrites headers; selective passthrough for hosts that don't need it | **The adopt candidate.** Everything needed, battle-tested; costs a Python component and ~100 MB image |
| Stripe smokescreen | yes | no | no | Allowlist only; solves half the problem |
| Envoy | yes | **no MITM inside CONNECT** — tunnels raw bytes | yes, but only as an explicit gateway (`credential_injector` filter) | Same power as building the base-URL pattern ourselves, at much higher config weight |
| Squid ssl_bump | yes | yes, operationally brittle | `request_header_add` — removed in Squid 8 | No |
| iron-proxy | yes | yes | yes — its headline feature (Vault/KMS-backed) | Purpose-built and promising, but young (hundreds of stars, no audit) and its transparent nftables/TPROXY deployment model doesn't match our `HTTPS_PROXY` + internal-network model |
| coder/boundary, agentgateway, lunar.dev | partly | varies | varies | Wrong shape (needs NET_ADMIN / explicit LLM gateway / interceptor model) |
| google/martian (Go MITM lib) | — | — | — | Archived Feb 2026; do not build on it |

### Client-side facts that make this feasible (verified, Claude Code docs)

- Claude Code / the agent SDK honors `HTTPS_PROXY` and trusts extra CAs via
  `NODE_EXTRA_CA_CERTS`; the docs explicitly support TLS-inspection proxies.
  **No certificate pinning.** Prior art exists of exactly our scheme: dummy
  API key inside, mitmproxy addon swaps the real key on `api.anthropic.com`.
- Auth reaches the API as `Authorization: Bearer` (OAuth / `ANTHROPIC_AUTH_TOKEN`)
  or `x-api-key` (API key). `ANTHROPIC_BASE_URL` can point the client at a
  gateway instead (the no-MITM pattern).
- git and gh honor `HTTPS_PROXY`; git trusts a CA via `GIT_SSL_CAINFO` /
  `http.sslCAInfo`, gh (Go) via `SSL_CERT_FILE`. curl via `CURL_CA_BUNDLE`.
  All deliverable as env vars — no root, no writable rootfs needed.
- GitHub App installation tokens (1 h expiry, repo- and permission-scoped)
  are the complementary hardening: even the *real* token the proxy injects
  can be a short-lived scoped one minted by the orchestrator. Out of scope
  for v1, enabled by this architecture (§10).

### Build vs adopt

The two engines that fit Boxes:

- **A. Adopt mitmproxy as the egress proxy engine**, with one policy addon
  of ours (~150 lines of Python): allowlist, private-range vetting with
  address pinning, selective interception of only the injection hosts,
  placeholder swap, foreign-credential rejection. Everything else —
  CA lifecycle, cert forging, HTTP/2, CONNECT handling — is mitmproxy's
  problem, which is the point. Transparent to every client: git, gh, the
  adapter, curl, npm all just work.
- **B. Extend our Node proxy with explicit gateway endpoints** (no MITM, no
  CA): `ANTHROPIC_BASE_URL=http://proxy:3129/anthropic` and a git
  `insteadOf` rewrite to `http://proxy:3129/github/…`; the proxy verifies
  the placeholder, injects the real header, re-originates TLS. Zero new
  dependencies, smallest possible TCB, keeps today's code. **Known hole:**
  `gh` cannot be pointed at such a gateway (it treats non-github.com hosts
  as GHES with different API paths), so `gh pr create` etc. would lose
  auth — a real functional regression for agents.

**Recommendation: A.** The owner's instinct — don't hand-build this — is
right at the layer where it counts: TLS interception is mature, audited
ground in mitmproxy and treacherous ground to reimplement (Node cannot even
mint certificates without adding a crypto dependency, at which point we've
built a worse mitmproxy). What stays ours is the policy addon, which is the
same ~150 lines of judgement either way. B remains the documented fallback
if the M0 spike turns up a blocker (§7), and its base-URL trick for the
Anthropic API is worth keeping in mind regardless.

## 3. Architecture after the change

```
┌────────────────────────── session network sn-<id> (internal) ─────────────┐
│  session container                                                        │
│    env: HTTPS_PROXY=http://proxy:3128                                     │
│         CLAUDE_CODE_OAUTH_TOKEN = placeholder (sk-ant-oat01-…-BOXESPH…)   │
│         GH_TOKEN               = placeholder                              │
│         BOXES_PROXY_CA (PEM) → written to ~/.boxes/proxy-ca.crt by        │
│         entrypoint; NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / GIT_SSL_CAINFO  │
│         / CURL_CA_BUNDLE point at it                                      │
└──────────────────────────────┬─────────────────────────────────────────---┘
                               │ CONNECT host:443
              ┌────────────────▼────────────────┐
              │  egress proxy = mitmdump        │
              │  + boxes_policy.py addon        │
              │                                 │
              │  1 allowlist check (optional)   │──── deny 403, logged
              │  2 resolve + vet all answers,   │
              │    pin upstream to vetted addr  │──── deny (rebinding, private)
              │  3 injection host?              │
              │     no  → opaque tunnel         │──── TLS passthrough
              │     yes → intercept TLS:        │
              │       placeholder → real token  │
              │       anything else → deny      │
              └───────┬─────────────────▲───────┘
                      │ internet        │ policy.json (ro): allowlist,
                      ▼                 │ placeholder→credential map
                                 orchestrator (writes it; already runs a
                                 60 s proxy reconciler that will re-assert it)
```

- **Interception is the exception, not the rule.** Only the injection hosts
  (`api.anthropic.com`, `github.com`, `api.github.com`, `uploads.github.com`)
  are MITMed. Every other allowed host is an opaque tunnel exactly as today,
  so the CA the sessions trust can decrypt only traffic to hosts where we
  rewrite credentials.
- **Placeholders are per-session** random values minted by the orchestrator
  at session create. The placeholder itself identifies the session at the
  proxy — no source-IP mapping — which later enables per-session policy
  (§10) and makes a placeholder found in a leaked transcript traceable and
  individually revocable (delete the session).
- **Policy transport** is a JSON file on a new named volume, written
  atomically (0600) by the orchestrator, mounted read-only into the proxy;
  the addon reloads on mtime change. No admin API, no secrets on the compose
  network, survives either container restarting. The existing 60-second
  proxy reconciler gains "policy file is current" as a second assertion.
- **CA material**: mitmproxy generates its CA into a confdir volume that
  only the proxy mounts. The orchestrator reads the *certificate* (not the
  key — mitmproxy writes `mitmproxy-ca-cert.pem` separately) and hands it to
  session containers as the `BOXES_PROXY_CA` env value; the entrypoint
  writes it to a file and the CA env vars point there. Public material only
  ever leaves the proxy volume.

## 4. The policy addon, precisely

One file, `proxy/boxes_policy.py`, unit-testable logic kept in pure
functions. Hooks (names verified against mitmproxy 12 docs; the pinning
hook is re-verified in M0):

| Hook | Does |
|---|---|
| `http_connect` | Parse target. Deny (non-2xx, kills the tunnel pre-TLS) when: allowlist active and host not matched; port not 443. Absolute-URI plain HTTP handled analogously in `request` for port 80 |
| `tls_clienthello` | `ignore_connection = True` for every host that is not an injection host → opaque passthrough, no forged cert |
| `server_connect` | Resolve the hostname, vet **all** answers against the blocked ranges (port of `cidr.ts`, including v4-mapped forms failing closed), then overwrite the upstream address with the vetted one — the same pin-after-vet that closes DNS rebinding today |
| `request` (intercepted flows only) | Look up the credential presented (`Authorization: Bearer/token/Basic`, `x-api-key`; Basic is decoded — git sends `x-access-token:<token>` that way). Known placeholder → replace with the mapped real credential and forward. Anything else, or none where one is expected → 403. Never log header values |

Allowlist semantics: exact hostnames and `*.example.com` wildcards
(one-label, no bare `*`), case-insensitive, matched against the CONNECT /
absolute-URI authority. IP-literal targets are matched as literals only.
Empty list = allowlist off (today's behavior). Injection hosts are implied
members whenever token translation is on, so a misconfigured allowlist
cannot silently sever inference.

What is deliberately *not* built: response inspection, request-body rules
(the git branch-enforcement idea — §10), per-path rules, quotas.

## 5. Repository changes

```
proxy/
├── boxes_policy.py          # NEW: the addon — all policy, pure-function core
├── policy_test.py           # NEW: pytest over the pure functions (allowlist
│                            #   match, CIDR vetting, credential parsing)
├── Dockerfile               # REWRITTEN: FROM mitmproxy/mitmproxy:<pin>,
│                            #   copies the addon, runs mitmdump with it
└── src/, vite.config.ts, package.json   # DELETED with the Node proxy
                             #   (cidr.ts logic ports into the addon + tests)
orchestrator/src/
├── config.ts                # + EGRESS_ALLOWED_HOSTS (default '': off)
│                            # + EGRESS_TOKEN_TRANSLATION ('on'|'off')
├── policy.ts                # NEW: placeholder minting, policy.json writer
│                            #   (atomic, 0600), CA cert reader
├── docker.ts                # sessionEnv: placeholders + BOXES_PROXY_CA + CA
│                            #   env vars when translation is on; real tokens
│                            #   only when it is off
├── sessions.ts              # mint/store placeholder per session on create,
│                            #   drop on delete; rewrite policy.json on both
└── reaper.ts                # proxy reconciler also re-asserts policy.json
session-image/entrypoint.sh  # writes $BOXES_PROXY_CA to ~/.boxes/proxy-ca.crt
compose.yaml                 # proxy: new image, volumes boxes-egress-policy
                             #   (ro) + boxes-proxy-ca; orchestrator: both
                             #   (policy rw, ca ro)
scripts/smoke-test.sh        # extended, §8
README.md, ARCHITECTURE.md   # network-isolation and risks sections rewritten
db migration                 # sessions table + placeholder columns (values
                             #   are secrets-lite: usable only via the proxy,
                             #   but stored hashed anyway; plaintext lives in
                             #   policy.json only)
```

The one-toolchain rule (Vite/Vitest everywhere) gets its first deliberate
exception, confined to `proxy/`: the addon is Python because the engine is,
and its tests run under pytest in the proxy's own Docker build stage (build
fails if they fail — same gate the TS packages get from `tsc && vitest`).
The alternative — keeping a second, Node proxy chained in front for policy —
buys toolchain purity with an extra network hop and two places for egress
bugs to live, and is rejected.

## 6. Milestones

### M0 — Spike: prove the two swaps end to end (throwaway code allowed)
Run mitmdump with a hand-written addon on the developer host; one real
session-image container pointed at it with placeholders.
Acceptance, each demonstrated:
1. `claude-agent-acp` completes a turn with `CLAUDE_CODE_OAUTH_TOKEN` set to
   a placeholder shaped like a real token (`sk-ant-oat01-…`), the addon
   swapping the Bearer on `api.anthropic.com`. Establishes: no pinning in
   practice, placeholder shape accepted client-side, streaming unaffected.
2. `git clone`/`push` and `gh api user` / `gh pr list` work with a
   placeholder `GH_TOKEN` (covers `gh auth setup-git`'s Basic form and gh's
   direct form).
3. **The OAuth-refresh question answered by observation**: does the adapter
   under a `setup-token` credential ever call `platform.claude.com` /
   `claude.ai` to refresh? If yes, decide: allowlist-and-passthrough those
   hosts (refreshed token then lives in the session — document as residual)
   or intercept the refresh too (proxy-held refresh). This is the plan's
   main unknown; everything else is assembly.
4. `server_connect` address-overwrite pinning confirmed against the current
   mitmproxy version.
Fallback trigger: if 1 or 2 fails for a reason that reads structural (not a
bug of ours), switch the token-translation engine to option B (§2) for the
Anthropic leg — base-URL gateway in our Node proxy — and keep mitmproxy only
if gh support is still wanted; re-plan at that point.

### M1 — Orchestrator: config, placeholders, policy file
`EGRESS_ALLOWED_HOSTS`, `EGRESS_TOKEN_TRANSLATION` in config.ts; migration;
placeholder minting on create / removal on delete; `policy.ts` writer; the
reconciler assertion. Unit tests: minting uniqueness, atomic write, file
content shape, reconciler re-write after deletion. No behavior change yet
(nothing reads the file).

### M2 — The proxy engine swap
New `proxy/Dockerfile` (pinned mitmproxy image) + `boxes_policy.py` +
pytest stage. Port `cidr.ts` vetting into the addon with its full test
table. compose volumes. Delete the Node proxy. Acceptance: the existing
smoke test passes unchanged with translation **off** and no allowlist — the
new engine must be behavior-compatible before it becomes policy-bearing.

### M3 — Session wiring
`sessionEnv` emits placeholders + CA env vars when translation is on (real
tokens when off); entrypoint writes the CA file. Acceptance: live session
completes a turn and pushes to GitHub with `EGRESS_TOKEN_TRANSLATION=on`;
`docker exec env` contains no real token.

### M4 — The security gate
Smoke-test extensions (§8) all green in both modes; README/ARCHITECTURE
rewritten (the "prompt injection can leak env tokens" risk moves from
accepted to mitigated-by-default); `live-test.sh` gains the translated-auth
turn. Owner flips the default of `EGRESS_TOKEN_TRANSLATION` to `on` here if
M0–M3 gave no reason not to.

## 7. Risks

- **OAuth refresh flow** (M0.3) — the one item that could reshape the
  Anthropic leg. Contained: worst case, refresh hosts are passthrough and
  the refreshed token's residency in the session is a documented, smaller
  residual (it still transits only allowlisted hosts).
- **mitmproxy is a big new dependency in the TCB.** Mitigated by pinning the
  image, MITMing only injection hosts (all other traffic stays opaque), and
  the CA key never leaving its volume. The engine is MIT-licensed, actively
  maintained, and the most-audited thing in this niche.
- **Client CA quirks**: some tool inside a session ignoring the CA env vars
  will fail TLS *only* against injection hosts (everything else is
  passthrough) — a confusing failure shape. Mitigation: README troubleshooting
  table (the `/root/.ccr/README.md` in Anthropic's own product is the model,
  and our env-var set matches theirs).
- **Placeholder shape drift**: a client-side format check tightening (e.g.
  the CLI validating token structure) breaks placeholders. Placeholders
  mimic real prefixes; a breakage is loud (auth error), not silent.
- **Two config surfaces** (proxy env today → orchestrator-written policy
  file) — the proxy stops being configurable standalone. Accepted: config.ts
  is already the doctrine's single source of truth.
- **HTTP/2 / streaming through interception**: mitmproxy supports h2 and
  SSE; M0.1 proves it on our exact traffic.

## 8. Smoke-test additions (the acceptance definition)

From inside a throwaway session, with allowlist `github.com,*.github.com,
api.anthropic.com,registry.npmjs.org` and translation on:

1. No real token in `env`, in `/proc/1/environ`, or under `$HOME` (grep for
   the configured secrets' values — the host script knows them).
2. `curl https://api.github.com/user` with the placeholder → 200 as the bot
   account (proof of swap).
3. Same request with an invented token → 403 **from the proxy** (foreign
   credentials rejected, not forwarded).
4. `curl https://example.com` → denied (allowlist), `https://1.1.1.1` →
   denied (not matched as literal), private ranges → denied (unchanged).
5. Allowlist unset: `example.com` reachable again (optionality), private
   ranges still denied.
6. Translation off: today's exact behavior (regression guard).
7. TLS to a passthrough host shows the host's real certificate chain; TLS to
   an injection host shows the deployment CA (interception is bounded).

## 9. Open questions for the owner

1. **Default posture once shipped**: `EGRESS_TOKEN_TRANSLATION` defaulting
   to `on` (recommended — it is strictly safer and M2 keeps `off` working as
   the escape hatch)?
2. **Is `gh` API support a requirement?** It is the main thing option A buys
   over the dependency-free option B. If the answer is "git push suffices",
   B becomes competitive and this plan's engine choice should be revisited
   before M1.
3. **Allowlist granularity**: one deployment-wide list (this plan) is enough
   for v1? Per-session lists ride the same policy.json trivially later.
4. Should the smoke test's secret-grep (8.1) also scan the workspace volume
   from the host after the run (catches an agent that copied its env
   somewhere) — cheap to add, slightly slower?

## 10. Enabled later, out of scope now

- **Content-aware git policy** at the proxy (Anthropic's design): the
  injection point already sees decrypted git smart-HTTP, so "pushes only to
  branch X / repo Y" is an addon rule away.
- **Short-lived scoped real credentials**: orchestrator mints 1-hour
  repo-scoped GitHub App installation tokens and rotates them in
  policy.json; the sandbox side changes not at all (placeholders are
  already indirection).
- **Per-session allowlists and an egress audit log** in the dashboard
  (the addon already logs structured denials per placeholder = per session).
- **More profiles**: the placeholder map is per-session already; multiple
  profiles are a config.ts change only.
