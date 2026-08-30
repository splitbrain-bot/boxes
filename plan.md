# Plan: Egress allowlist and token translation

Status: PROPOSED (revision 6). Owner decisions incorporated:
(2026-08-30 a) MITM is the way to go — selective TLS interception at the
egress proxy, chosen for the marginal cost of the next tool (§2).
(2026-08-30 b) **No time-limited GitHub tokens**: the proxy injects the
configured PAT; App-minted short-lived tokens move to future work (§10).
(2026-08-30 c) **Credentials must be dynamically attachable to sessions**,
managed from the dashboard, not only fixed at boot (§4).
(2026-08-30 d) **Runtime credentials live in the SQLite database**, not a
side file (§4).
(2026-08-30 e) **No Python, and no credentials on the filesystem.** The
engine is **mockttp**, a TypeScript MITM library — the proxy stays a
TypeScript service, one toolchain, and the orchestrator hands it policy
and secrets over an authenticated in-memory control channel, never a file
(§2.3, §3, §4). This reverses revision 4/5's mitmproxy choice and its
`policy.json` file.
Research facts were verified against primary sources on 2026-08-30.
Audience: the owner first, then a coding agent. Do not begin
implementation until the owner approves this plan (open questions: §9).

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
   swaps them for real credentials on the wire; a real credential never
   exists inside a session container, and a leaked placeholder is useless
   anywhere else.

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
- A credential can be added to a running session from the dashboard,
  usable within seconds, and detaching it revokes it at the proxy
  immediately.
- No real credential is ever written to a filesystem outside the SQLite
  database. The proxy holds secrets in memory only, received over an
  authenticated channel; it is secret-free at rest.
- Adding a tool to the session image costs at most the uniform CA-trust
  env vars already set image-wide — no per-tool auth plumbing.
- The repository keeps one toolchain (TypeScript, Vite, Vitest); no new
  language enters.
- Everything already true stays true: DNS-rebinding pinning, private-range
  blocking, fail-closed egress, `scripts/smoke-test.sh` green (extended, §8).

## 2. The approach (decided) and why

### 2.1 Interception over per-protocol gateways (settled)

Token injection needs plaintext; the two ways to get it are transparent
TLS interception (deployment-local CA) or per-protocol gateways/brokers
(base-URL overrides, credential helpers, wrapper scripts). The deciding
criterion is the marginal cost of the next tool: with interception it is
the CA-trust env vars already set once image-wide; with gateways it is a
bespoke hook per tool per credential, forever, and some tools have no hook
(`gh` already needed a wrapper). Interception's failure cases — cert-pinned
clients, odd gRPC — are handled by *not* intercepting them: only credential
hosts are ever MITMed, everything else stays an opaque tunnel the CA cannot
read. This is where the field landed too (Anthropic's production
containment, Infisical's agent-vault, coder/httpjail all intercept). The
per-protocol design (plan revision 2, in git history) is the documented
fallback if the M0 spike falsifies interception on our traffic.

Reference design, verified from Anthropic's engineering posts: sandboxes
hold scoped placeholder credentials; a proxy verifies the placeholder,
swaps in the real credential, enforces a domain allowlist, and rejects
requests to the API host not carrying the session's own token. Client-side
facts, verified: Claude Code honors `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`,
docs explicitly support TLS-inspection proxies, no certificate pinning; git
trusts a CA via `GIT_SSL_CAINFO`, gh via `SSL_CERT_FILE`, curl via
`CURL_CA_BUNDLE` — all env-deliverable, no root, no writable rootfs.

### 2.2 Engine: mockttp (TypeScript), not mitmproxy (Python)

Revisions 4–5 chose mitmproxy and paid for it twice: a second language in
the repo, and — because a Python addon cannot share the orchestrator's
memory — a `policy.json` file carrying real secrets on a shared volume.
Both costs were the owner's objections, and both dissolve if the engine is
JavaScript. It is: **mockttp** (`httptoolkit/mockttp`) is the HTTP engine
of HTTP Toolkit, a shipping product — a general-purpose programmable
TLS-intercepting proxy library, verified against primary sources:

| Requirement | mockttp | Verified |
|---|---|---|
| CA-based TLS termination, on-the-fly per-host leaf certs | `generateCACertificate()`; mints leaves per host | ✓ |
| Rewrite the credential header on an intercepted HTTPS request | `.thenPassThrough({ transformRequest: { updateHeaders: { authorization: … } } })`, plus `beforeRequest` callbacks for logic | ✓ |
| Selective passthrough (MITM injection hosts, tunnel the rest) | per-host rules + `tlsPassthrough`/`tlsInterceptOnly` server options | ✓ |
| HTTP/2 and SSE/streaming | `http2` option, tested; streams response bodies | ✓ |
| TypeScript, embeddable in a Node service | written in TS, first-class | ✓ |
| Maintained, adopted, permissive licence | v4.6.1, ~496k downloads/wk, last push 2026-08-26, **Apache-2.0** | ✓ |

It maps 1:1 onto what mitmproxy would have done (and onto Formal.ai's
public "hide secrets from Claude Code" mitmproxy addon), minus the Python.
Alternatives considered and rejected: `http-mitm-proxy` (MIT, works, but no
HTTP/2 and last release 2023 — kept as the fallback engine if mockttp
disappoints in M0); `proxy-chain` (CONNECT tunnelling only, cannot rewrite
HTTPS); `hoxy`/`anyproxy` (maintainer-declared stale / diminished);
hand-rolling with `node-forge` + `SNICallback` (a well-trodden pattern, but
several hundred lines re-implementing what mockttp gives us — only if a
zero-dependency posture ever outweighs that).

Risks specific to the engine, carried into M0: mockttp lowercases header
names on transform (RFC-compliant, virtually always fine — confirm the
Anthropic and GitHub APIs accept it); effectively a single-maintainer
project (mitigated by Apache-2.0 + heavy adoption); pin the major version
(the transform API was reworked across v2→v4). We embed the **`mockttp`
npm package (Apache-2.0)** only, never the AGPL HTTP Toolkit app/server.

### 2.3 No files between orchestrator and proxy

Because the proxy is now Node, the orchestrator↔proxy interface is an
**authenticated in-memory control channel**, not a shared file. The proxy
is a thin TypeScript service that embeds mockttp and holds *no state at
rest*: no database, no config file with secrets, no CA on disk. It boots
empty and receives its entire policy — allowlist, CA key+cert, and the
injection map (host, header kind, placeholder → real secret) — from the
orchestrator over the compose network, held in memory. Established pattern
(verified as standard): a small control endpoint the orchestrator pushes
to, authenticated by a shared bearer token (the same shape as
`WS_AUTH_TOKEN`), bound to the compose-network interface. Sessions live on
internal networks with no L3 route to that interface — the proxy bridges
them at L7, it does not route — so the control channel is unreachable from
a session even before the token check. On proxy restart the proxy has
nothing until the orchestrator re-pushes; the existing 60-second reconciler
already re-asserts proxy state and now re-pushes policy too, and every
credential change pushes immediately. Status flows back on the same
channel (applied-policy hash, denial tallies) — no file in either
direction.

## 3. Architecture after the change

```
┌────────────────────────── session network sn-<id> (internal) ─────────────┐
│  session container                                                        │
│    env: HTTPS_PROXY=http://proxy:3128                                     │
│         CLAUDE_CODE_OAUTH_TOKEN / GH_TOKEN = per-session placeholders     │
│         BOXES_PROXY_CA (PEM) → ~/.boxes/proxy-ca.crt via entrypoint;      │
│           NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / GIT_SSL_CAINFO /          │
│           CURL_CA_BUNDLE point at it                                      │
│    ~/.boxes/env — placeholders attached mid-session, sourced by shells    │
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
              │        orchestrator             │  owns ALL state + UI:
              │  SQLite (credentials, CA, attach)│  config.ts (boot creds) +
              │  REST + dashboard               │  DB (runtime creds);
              │  60 s reconciler re-pushes policy│  pushes on every change
              └─────────────────────────────────┘
```

- **Interception is the exception.** Only injection hosts — the Anthropic
  API, the GitHub trio, and the hosts of any dynamically added credential —
  are intercepted (`tlsInterceptOnly`); everything else allowed is
  `tlsPassthrough`, tunneled without decryption. Cert-pinned or
  interception-incompatible tools land on the passthrough side by default
  and simply carry no injected credential.
- **Placeholders are per-session, per-credential** random values shaped
  like the real tokens (`sk-ant-oat01-…` / `ghp_…` / opaque) so client-side
  format checks pass. The placeholder identifies session and credential at
  the proxy — no source-IP mapping — is matched in every arriving form
  (`Bearer`, `token`, `x-api-key`, git's Basic `x-access-token:<token>`
  decoded), is traceable when leaked, and dies the moment its attachment or
  its session is deleted (a policy push away).
- **The GitHub credential injected is the configured PAT** (owner decision:
  no short-lived App tokens). Keep the PAT narrow; per-session scoping and
  push rules remain available later at the same injection point (§10).
- **CA material** is generated once by the orchestrator via mockttp's
  `generateCACertificate()` and stored in the database. The orchestrator
  pushes the CA **key and cert** to the proxy in memory (the proxy needs
  the key to sign leaves) and hands the CA **cert** (public) to sessions as
  `BOXES_PROXY_CA`; the entrypoint writes the file the CA env vars point at.
  The CA key never touches a filesystem — generated in the orchestrator,
  persisted in SQLite, pushed into proxy memory.

## 4. The credential model — configuration, dashboard, dynamic attach

The orchestrator is the single stateful, dashboard-facing component; the
proxy is a stateless executor of a policy pushed into its memory. Nothing
secret is ever serialized to disk outside the database.

**A credential** is `{id, label, hosts[], headerKind, envVar, secret}` —
e.g. `{label: "npm publish", hosts: ["registry.npmjs.org"], headerKind:
"bearer", envVar: "NPM_TOKEN", secret: …}`. Two sources, same shape:

- **Boot credentials** from config.ts as today
  (`PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`, `PROFILE_DEFAULT_GH_TOKEN`
  plus their fixed host/header definitions), auto-attached to every session
  at create. These stay environment-only, as now.
- **Runtime credentials**, created and attached via REST/dashboard, stored
  in SQLite: a `credentials` table (secret included) and a
  `session_credentials` attachment table (session, credential, placeholder
  hash), so attach/detach is one transaction with no second store to keep
  in sync. This deliberately amends the "secrets stay out of the database"
  doctrine for owner-managed credentials — the DB file sits in the same
  0-permission volume a side file would, so a separate file added sync
  problems, not security. What the amendment costs is edge discipline, made
  explicit: the REST layer never serializes the `secret` column
  (write-only by construction, enforced by the row-shape types in
  `shared/types.ts`), `log.ts` redaction already covers credential-shaped
  values, and the README backup note says plainly that `boxes-data` now
  contains credentials.

**Attach** (create-time or mid-session) mints a placeholder for
(session, credential), updates the DB, pushes the new policy to the proxy,
and delivers the placeholder into the session:

- At container create: as env vars, as today.
- Mid-session: one `docker exec` appends `export <envVar>=<placeholder>`
  to `~/.boxes/env`, which the image's bash profile sources — every new
  shell, including `!bang` execs (`bash -lc`), sees it immediately. The
  ACP adapter reads env at its own spawn, so a credential meant for the
  adapter itself applies on its next respawn (session stop/start, or
  adapter exit) — a documented nuance; in practice dynamic credentials are
  for shell tools, and the two boot credentials ride the container env.

**Detach / delete** updates the DB, pushes policy (the placeholder is dead
at the proxy as soon as the push applies — effectively immediate), and
removes the line from `~/.boxes/env`. This is the kill switch: revocation
requires no container restart.

**REST** (same auth posture as the rest of `/api`; secrets are write-only,
never returned):

| Method and path | Does |
|---|---|
| `GET /api/credentials` | Library: id, label, hosts, headerKind, envVar — no secrets |
| `POST /api/credentials` | Create (validates hosts against the wildcard grammar) |
| `DELETE /api/credentials/:id` | Delete; detaches everywhere first |
| `POST /api/sessions/:id/credentials/:credId` | Attach to a session |
| `DELETE /api/sessions/:id/credentials/:credId` | Detach |

**Dashboard**: SessionInfo gains a Credentials card — attached credentials
(label, hosts, env var), attach-from-library, detach. A small library view
handles create/delete. `/healthz` (and a dashboard badge) compares the
proxy's applied-policy hash (from the control-channel status) with what the
orchestrator last pushed, so a stale or unreachable proxy is visible, not
silent.

## 5. Repository changes

The proxy stays a TypeScript package — **the one-toolchain rule holds, no
exception needed**. It gains mockttp and a control-channel server; the
Node stdlib forward-proxy source is replaced by mockttp-based interception.

```
proxy/
├── src/
│   ├── main.ts          # embeds mockttp; boots empty; serves the control
│   │                    #   channel; applies pushed policy; session-facing
│   │                    #   proxy on :3128
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
├── config.ts            # + EGRESS_ALLOWED_HOSTS ('' = off)
│                        # + EGRESS_TOKEN_TRANSLATION ('on'|'off')
│                        # + EGRESS_PROXY_CONTROL_URL / token (defaulted)
├── credentials.ts       # NEW: credential store — boot (env) + runtime
│                        #   (SQLite) merged behind one interface
├── ca.ts                # NEW: generate CA once (mockttp helper) + persist
│                        #   in SQLite; expose cert for BOXES_PROXY_CA
├── policy.ts            # NEW: compose policy from DB; push to proxy control
│                        #   channel; read status; placeholder minting
├── app.ts               # + the five credential routes (§4)
├── docker.ts            # sessionEnv: placeholders + BOXES_PROXY_CA + CA env
│                        #   vars when translation on; real tokens when off;
│                        #   exec helper for ~/.boxes/env
├── sessions.ts          # attach/detach orchestration; placeholder lifecycle
└── reaper.ts            # reconciler re-pushes policy, reads status into
│                        #   /healthz state
dashboard/src/views/     # SessionInfo credentials card; library view
session-image/entrypoint.sh  # writes $BOXES_PROXY_CA; creates ~/.boxes/env
                         #   and sources it from the bash profile
compose.yaml             # proxy unchanged as a service; no new volumes for
                         #   policy/CA (both now in memory / the DB)
shared/types.ts          # credential shapes; control-channel message shapes;
                         #   healthz policy-sync fields
scripts/smoke-test.sh    # extended, §8
README.md, ARCHITECTURE.md  # network/risks sections rewritten + CA-trust
                         #   troubleshooting table for future tools
db migration             # credentials table (secret write-only above the
                         #   store) + session_credentials attachments
                         #   (placeholder hashed) + ca_material (key+cert)
```

No new language, no new container, no shared secret file, no new base
image. mockttp is a library dependency of an existing package; the CA and
all secrets live in SQLite and in memory.

## 6. Milestones

### M0 — Spike: prove the swaps end to end (throwaway code allowed)
A minimal mockttp-based proxy plus one real session-image container with
placeholders. Acceptance, each demonstrated:
1. `claude-agent-acp` completes a turn with a placeholder
   `CLAUDE_CODE_OAUTH_TOKEN`, mockttp swapping the Bearer on
   `api.anthropic.com` (upstream: the real `setup-token` credential, with
   the `anthropic-beta` OAuth capability as needed). Establishes: no
   pinning in practice, placeholder shape accepted client-side, SSE
   streaming survives interception, header-name lowercasing accepted by
   the API.
2. `git clone`/`push` and `gh api user` / `gh pr list` with a placeholder
   `GH_TOKEN` (covers git's Basic form and gh's direct form), GitHub
   accepting the transformed headers.
3. **OAuth-refresh answered by observation**: does the adapter under a
   `setup-token` credential ever call `platform.claude.com` / `claude.ai`
   to refresh? If yes: passthrough-and-allowlist those hosts (refreshed
   token then lives in-session — documented residual) or intercept the
   refresh too. The plan's main unknown; the rest is assembly.
4. mockttp's per-host `tlsPassthrough` vs intercept confirmed on our
   traffic; resolved-IP pinning wired through mockttp's upstream
   connection (the `cidr.ts` vetting must sit on the actual upstream
   socket — verify mockttp exposes the hook, else pin via a custom agent).
5. Control-channel push + hot-swap of the injection map with no restart.
Fallback trigger: a structural mockttp failure on 1, 2, or 4 → retry with
`http-mitm-proxy` (accept no HTTP/2); a structural interception failure →
the per-protocol design (plan revision 2, git history). Re-plan at that
point.

### M1 — Orchestrator: store, CA, policy push
Config keys; migration; `credentials.ts` (boot + runtime, DB-backed);
`ca.ts` (generate + persist); `policy.ts` (compose + push + status);
placeholder mint/drop; the five REST routes; reconciler re-push. Unit
tests: mint uniqueness, policy composition, push ret/reauth, detach-revokes
in the pushed policy, status parsing. No behavior change to sessions yet.

### M2 — The engine swap
mockttp-based `proxy/src`; control-channel server; port `cidr.ts` vetting
onto the upstream socket with its full test table. Acceptance: the existing
smoke test passes unchanged with translation **off** and no allowlist — the
new engine must be behavior-compatible (plain forwarding, private-range and
port denials, DNS-rebinding pin) before it becomes policy-bearing.
Allowlist probes (§8.4–5) land here.

### M3 — Session wiring
`sessionEnv` emits placeholders + CA env vars when translation on (real
tokens when off); entrypoint writes the CA file and the `~/.boxes/env`
sourcing. Acceptance: live session completes a turn and pushes with
`EGRESS_TOKEN_TRANSLATION=on`; `docker exec env` contains no real
credential; nothing secret on any volume but the DB.

### M4 — Dynamic credentials in the dashboard
The SessionInfo card and library view over the M1 routes; mid-session
delivery via `~/.boxes/env`; detach as live revocation via policy push;
`/healthz` policy sync surfaced. Acceptance (stub e2e + one live check):
attach an `NPM_TOKEN`-style credential to a running session, `!curl` its
host authenticated within seconds, detach, same call rejected.

### M5 — The security gate
Smoke-test extensions (§8) green in all modes; README/ARCHITECTURE
rewritten (the env-token-leak risk moves from accepted to
mitigated-by-default); `live-test.sh` gains the translated turn. Owner
flips `EGRESS_TOKEN_TRANSLATION` default to `on` if M0–M4 gave no reason
not to.

## 7. Risks

- **OAuth refresh flow** (M0.3) — the one item that could reshape the
  Anthropic leg; contained by the two named handlings.
- **mockttp is a new, single-maintainer dependency in the TCB.** Mitigated:
  Apache-2.0 + ~496k downloads/wk + HTTP Toolkit production use, pinned
  major version, interception limited to injection hosts (all else
  passthrough), CA key only ever in the orchestrator/DB and proxy memory,
  and `http-mitm-proxy` as the M0 fallback engine.
- **Upstream-socket pinning through the library** (M0.4): the DNS-rebinding
  defense must act on mockttp's *actual* upstream connection, not a
  re-resolve. If mockttp doesn't expose the resolved address hook cleanly,
  pin via a custom `http(s).Agent`/lookup passed to its passthrough — a
  known pattern, but verify early; this is the one place the library could
  make the security-critical path awkward.
- **Control-channel exposure**: a secret-bearing endpoint on the proxy.
  Mitigated by binding to the compose-network interface (no session L3
  route), a bearer token, and the proxy holding policy only in memory. A
  compromised proxy still sees the credentials it injects — unchanged from
  any injecting-proxy design — but leaves nothing at rest to steal later.
- **A tool ignoring the CA env vars** fails TLS *only* against injection
  hosts — a confusing shape. Mitigation: README troubleshooting table
  (Anthropic's own agent-proxy README is the model; our env-var set matches
  theirs).
- **Mid-session delivery reaches shells, not the running adapter** —
  documented nuance (§4); the adapter's credentials ride container env.
- **Secrets in the database** (owner decision): a DB dump or a future
  debug/export endpoint could leak credentials. Mitigated by the write-only
  `secret` column above the store, existing log redaction, the README
  backup note, and the smoke test's secret-grep (§8.1) on the
  session-facing side.
- **Placeholder shape drift**: a client-side token format check tightening
  breaks placeholders loudly (auth error), not silently.
- **HTTP/2 + rewriting edge cases**: mockttp supports H2 and it is tested,
  but heavy H2 rewriting is less battle-tested than HTTP/1.1; M0.1 proves
  it on our exact upstreams.

## 8. Smoke-test additions (the acceptance definition)

From inside a throwaway session, allowlist `github.com,*.github.com,
*.githubusercontent.com,api.anthropic.com,registry.npmjs.org`, translation
on:

1. No real credential in `env`, `/proc/*/environ`, or the session volumes
   (host-side grep with the configured values).
2. `curl https://api.github.com/user` with the placeholder → 200 as the
   bot identity (proof of swap); with an invented token → 403 **from the
   proxy** (foreign credentials rejected, not forwarded).
3. Attach a runtime credential via the API, authenticated `curl` to its
   host succeeds from a new shell; detach; the same call → 403.
4. `https://example.com` → denied (allowlist); `https://1.1.1.1` → denied
   (unmatched literal); private ranges → denied (unchanged).
5. Allowlist unset: `example.com` reachable again; private ranges still
   denied.
6. Translation off: today's exact env and behavior (regression guard).
7. TLS to a passthrough host shows the host's real certificate chain; TLS
   to an injection host shows the deployment CA (interception is bounded).

## 9. Open questions for the owner

1. **Default posture once shipped**: `EGRESS_TOKEN_TRANSLATION` → `on` at
   M5 (recommended; `off` remains the escape hatch)?
2. **Allowlist granularity**: one deployment-wide list for v1 (this plan)?
   Per-session lists ride the same pushed policy trivially later.
3. Ship `.env.example` with the §8 working allowlist commented in?

## 10. Enabled later, out of scope now

- **Short-lived scoped GitHub credentials** (deferred by owner decision):
  the injection point makes them a policy push, zero sandbox-side change,
  if the PAT's blast radius ever bothers us.
- **Content-aware git policy** at the proxy (Anthropic's design): the
  injection point already sees decrypted git smart-HTTP; "pushes only to
  branch X" is a rule away.
- **Per-session allowlists and an egress audit view** in the dashboard
  (denials already log per placeholder = per session; status can carry
  tallies).
- **More profiles**: the credential model already carries them; profiles
  become named bundles of auto-attached credentials.
- **Encrypting the `secret` column at rest** (envelope key from the
  environment) if the DB-at-rest exposure ever needs closing beyond the
  volume's own permissions.
