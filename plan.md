# Plan: Egress allowlist and token translation

Status: PROPOSED (revision 3). Owner guidance incorporated: (2026-08-30 a)
MITM was never ruled out — pick the *best* approach; (2026-08-30 b) the
deciding criterion is that adding tools to the session image must not keep
accumulating special-case handling. Revision 2's per-protocol gateway
design fails that criterion and is demoted to the documented alternative
(§2.4). Research facts were verified against primary sources (project
repos and docs, Anthropic engineering posts, Claude Code and GitHub docs)
on 2026-08-30. Audience: the owner first, then a coding agent. Do not
begin implementation until the owner approves this plan and decides the
open questions in §9.

---

## 1. Why, and what must be true afterwards

Two gaps in today's egress design:

1. **No allowlist.** The proxy denies private ranges and non-80/443 ports,
   and nothing else. A prompt-injected agent can POST anything it holds to
   any public host. Wanted: an optional host allowlist, so a deployment can
   say "sessions reach the Anthropic API, GitHub and npm, and nothing else".
2. **Real tokens sit inside the sandbox.** `CLAUDE_CODE_OAUTH_TOKEN` and
   `GH_TOKEN` are session-container env vars; README lists "prompt injection
   can leak a session's env tokens" as an accepted risk. Wanted: **token
   translation** — sessions hold per-session placeholder tokens; the proxy
   swaps them for real credentials on the wire; a real long-lived credential
   never exists inside a session container, and a leaked placeholder is
   useless anywhere else.

Afterwards, all of these must hold:

- With `EGRESS_ALLOWED_HOSTS` set, a session completes a turn and pushes to
  GitHub, and a request to any unlisted host is denied with a logged
  reason. Unset, behavior is today's (any public host).
- `docker exec <session> env` shows no real credential, and no file in the
  session's volumes contains one. Placeholders only.
- Real credentials authenticate only requests arriving with the matching
  placeholder. A request to an injection host carrying any *other*
  credential is denied — so "api.anthropic.com is allowlisted" no longer
  implies "data can be exfiltrated to an arbitrary Anthropic account".
- Adding a tool to the session image requires at most the uniform CA-trust
  env vars already set image-wide — no per-tool auth plumbing.
- Everything already true stays true: DNS-rebinding pinning, private-range
  blocking, fail-closed egress, `scripts/smoke-test.sh` green (extended, §8).

## 2. The approach decision

Token injection needs plaintext. There are exactly two ways to get it, and
the surveyed field (§2.3) splits cleanly along this line:

- **A. Transparent interception**: the proxy MITMs TLS for chosen hosts
  with a deployment-local CA the session trusts. Every client — git, gh,
  the adapter, curl, npm, whatever arrives next — works unmodified.
- **B. Per-protocol gateways/brokers**: each client is explicitly pointed
  at a trusted endpoint (base-URL override, credential helper, wrapper
  script) that attaches the secret. No CA, smallest TCB.

### 2.1 The criterion: marginal cost of the next tool

| | A. Selective MITM | B. Gateways/brokers |
|---|---|---|
| Add a tool | Trust the CA: one uniform env-var set (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, …) set once, image-wide. The exceptions playbook is small and well-known | Find the tool's base-URL / credential hook; write a wrapper when it has none (`gh` already needed one); some tools have no hook at all |
| Add a credential | Proxy-side: one injection host + placeholder mapping. Zero client changes | A new endpoint plus client plumbing, each time |
| Fails on | Cert-pinned clients and some gRPC/WebSocket cases — which selective passthrough handles by *not* intercepting them (they then simply carry no injected credential) | Nothing TLS-wise; instead, auth is silently absent wherever a hook is missing |
| TCB | Proxy can read intercepted flows; CA key must never leave the proxy | Smallest |

For a toolbox that grows, A wins on the owner's criterion: the per-tool
cost is a constant already paid in the image, while B pays a bespoke cost
per tool per credential, forever. B's real advantages (no CA, no
interception) are preserved in A by **intercepting only the injection
hosts** — every other allowed host remains an opaque tunnel, so the CA can
decrypt nothing but traffic we rewrite anyway. This is also where the
field landed: Anthropic's own production containment (Claude Code on the
web, and the proxy this plan was drafted under), Infisical's agent-vault,
and coder/httpjail all intercept; the no-MITM projects are all
per-protocol.

### 2.2 Reference design (Anthropic, verified from their engineering posts)

Sandboxes hold **custom scoped placeholder credentials**; a proxy outside
verifies the placeholder, optionally inspects the operation (git pushes
checked against the configured branch), then attaches the real credential
and forwards. A *defensive* MITM on `api.anthropic.com` rejects requests
not carrying the session's own token, closing the allowlisted-API-host
exfiltration hole. Domain allowlist at the same choke point. The design is
proven in production; the service itself is not released.

### 2.3 The field, verified

| Project | Pattern | Verdict for Boxes |
|---|---|---|
| **mitmproxy** (MIT, v12, official Docker image) | Scriptable interception engine: addon hooks can reject CONNECT pre-tunnel (allowlist), selectively pass hosts through un-intercepted, rewrite headers on intercepted flows; mature CA lifecycle | **The engine to adopt.** Everything hard (CA, per-host certs, HTTP/2, SSE) is its problem; our policy is one small addon |
| **Infisical agent-vault** | Purpose-built MITM credential proxy + vault *for AI agents* (Claude Code named): strips agent-supplied creds, injects vault creds, re-originates TLS | Exactly this plan as a product — but a research preview, new, and brings a vault stack. Time-boxed evaluation in M0; adopt-instead if it holds up (§9.1) |
| **anthropic-experimental/sandbox-runtime** | Claude Code's own sandbox: CONNECT-time allowlist no-MITM by default; experimental `tlsTerminate` + `filterRequest` for injection | Closest philosophical match, Apache-2.0 — but the proxy isn't packaged standalone and injection is thinly documented. Crib from, don't depend on |
| **coder/httpjail** | Per-process egress filter, default-deny, JS rules, MITMs for HTTPS inspection | Filter only, no injection; experimental |
| **superfly/tokenizer** | No-MITM secret-injecting proxy (client sends plain `http://` + sealed-secret header); has a `github_app_processor` minting 1 h installation tokens | The best of family B: right pattern, active, Apache-2.0 — but needs client-side header plumbing per tool, which is the criterion failure |
| **LiteLLM** | LLM gateway, official Claude Code docs, virtual keys | Anthropic leg only, needs Postgres, and **cannot hold a subscription OAuth token upstream (API keys only)** — Boxes runs on `claude setup-token` |
| smokescreen, init-firewall.sh, OpenSandbox DNS sidecar | Allowlist-only (proxy / iptables / DNS layer) | Solve half the problem; our proxy already does the harder vetting |
| CyberArk secretless-broker | Localhost plaintext → header injection | Right idea, maintenance-mode, no per-client auth |
| **GitHub App installation tokens** | 1 h expiry, mintable per-repo and per-permission; the GitHub Actions `GITHUB_TOKEN` model; official + community tooling | Not an engine but a hardening: the credential the proxy injects can itself be disposable (§3, §10) |
| Squid ssl_bump / Envoy / google-martian | — | Header-add removed in Squid 8 / cannot MITM inside CONNECT / archived. All rejected |

### 2.4 The documented alternative (revision 2, kept as fallback)

Per-protocol, no CA: Claude Code's gateway mode (`ANTHROPIC_BASE_URL` +
placeholder `ANTHROPIC_AUTH_TOKEN`) against an injector endpoint, plus
orchestrator-brokered App tokens via git credential helper and a `gh`
wrapper. Verified workable end to end. It remains the escape hatch if M0
falsifies interception on our traffic — and its brokering half survives
into this design as the source of the GitHub credential.

### 2.5 Client-side facts (verified)

Claude Code honors `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`; its docs
explicitly support TLS-inspection proxies — **no certificate pinning** —
and public prior art exists of swapping its API credential at a mitmproxy.
Auth reaches the API as `Authorization: Bearer` (OAuth/`ANTHROPIC_AUTH_TOKEN`)
or `x-api-key`. git trusts a CA via `GIT_SSL_CAINFO`, gh (Go) via
`SSL_CERT_FILE`, curl via `CURL_CA_BUNDLE` — all env-deliverable, no root,
no writable rootfs. Gateways carrying subscription OAuth must forward the
OAuth capability in `anthropic-beta`.

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
              │  1 allowlist check (optional)   │──── deny, logged
              │  2 resolve + vet all answers,   │
              │    pin upstream to vetted addr  │──── deny (rebinding, private)
              │  3 injection host?              │
              │     no  → opaque tunnel         │──── TLS passthrough
              │     yes → intercept TLS:        │
              │       placeholder → real cred   │
              │       anything else → deny      │
              └───────┬─────────────────▲───────┘
                      │ internet        │ policy.json (ro volume): allowlist,
                      ▼                 │ placeholder→credential map
                                 orchestrator: writes it (atomic, 0600);
                                 the existing 60 s proxy reconciler
                                 re-asserts it; optional broker mints the
                                 GitHub credential it contains (§ below)
```

- **Interception is the exception.** Only the injection hosts
  (`api.anthropic.com`, `github.com`, `api.github.com`, `uploads.github.com`)
  are MITMed. Every other allowed host is an opaque tunnel exactly as
  today. Cert-pinned or gRPC-odd tools land on the passthrough side by
  default and simply carry no injected credential.
- **Placeholders are per-session** random values minted by the orchestrator
  at session create, shaped like the real tokens (`sk-ant-oat01-…` /
  `ghp_…`) so client-side format checks pass. The placeholder itself
  identifies the session at the proxy — no source-IP mapping — enabling
  per-session policy later (§10) and making a leaked placeholder traceable
  and individually revocable (delete the session). The addon matches it in
  every arriving form: `Bearer`, `token`, `x-api-key`, and Basic
  (`x-access-token:<token>` — git's form, decoded).
- **The GitHub credential the proxy injects is itself disposable** when a
  GitHub App is configured: the orchestrator mints a 1 h installation token
  scoped to the session's repo (contents rw, PRs per §9.3), refreshes it
  into policy.json before expiry, and the addon injects whatever is
  current. Even a proxy-side compromise then exposes a dying, single-repo
  token rather than a PAT; and the sandbox side never changes. With no App
  configured, the injected credential is the profile PAT — still never
  inside the session. The App is recommended, not required (§9.3).
- **Policy transport**: `policy.json` on a named volume, written atomically
  (0600) by the orchestrator, mounted read-only into the proxy; the addon
  reloads on mtime change. No admin API, no secrets on the compose network,
  either container restarts independently.
- **CA material**: mitmproxy generates its CA into a confdir volume only
  the proxy mounts. The orchestrator reads the *certificate*
  (`mitmproxy-ca-cert.pem`; the key never leaves the volume) and hands it
  to sessions as the `BOXES_PROXY_CA` env value; the entrypoint writes it
  to a file the CA env vars point at. Public material only.

**Engine: adopt, don't build.** TLS interception is mature, audited ground
in mitmproxy and treacherous to reimplement (Node cannot even mint
certificates without a new crypto dependency — at which point we'd be
building a worse mitmproxy). What stays ours is the policy addon — the
same ~150 lines of judgement under any engine. Infisical agent-vault could
replace engine *and* addon and gets a time-boxed M0 look (§9.1); mitmproxy
is the default for maturity.

## 4. The policy addon, precisely

One file, `proxy/boxes_policy.py`, policy kept in pure functions. Hooks
(named per mitmproxy 12 docs; the pinning hook is re-verified in M0):

| Hook | Does |
|---|---|
| `http_connect` | Parse target. Deny (non-2xx, kills the tunnel pre-TLS) when: allowlist active and host unmatched; port not 443. Absolute-URI plain HTTP handled analogously in `request` for port 80 |
| `tls_clienthello` | `ignore_connection = True` for every non-injection host → opaque passthrough, no forged cert |
| `server_connect` | Resolve, vet **all** answers against blocked ranges (port of `cidr.ts`, v4-mapped forms failing closed), overwrite the upstream address with the vetted one — the same pin-after-vet that closes DNS rebinding today |
| `request` (intercepted flows only) | Credential presented is a known placeholder → replace with the mapped real credential (adding the `anthropic-beta` OAuth capability when the real credential is `sk-ant-oat…`) and forward. Anything else, or none where one is expected → 403. Never log header values |

Allowlist semantics: exact hostnames and `*.example.com` wildcards
(one label, no bare `*`), case-insensitive, matched on the CONNECT /
absolute-URI authority; IP literals match as literals only. Empty = off
(today's behavior). Injection hosts are implied members whenever
translation is on, so a narrow allowlist cannot silently sever inference.

Deliberately not built now: response inspection, request-body rules (the
git branch-enforcement idea — §10), per-path rules, quotas.

## 5. Repository changes

```
proxy/
├── boxes_policy.py          # NEW: the addon — all policy, pure-function core
├── policy_test.py           # NEW: pytest over the pure functions (allowlist
│                            #   match, CIDR vetting, credential parsing)
├── Dockerfile               # REWRITTEN: FROM mitmproxy/mitmproxy:<pin>,
│                            #   copies the addon, runs mitmdump with it;
│                            #   pytest stage gates the build
└── src/, vite.config.ts, package.json   # DELETED with the Node proxy
                             #   (cidr.ts logic and tests port to the addon)
orchestrator/src/
├── config.ts                # + EGRESS_ALLOWED_HOSTS ('' = off)
│                            # + EGRESS_TOKEN_TRANSLATION ('on'|'off')
│                            # + PROFILE_DEFAULT_GITHUB_APP_ID /
│                            #   _INSTALLATION_ID / _GITHUB_APP_KEY_FILE
├── policy.ts                # NEW: placeholder minting; atomic policy.json
│                            #   writer; CA cert reader
├── broker.ts                # NEW (optional path): installation-token mint —
│                            #   RS256 JWT via node:crypto (~20 lines, no
│                            #   dependency) + refresh-before-expiry loop
├── docker.ts                # sessionEnv: placeholders + BOXES_PROXY_CA + CA
│                            #   env vars when translation on; real tokens
│                            #   only when off
├── sessions.ts              # placeholder lifecycle on create/delete
└── reaper.ts                # reconciler re-asserts policy.json currency
session-image/entrypoint.sh  # writes $BOXES_PROXY_CA to ~/.boxes/proxy-ca.crt
compose.yaml                 # proxy: new image; volumes boxes-egress-policy
                             #   (orchestrator rw / proxy ro) + boxes-proxy-ca
                             #   (proxy rw / orchestrator ro)
shared/types.ts              # healthz gains translation/allowlist status
scripts/smoke-test.sh        # extended, §8
README.md, ARCHITECTURE.md   # network-isolation and risks sections rewritten;
                             #   a CA-trust troubleshooting table for future
                             #   tools (the uniform playbook §2.1 relies on)
db migration                 # sessions + placeholder columns (stored hashed;
                             #   plaintext lives in policy.json only)
```

The one-toolchain rule (Vite/Vitest everywhere) gets its first deliberate
exception, confined to `proxy/`: the addon is Python because the engine is,
and pytest gates its Docker build exactly as `tsc && vitest` gate the TS
images. The alternative — keeping a Node proxy chained in front for
policy — buys toolchain purity with an extra hop and two homes for egress
bugs, and is rejected.

## 6. Milestones

### M0 — Spike: prove the swaps end to end (throwaway code allowed)
mitmdump + hand-written addon on the developer host; one real session-image
container with placeholders. Acceptance, each demonstrated:
1. `claude-agent-acp` completes a turn with a placeholder
   `CLAUDE_CODE_OAUTH_TOKEN`, the addon swapping the Bearer on
   `api.anthropic.com` (upstream: the real `setup-token` credential, with
   the `anthropic-beta` capability as needed). Establishes: no pinning in
   practice, placeholder shape accepted client-side, SSE unaffected.
2. `git clone`/`push` and `gh api user` / `gh pr list` with a placeholder
   `GH_TOKEN` (covers git's Basic form and gh's direct form).
3. **OAuth-refresh answered by observation**: does the adapter under a
   `setup-token` credential ever call `platform.claude.com` / `claude.ai`
   to refresh? If yes: passthrough-and-allowlist those hosts (refreshed
   token then lives in-session — documented residual) or intercept the
   refresh too. The plan's main unknown; the rest is assembly.
4. `server_connect` address-overwrite pinning confirmed on current
   mitmproxy.
5. Time-boxed (half a day): Infisical agent-vault against the same two
   scenarios — adopt-instead if it passes and its vault footprint is
   acceptable (§9.1).
Fallback trigger: a structural failure of 1 or 2 → revision 2's
per-protocol design (§2.4) is the fallback; re-plan at that point.

### M1 — Orchestrator: config, placeholders, policy file
Config keys; migration; placeholder mint/drop on create/delete;
`policy.ts` writer; reconciler assertion. Unit tests: mint uniqueness,
atomic write, file shape, re-write after deletion. No behavior change yet.

### M2 — The engine swap
New `proxy/Dockerfile` + `boxes_policy.py` + pytest stage; port `cidr.ts`
vetting with its full test table; compose volumes; delete the Node proxy.
Acceptance: the existing smoke test passes unchanged with translation
**off** and no allowlist — the new engine must be behavior-compatible
before it becomes policy-bearing. Allowlist probes (§8.4–5) land here too.

### M3 — Session wiring
`sessionEnv` emits placeholders + CA env vars when translation on (real
tokens when off); entrypoint writes the CA file. Optional broker
(`broker.ts`) when App credentials are configured. Acceptance: live
session completes a turn and pushes with `EGRESS_TOKEN_TRANSLATION=on`;
`docker exec env` contains no real credential.

### M4 — The security gate
Smoke-test extensions (§8) green in all modes; README/ARCHITECTURE
rewritten (the env-token-leak risk moves from accepted to
mitigated-by-default); `live-test.sh` gains the translated turn. Owner
flips `EGRESS_TOKEN_TRANSLATION` default to `on` if M0–M3 gave no reason
not to.

## 7. Risks

- **OAuth refresh flow** (M0.3) — the one item that could reshape the
  Anthropic leg; contained by the two named handlings.
- **mitmproxy is a large new TCB member.** Mitigated: pinned image,
  interception limited to injection hosts (all else opaque), CA key never
  leaves its volume, and the addon never logs credentials. MIT, actively
  maintained, the most-scrutinized tool in this niche.
- **A tool ignoring the CA env vars** fails TLS *only* against injection
  hosts — a confusing shape. Mitigation: the README troubleshooting table
  (Anthropic's own agent-proxy README is the model; our env-var set
  matches theirs).
- **Placeholder shape drift**: a client-side token format check tightening
  breaks placeholders loudly (auth error), not silently.
- **Broker refresh**: an App token expiring between refresh and injection
  fails one request; refresh runs well before expiry and a 401 observed by
  the addon is logged with a policy-refresh hint.
- **Two config surfaces** collapse into one: proxy behavior now comes from
  orchestrator-written policy, per doctrine (config.ts is the single
  source). The proxy still forwards with no policy file; translation
  routes simply refuse.
- **HTTP/2 / SSE through interception**: mitmproxy supports both; M0.1
  proves it on our exact traffic.

## 8. Smoke-test additions (the acceptance definition)

From inside a throwaway session, allowlist `github.com,*.github.com,
*.githubusercontent.com,api.anthropic.com,registry.npmjs.org`, translation
on:

1. No real credential in `env`, `/proc/*/environ`, or the session volumes
   (host-side grep with the configured values).
2. `curl https://api.github.com/user` with the placeholder → 200 as the
   bot identity (proof of swap); with an invented token → 403 **from the
   proxy** (foreign credentials rejected, not forwarded).
3. With an App configured: the credential GitHub sees is an installation
   token whose `/installation/repositories` lists only the session repo.
4. `https://example.com` → denied (allowlist); `https://1.1.1.1` → denied
   (unmatched literal); private ranges → denied (unchanged).
5. Allowlist unset: `example.com` reachable again; private ranges still
   denied.
6. Translation off: today's exact env and behavior (regression guard).
7. TLS to a passthrough host shows the host's real certificate chain; TLS
   to an injection host shows the deployment CA (interception is bounded).

## 9. Open questions for the owner

1. **Engine**: mitmproxy + our addon (recommended: mature engine, policy
   stays ours), or adopt Infisical agent-vault wholesale if the M0.5
   evaluation passes (purpose-built, but research-preview young and brings
   a vault stack)?
2. **Default posture once shipped**: `EGRESS_TOKEN_TRANSLATION` → `on` at
   M4 (recommended; `off` remains the escape hatch)?
3. **GitHub App**: register one on the bot account so the injected
   credential is a 1 h repo-scoped installation token (recommended), and if
   so, `contents:rw` only or also `pull_requests:rw`? Without an App the
   proxy injects the PAT — still never in-session.
4. **Allowlist granularity**: one deployment-wide list for v1 (this plan)?
   Per-session lists ride the same policy.json trivially later.
5. Ship `.env.example` with the §8 working allowlist commented in?

## 10. Enabled later, out of scope now

- **Content-aware git policy** at the proxy (Anthropic's design): the
  injection point already sees decrypted git smart-HTTP; "pushes only to
  branch X" is an addon rule away.
- **Per-operation broker minting** (token per push, not per hour) once the
  broker exists.
- **Per-session allowlists and an egress audit view** in the dashboard
  (denials already log per placeholder = per session).
- **More profiles / more credentials**: a new injection host + mapping in
  policy.json and an env var in the image — no client plumbing, which is
  the point of revision 3.
