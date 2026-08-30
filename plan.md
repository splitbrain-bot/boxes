# Plan: Egress allowlist and token translation

Status: PROPOSED (revision 7). All open questions are now decided; this
revision cuts v1 to the decided scope. Owner decisions:
(a) MITM is the way — selective TLS interception at the egress proxy,
chosen for the marginal cost of the next tool (§2.1).
(b) **No time-limited GitHub tokens**: the proxy injects the configured
PAT; App-minted short-lived tokens are future work (§9).
(c) **Engine is mockttp** (TypeScript) — the proxy stays a TypeScript
service, one toolchain, no Python (§2.2).
(d) **No credentials on any filesystem**: the orchestrator hands the proxy
its policy and secrets over an authenticated in-memory control channel,
never a file (§2.3).
(e) **Translation is always on** — no toggle. The mechanism is always
active; it translates whichever credentials the deployment configures
(§3.1).
(f) **All credentials come from the environment; no database storage in
v1.** Dashboard-managed and dynamically-attached credentials — and the
SQLite tables they needed — are deferred to future work (§9). This
reverses the dynamic-credential scope of revisions 4–6.
(g) **One allowlist per deployment**, from one env var (§3.2).
(h) **Keep `.env` simple**: the only new setting is the optional
allowlist; everything else defaults or self-generates.

Research facts were verified against primary sources on 2026-08-30.
Audience: the owner first, then a coding agent. Follow milestones in order
(§6); M0 is a de-risking spike before committed code.

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
   translation** — sessions hold placeholder tokens; the proxy swaps them
   for the real credentials on the wire; a real credential never exists
   inside a session container, and a leaked placeholder is useless anywhere
   an attacker could take it.

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
- No real credential is written to a filesystem anywhere. The proxy holds
  secrets in memory only, received over an authenticated channel; it is
  secret-free at rest.
- The repository keeps one toolchain (TypeScript, Vite, Vitest); no new
  language, no new container, no new base image.
- Everything already true stays true: DNS-rebinding pinning, private-range
  blocking, fail-closed egress, `scripts/smoke-test.sh` green (extended, §7).

## 2. The approach

### 2.1 Interception over per-protocol gateways (settled)

Token injection needs plaintext; the two ways to get it are transparent
TLS interception (deployment-local CA) or per-protocol gateways/brokers
(base-URL overrides, credential helpers, wrapper scripts). The deciding
criterion is the marginal cost of the next tool: with interception it is
the CA-trust env vars set once image-wide; with gateways it is a bespoke
hook per tool per credential, forever, and some tools have no hook (`gh`
already needed a wrapper). Interception's failure cases — cert-pinned
clients, odd gRPC — are handled by *not* intercepting them: only credential
hosts are ever MITMed; everything else stays an opaque tunnel the CA cannot
read. The per-protocol design (plan revision 2, in git history) is the
documented fallback if the M0 spike falsifies interception on our traffic.

Reference design, verified from Anthropic's engineering posts: sandboxes
hold scoped placeholder credentials; a proxy verifies the placeholder,
swaps in the real credential, enforces a domain allowlist, and rejects
requests to the API host not carrying the session's own token. Client-side
facts, verified: Claude Code honors `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`,
docs explicitly support TLS-inspection proxies, no certificate pinning; git
trusts a CA via `GIT_SSL_CAINFO`, gh via `SSL_CERT_FILE`, curl via
`CURL_CA_BUNDLE` — all env-deliverable, no root, no writable rootfs.

### 2.2 Engine: mockttp (TypeScript)

The proxy stays a TypeScript service; **mockttp** (`httptoolkit/mockttp`)
is the interception engine — the HTTP engine of HTTP Toolkit, a shipping
product, and a general-purpose programmable TLS-intercepting proxy library,
verified against primary sources:

| Requirement | mockttp | Verified |
|---|---|---|
| CA-based TLS termination, on-the-fly per-host leaf certs | `generateCACertificate()`; mints leaves per host | ✓ |
| Rewrite the credential header on an intercepted HTTPS request | `.thenPassThrough({ transformRequest: { updateHeaders: { authorization: … } } })`, plus `beforeRequest` callbacks | ✓ |
| Selective passthrough (MITM injection hosts, tunnel the rest) | per-host rules + `tlsPassthrough`/`tlsInterceptOnly` options | ✓ |
| HTTP/2 and SSE/streaming | `http2` option, tested; streams bodies | ✓ |
| TypeScript, embeddable in a Node service | written in TS, first-class | ✓ |
| Maintained, adopted, permissive licence | v4.6.1, ~496k downloads/wk, last push 2026-08-26, **Apache-2.0** | ✓ |

It maps 1:1 onto Formal.ai's public "hide secrets from Claude Code"
mitmproxy addon, minus the Python. Rejected alternatives: `http-mitm-proxy`
(MIT, works, but no HTTP/2 and last release 2023 — kept as the M0 fallback
engine); `proxy-chain` (CONNECT tunnelling only); `hoxy`/`anyproxy`
(stale); hand-rolling `node-forge` + `SNICallback` (re-implements mockttp).
Engine risks carried into M0: mockttp lowercases header names on transform
(RFC-compliant, confirm the APIs accept it); single-maintainer project
(mitigated by Apache-2.0 + heavy adoption); pin the major version. We embed
the **`mockttp` npm package (Apache-2.0)** only, never the AGPL app/server.

### 2.3 No files between orchestrator and proxy

Because the proxy is Node, the orchestrator↔proxy interface is an
**authenticated in-memory control channel**, not a shared file. The proxy
is a thin TypeScript service that embeds mockttp and holds *no state at
rest*: no database, no config file with secrets, no CA on disk. It boots
empty and receives its entire policy — allowlist, CA key+cert, and the
injection map (host, header kind, placeholder → real secret) — from the
orchestrator over the compose network, held in memory. Pattern (verified as
standard): a small control endpoint the orchestrator pushes to,
authenticated by a self-generated bearer token, bound to the compose-network
interface. Sessions live on internal networks with no L3 route to that
interface — the proxy bridges them at L7, it does not route — so the
control channel is unreachable from a session even before the token check.
On proxy restart the proxy has nothing until the orchestrator re-pushes;
the existing 60-second reconciler re-asserts proxy state and now re-pushes
policy too. Status flows back on the same channel (applied-policy hash,
denial tallies) — no file in either direction.

## 3. Architecture after the change

```
┌────────────────────────── session network sn-<id> (internal) ─────────────┐
│  session container                                                        │
│    env: HTTPS_PROXY=http://proxy:3128                                     │
│         CLAUDE_CODE_OAUTH_TOKEN / GH_TOKEN = placeholders (set where the  │
│           real tokens are set today, in sessionEnv)                       │
│         BOXES_PROXY_CA (PEM) → ~/.boxes/proxy-ca.crt via entrypoint;      │
│           NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / GIT_SSL_CAINFO /          │
│           CURL_CA_BUNDLE point at it                                      │
└──────────────────────────────┬─────────────────────────────────────────---┘
                               │ CONNECT host:443  (session-facing iface)
              ┌────────────────▼────────────────┐
              │  egress proxy (TypeScript)      │
              │  embeds mockttp; secret-free    │
              │  at rest — policy in memory     │
              │                                 │
              │  1 allowlist check (optional)   │──── deny, logged
              │  2 resolve + vet all answers,   │
              │    pin upstream to vetted addr  │──── deny (rebinding, private)
              │  3 injection host?              │
              │     no  → tlsPassthrough tunnel │──── not decrypted
              │     yes → intercept + swap:     │
              │       placeholder → real cred   │
              │       anything else → deny      │
              └────────────────▲────────────────┘
                               │ authenticated control channel
                               │ (compose-network iface, bearer token):
                               │  push  policy = allowlist + CA key/cert +
                               │        injection map (in memory only)
                               │  reply status = applied hash, denial tallies
              ┌────────────────┴────────────────┐
              │        orchestrator             │  config.ts (env) is the whole
              │  composes policy from env        │  source of credentials + the
              │  + generated CA/placeholders     │  allowlist; generated CA and
              │  REST + dashboard (unchanged)    │  placeholders persist in
              │  60 s reconciler re-pushes       │  DATA_DIR like the WS token
              └─────────────────────────────────┘
```

### 3.1 What "always on, from env" means

Translation is always active, but a host becomes an **injection host only
when its credential is configured** in the environment:

- The Claude credential (`PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`) set →
  `api.anthropic.com` is intercepted; the session's placeholder is swapped
  for the real token; a foreign credential to that host is denied.
- The GitHub PAT (`PROFILE_DEFAULT_GH_TOKEN`) set → the GitHub hosts
  (`github.com`, `api.github.com`, `*.githubusercontent.com`) are
  injection hosts likewise.
- A credential **not** set stays today's behavior: its host, if allowed, is
  a normal passthrough tunnel. This preserves the documented "log in inside
  a session" flow — a session running `claude setup-token` reaches the
  OAuth hosts and keeps its own token, exactly as now. (Residual, same as
  today: with no configured Claude token, `api.anthropic.com` is a plain
  allowed host, not a translation boundary.)

The credential set is fixed at orchestrator boot. Each configured
credential has a known host list and header kind built into config.ts (not
user-specified in v1). The proxy's policy is therefore **static per
deployment**: composed once from env at boot, pushed to the proxy, and
re-pushed only on proxy restart — no per-session or runtime mutation.

**Placeholders are per-deployment**, one opaque value per configured
credential, shaped like the real token (`sk-ant-oat01-…` / `ghp_…`) so
client-side format checks pass, generated at first boot and persisted in
`DATA_DIR` beside the CA (so a restart doesn't invalidate the env of
running sessions). Per-*session* placeholders were considered and dropped
for v1: with a single shared set of env credentials they buy almost nothing
in this threat model — the placeholder only works from inside a session
network through the proxy, which an off-host attacker cannot reach, and a
sibling session already maps to the same real secret — while per-session
minting would make the policy mutate on every session lifecycle. They
return naturally with the deferred dynamic-credential feature (§9).

### 3.2 Allowlist

One deployment-wide list in `EGRESS_ALLOWED_HOSTS`: exact hostnames and
`*.example.com` wildcards (one label, no bare `*`), case-insensitive,
checked at CONNECT before DNS vetting; IP literals match as literals only.
Empty/unset = off (today's behavior — any public host, private ranges
still denied). The configured credentials' hosts are implied members, so a
narrow allowlist can never sever inference or GitHub.

### 3.3 CA material

Generated once by the orchestrator via mockttp's `generateCACertificate()`
and persisted in `DATA_DIR` (0600) exactly as `secret.ts` persists the
generated WS token today — orchestrator-side key material on the
orchestrator's own data volume, not a credential fed to the proxy over the
filesystem. The orchestrator pushes the CA **key and cert** into proxy
memory (the proxy signs leaves) and hands the CA **cert** (public) to
sessions as `BOXES_PROXY_CA`; the entrypoint writes the file the CA env
vars point at. Regenerating on every boot is wrong — running sessions hold
the old cert in their trust file — so it persists; rotation is deleting the
stored CA.

## 4. What is deliberately NOT in v1

Cut to honor decisions (f) and (h), all recorded in §9 as future work:

- No `credentials`/`session_credentials` SQLite tables, no DB migration.
- No credential REST routes, no dashboard credential card or library view.
- No mid-session dynamic attach, no `~/.boxes/env` sourcing — sessions get
  their placeholders as container env at create, where the real tokens are
  set today, and that is the only delivery path.
- No `EGRESS_TOKEN_TRANSLATION` toggle.
- No per-session placeholders, no per-session allowlists.
- No time-limited/App GitHub tokens.

## 5. Repository changes

```
proxy/
├── src/
│   ├── main.ts          # embeds mockttp; boots empty; serves the control
│   │                    #   channel; applies pushed policy; proxy on :3128
│   ├── policy.ts        # in-memory policy: allowlist match, injection map,
│   │                    #   placeholder→secret lookup — pure functions
│   ├── inject.ts        # mockttp rule wiring: tlsPassthrough vs intercept,
│   │                    #   transformRequest header swap, foreign-cred deny
│   ├── control.ts       # authenticated push endpoint + status reply
│   ├── cidr.ts          # unchanged — resolved-IP vetting, still the boundary
│   └── *.test.ts        # Vitest (allowlist grammar, cidr, credential parse,
│                        #   swap/deny logic over mockttp in-process)
├── package.json         # + mockttp; Vite/Vitest as today
└── Dockerfile           # unchanged shape (Node); no new base image
orchestrator/src/
├── config.ts            # + EGRESS_ALLOWED_HOSTS ('' = off). The credential
│                        #   set (Claude, GitHub) with its fixed host lists +
│                        #   header kinds is defined here. Control URL/token
│                        #   default + self-generate — no .env entry
├── egress.ts            # NEW: generate + persist CA and placeholders in
│                        #   DATA_DIR (secret.ts pattern); compose the policy
│                        #   from config; push it to the proxy; read status
├── docker.ts            # sessionEnv: placeholders + BOXES_PROXY_CA + CA env
│                        #   vars in place of the real tokens
├── reaper.ts            # reconciler re-pushes policy, reads status into
│                        #   /healthz state
sessions/index          # no change — policy is static; nothing per-session
session-image/entrypoint.sh  # writes $BOXES_PROXY_CA to ~/.boxes/proxy-ca.crt
compose.yaml             # proxy unchanged as a service; no new volumes
shared/types.ts          # control-channel message shapes; healthz sync fields
scripts/smoke-test.sh    # extended, §7
README.md, ARCHITECTURE.md  # network/risks sections rewritten + a CA-trust
                         #   troubleshooting table for future tools
.env.example             # + EGRESS_ALLOWED_HOSTS, commented, one line
```

No new language, no new container, no new base image, no DB migration, no
secret file feeding the proxy. mockttp is a library dependency of an
existing package; the CA and placeholders persist like the existing WS
token; all real secrets stay in the orchestrator's env and memory and the
proxy's memory.

## 6. Milestones

### M0 — Spike: prove interception + the swaps end to end (throwaway OK)
A minimal mockttp proxy plus one real session-image container with
placeholders. Acceptance, each demonstrated:
1. `claude-agent-acp` completes a turn with a placeholder
   `CLAUDE_CODE_OAUTH_TOKEN`, mockttp swapping the Bearer on
   `api.anthropic.com` (upstream: the real `setup-token` credential, with
   the `anthropic-beta` OAuth capability as needed). Establishes: no
   pinning in practice, placeholder shape accepted client-side, SSE
   survives interception, header lowercasing accepted by the API.
2. `git clone`/`push` and `gh api user` / `gh pr list` with a placeholder
   `GH_TOKEN` (git's Basic form and gh's direct form), GitHub accepting the
   transformed headers.
3. **OAuth-refresh answered by observation**: does the adapter under a
   `setup-token` credential ever call `platform.claude.com` / `claude.ai`
   to refresh? If yes: passthrough-and-allowlist those hosts (refreshed
   token then lives in-session — documented residual) or intercept the
   refresh too. The plan's main unknown.
4. mockttp `tlsPassthrough` vs intercept per host confirmed; **resolved-IP
   pinning wired onto mockttp's real upstream socket** (the `cidr.ts`
   vetting must act on the actual connection, not a re-resolve — if mockttp
   lacks a clean hook, pin via a custom `http(s).Agent`/lookup). This is
   the one place the library could make the security-critical path awkward;
   settle it here.
5. Control-channel push applies a policy into a running proxy with no
   restart.
Fallback: a structural mockttp failure on 1/2/4 → `http-mitm-proxy`
(no HTTP/2); a structural interception failure → per-protocol design
(revision 2). Re-plan at that point.

### M1 — Orchestrator: config, CA/placeholders, policy push
`EGRESS_ALLOWED_HOSTS`; the credential-set definition in config.ts;
`egress.ts` (generate + persist CA and placeholders; compose policy; push;
status); reconciler re-push. Unit tests: policy composition from a fake
config, allowlist grammar, push auth, status parsing, CA persistence
round-trip. No behavior change to sessions yet.

### M2 — The engine swap
mockttp-based `proxy/src`; control-channel server; port `cidr.ts` vetting
onto the upstream socket with its full test table; allowlist enforcement.
Acceptance: the existing smoke test passes unchanged for **non-injection**
traffic (plain forwarding, private-range and port denials, DNS-rebinding
pin) — the new engine is behavior-compatible before it carries injection.
Allowlist probes (§7.4–5) land here.

### M3 — Session wiring
`sessionEnv` emits placeholders + CA env vars in place of the real tokens;
entrypoint writes the CA file. Acceptance: live session completes a turn
and pushes; `docker exec env` contains no real credential; nothing secret
on any session volume.

### M4 — The security gate
Smoke-test extensions (§7) green; README/ARCHITECTURE rewritten (the
env-token-leak risk moves from accepted to mitigated); `live-test.sh` gains
the translated turn. Translation being always-on, there is no default to
flip — shipping M4 is shipping the feature.

## 7. Smoke-test additions (the acceptance definition)

From inside a throwaway session, allowlist `github.com,*.github.com,
*.githubusercontent.com,api.anthropic.com,registry.npmjs.org`, both
credentials configured:

1. No real credential in `env`, `/proc/*/environ`, or the session volumes
   (host-side grep with the configured values).
2. `curl https://api.github.com/user` with the placeholder → 200 as the
   bot identity (proof of swap); with an invented token → 403 **from the
   proxy** (foreign credentials rejected, not forwarded). Same for the
   Anthropic host.
3. `https://example.com` → denied (allowlist); `https://1.1.1.1` → denied
   (unmatched literal); private ranges → denied (unchanged).
4. Allowlist unset: `example.com` reachable again; private ranges still
   denied.
5. TLS to a passthrough host shows the host's real certificate chain; TLS
   to an injection host shows the deployment CA (interception is bounded).

## 8. Risks

- **OAuth refresh flow** (M0.3) — the one item that could reshape the
  Anthropic leg; contained by the two named handlings.
- **Upstream-socket pinning through the library** (M0.4) — the
  DNS-rebinding defense must act on mockttp's real upstream connection.
  Settled in the spike; custom-agent fallback known.
- **mockttp is a new, single-maintainer TCB dependency.** Mitigated:
  Apache-2.0, ~496k downloads/wk, HTTP Toolkit production use, pinned major
  version, interception limited to injection hosts, `http-mitm-proxy` as
  the fallback engine.
- **Control-channel exposure**: a secret-bearing endpoint on the proxy,
  mitigated by compose-network-only binding (no session L3 route), a bearer
  token, and memory-only policy. A compromised proxy sees the credentials
  it injects — unchanged from any injecting-proxy design — but leaves
  nothing at rest.
- **A tool ignoring the CA env vars** fails TLS *only* against injection
  hosts — a confusing shape. Mitigation: the README troubleshooting table.
- **CA/placeholders persisted in DATA_DIR**: orchestrator-side key material
  on its own volume, the WS-token precedent; not proxy-side and not a
  credential fed over the filesystem.
- **Placeholder shape drift**: a client-side token format check tightening
  breaks placeholders loudly (auth error), not silently.
- **HTTP/2 + rewriting edge cases**: mockttp supports and tests H2; M0.1
  proves it on our exact upstreams.

## 9. Future work (out of scope for v1, enabled by this design)

- **Dashboard-managed and dynamically-attached credentials** (the deferred
  decision-c feature): a `credentials` + `session_credentials` schema,
  REST routes, a SessionInfo card, mid-session delivery via `~/.boxes/env`,
  and per-session placeholders for independent revocation. The control
  channel and policy-push machinery built in v1 is exactly what they push.
- **Short-lived scoped GitHub credentials** (App installation tokens): the
  injection point makes them a policy push, zero sandbox-side change, if
  the PAT's blast radius ever bothers us.
- **Content-aware git policy** at the proxy (Anthropic's design): the
  injection point already sees decrypted git smart-HTTP; "pushes only to
  branch X" is a rule away.
- **Per-session allowlists and an egress audit view** in the dashboard
  (status can carry per-host denial tallies).
