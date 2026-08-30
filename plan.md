# Plan: Egress allowlist and token translation

Status: PROPOSED (revision 4). Owner decisions incorporated:
(2026-08-30 a) MITM is the way to go — selective TLS interception at the
egress proxy, chosen for the marginal cost of the next tool (§2).
(2026-08-30 b) **No time-limited GitHub tokens**: the proxy injects the
configured PAT; App-minted short-lived tokens move to future work (§10).
(2026-08-30 c) **Credentials must be dynamically attachable to sessions**,
managed from the dashboard, not only fixed at boot — this shapes the
credential model (§4) and the orchestrator↔proxy interface (§5).
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
- Adding a tool to the session image costs at most the uniform CA-trust
  env vars already set image-wide — no per-tool auth plumbing.
- Everything already true stays true: DNS-rebinding pinning, private-range
  blocking, fail-closed egress, `scripts/smoke-test.sh` green (extended, §8).

## 2. The approach (decided) and why

Token injection needs plaintext; the two ways to get it are transparent
TLS interception (deployment-local CA) or per-protocol gateways/brokers
(base-URL overrides, credential helpers, wrapper scripts). The deciding
criterion is the marginal cost of the next tool: with interception it is
the CA-trust env vars already set once image-wide; with gateways it is a
bespoke hook per tool per credential, forever, and some tools have no hook
(`gh` already needed a wrapper). Interception's failure cases —
cert-pinned clients, odd gRPC — are handled by *not* intercepting them:
only credential hosts are ever MITMed, everything else stays an opaque
tunnel the CA cannot read. This is also where the field landed: Anthropic's
production containment, Infisical's agent-vault, and coder/httpjail all
intercept; the no-MITM projects are all per-protocol. The per-protocol
design (revision 2 of this plan, in git history) remains the documented
fallback if the M0 spike falsifies interception on our traffic.

**Engine: adopt mitmproxy, don't build.** TLS interception is mature,
audited ground in mitmproxy (MIT, v12, official Docker image, the
most-scrutinized tool in this niche) and treacherous to reimplement — Node
cannot even mint certificates without a new crypto dependency, at which
point we would be building a worse mitmproxy. **mitmproxy is written in
Python** (core Python, some Rust internals); its addon API is Python, so
our policy lives in one Python file. That is the toolchain cost of the
mature engine, § 5 confines it. The one candidate that could replace both
engine and addon, Infisical agent-vault (a purpose-built MITM credential
proxy for AI agents), gets a time-boxed M0 look; it is a months-old
research preview carrying a vault stack, so mitmproxy is the default.
Rejected en route: Squid (`request_header_add` removed in v8), Envoy
(cannot MITM inside CONNECT), google/martian (archived), smokescreen
(allowlist only), tokenizer/LiteLLM/secretless (per-protocol; LiteLLM
additionally cannot hold a subscription OAuth token upstream),
sandbox-runtime (proxy not packaged standalone, injection experimental).

Reference design, verified from Anthropic's engineering posts: sandboxes
hold scoped placeholder credentials; a proxy outside verifies the
placeholder, swaps in the real credential, enforces a domain allowlist,
and rejects requests to the API host that don't carry the session's own
token. Client-side facts, verified: Claude Code honors `HTTPS_PROXY` and
`NODE_EXTRA_CA_CERTS`, docs explicitly support TLS-inspection proxies, no
certificate pinning; git trusts a CA via `GIT_SSL_CAINFO`, gh via
`SSL_CERT_FILE`, curl via `CURL_CA_BUNDLE` — all env-deliverable.

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
                               │ CONNECT host:443
              ┌────────────────▼────────────────┐
              │  egress proxy = mitmdump        │
              │  + boxes_policy.py addon        │
              │   (stateless policy executor)   │
              │                                 │
              │  1 allowlist check (optional)   │──── deny, logged
              │  2 resolve + vet all answers,   │
              │    pin upstream to vetted addr  │──── deny (rebinding, private)
              │  3 injection host?              │
              │     no  → opaque tunnel         │──── TLS passthrough
              │     yes → intercept TLS:        │
              │       placeholder → real cred   │
              │       anything else → deny      │
              └──────┬───────▲──────────┬───────┘
                     │       │          │
            internet ▼       │          ▼ status.json (proxy rw, orch ro):
                             │            applied policy hash, denial tallies
              policy.json (orch rw, proxy ro):
              allowlist + injection map (hosts, header kind,
              placeholder → real secret)
                             │
                      orchestrator — owns ALL state and UI:
                      config.ts (boot env) + credential store (runtime)
                      → composes policy.json; REST + dashboard on top;
                      60 s reconciler re-asserts policy and reads status
```

- **Interception is the exception.** Only injection hosts — the Anthropic
  API, the GitHub trio, and the hosts of any dynamically added credential —
  are MITMed. Cert-pinned or otherwise incompatible tools land on the
  passthrough side by default and simply carry no injected credential.
- **Placeholders are per-session, per-credential** random values shaped
  like the real tokens (`sk-ant-oat01-…` / `ghp_…` / opaque) so client-side
  format checks pass. The placeholder identifies session and credential at
  the proxy — no source-IP mapping — is matched in every arriving form
  (`Bearer`, `token`, `x-api-key`, and git's Basic `x-access-token:<token>`,
  decoded), is traceable when leaked, and dies the moment its attachment or
  its session is deleted.
- **The GitHub credential injected is the configured PAT** (owner decision:
  no short-lived App tokens). Keep the PAT narrow; per-session scoping and
  push rules remain available later at the same injection point (§10).
- **CA material**: mitmproxy generates its CA into a confdir volume only
  the proxy mounts. The orchestrator reads the *certificate*
  (`mitmproxy-ca-cert.pem`; the key never leaves that volume) and hands it
  to sessions as `BOXES_PROXY_CA`; the entrypoint writes the file the CA
  env vars point at. Public material only.

## 4. The credential model — configuration, dashboard, dynamic attach

The orchestrator is the single stateful, dashboard-facing component; the
Python addon is a stateless executor of a file it cannot write. All
interaction between the TS world and the proxy is two JSON files on two
small volumes — no RPC, no shared database, no Python touching state.

**A credential** is `{id, label, hosts[], headerKind, envVar, secret}` —
e.g. `{label: "npm publish", hosts: ["registry.npmjs.org"], headerKind:
"bearer", envVar: "NPM_TOKEN", secret: …}`. Two sources, same shape:

- **Boot credentials** from config.ts as today
  (`PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`, `PROFILE_DEFAULT_GH_TOKEN`
  plus their fixed host/header definitions), auto-attached to every
  session at create.
- **Runtime credentials**, created and attached via REST/dashboard, stored
  in `DATA_DIR/credentials.json` (0600) — the database stays secret-free
  per doctrine, same pattern as the generated WS token. Survives restarts.

**Attach** (create-time or mid-session) mints a placeholder for
(session, credential), rewrites `policy.json`, and delivers the
placeholder into the session:

- At container create: as env vars, as today.
- Mid-session: one `docker exec` appends `export <envVar>=<placeholder>`
  to `~/.boxes/env`, which the image's bash profile sources — every new
  shell, including `!bang` execs (`bash -lc`), sees it immediately. The
  ACP adapter reads env at its own spawn, so a credential meant for the
  adapter itself applies on its next respawn (session stop/start, or
  adapter exit) — a documented nuance; in practice dynamic credentials are
  for shell tools, and the two boot credentials ride the container env.

**Detach / delete** rewrites `policy.json` (the placeholder is dead at the
proxy within its reload latency — the addon stat()s the file per request,
so effectively immediate) and removes the line from `~/.boxes/env`. This
is the kill switch: revocation requires no container restart.

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
handles create/delete. `/healthz` (and a dashboard badge) reports whether
the proxy's applied policy hash in `status.json` matches what the
orchestrator last wrote, so a stale proxy is visible, not silent.

**The addon side of the contract** (`policy.json`, versioned schema):
allowlist patterns, and an injection table of
`{hosts[], headerKind, placeholder, secret}`. Hosts appearing in the
injection table are implied allowlist members and implied interception
targets. The addon holds no other state and makes no decisions the file
doesn't spell.

## 5. Repository changes

```
proxy/
├── boxes_policy.py          # NEW: the addon — allowlist, vetting+pinning,
│                            #   selective interception, placeholder swap,
│                            #   policy reload, status.json writer.
│                            #   Policy logic in pure functions
├── policy_test.py           # NEW: pytest over the pure functions (allowlist
│                            #   grammar, CIDR vetting, credential parsing,
│                            #   policy-file validation incl. rejects)
├── Dockerfile               # REWRITTEN: FROM mitmproxy/mitmproxy:<pin>,
│                            #   pytest stage gates the build, runs mitmdump
└── src/, vite.config.ts, package.json   # DELETED with the Node proxy
                             #   (cidr.ts logic and tests port to the addon)
orchestrator/src/
├── config.ts                # + EGRESS_ALLOWED_HOSTS ('' = off)
│                            # + EGRESS_TOKEN_TRANSLATION ('on'|'off')
├── credentials.ts           # NEW: the credential store — boot + runtime
│                            #   merged; DATA_DIR/credentials.json (0600)
├── policy.ts                # NEW: placeholder minting; atomic policy.json
│                            #   writer; status.json reader; CA cert reader
├── app.ts                   # + the five credential routes (§4)
├── docker.ts                # sessionEnv: placeholders + BOXES_PROXY_CA + CA
│                            #   env vars when translation on; real tokens
│                            #   only when off; exec helper for ~/.boxes/env
├── sessions.ts              # attach/detach orchestration; placeholder
│                            #   lifecycle on create/delete
└── reaper.ts                # reconciler re-asserts policy.json, reads
│                            #   status.json into /healthz state
dashboard/src/views/         # SessionInfo credentials card; library view
session-image/entrypoint.sh  # writes $BOXES_PROXY_CA; creates ~/.boxes/env
                             #   and sources it from the bash profile
compose.yaml                 # proxy image; volumes: boxes-egress-policy
                             #   (orch rw / proxy ro), boxes-proxy-status
                             #   (proxy rw / orch ro), boxes-proxy-ca
                             #   (proxy rw / orch ro)
shared/types.ts              # credential shapes; healthz policy-sync fields
scripts/smoke-test.sh        # extended, §8
README.md, ARCHITECTURE.md   # network/risks sections rewritten + CA-trust
                             #   troubleshooting table for future tools
db migration                 # per-session placeholder bookkeeping (hashed;
                             #   plaintext only in policy.json)
```

**Where Python is and is not.** Python exists only inside `proxy/`: one
addon file and its tests, riding the engine's own runtime — no Python in
the build of any other package, no Python reading the database, serving
HTTP to browsers, or holding state. The interface is `policy.json` in and
`status.json` out. The one-toolchain rule (Vite/Vitest) takes its first
deliberate exception there, gated the same way: pytest runs in the proxy's
Docker build stage exactly as `tsc && vitest` gate the TS images. The
alternative — chaining a Node policy proxy in front of mitmproxy — buys
toolchain purity with an extra hop and two homes for egress bugs, and is
rejected.

## 6. Milestones

### M0 — Spike: prove the swaps end to end (throwaway code allowed)
mitmdump + hand-written addon on the developer host; one real session-image
container with placeholders. Acceptance, each demonstrated:
1. `claude-agent-acp` completes a turn with a placeholder
   `CLAUDE_CODE_OAUTH_TOKEN`, the addon swapping the Bearer on
   `api.anthropic.com` (upstream: the real `setup-token` credential, with
   the `anthropic-beta` OAuth capability as needed). Establishes: no
   pinning in practice, placeholder shape accepted client-side, SSE
   streaming unaffected.
2. `git clone`/`push` and `gh api user` / `gh pr list` with a placeholder
   `GH_TOKEN` (covers git's Basic form and gh's direct form).
3. **OAuth-refresh answered by observation**: does the adapter under a
   `setup-token` credential ever call `platform.claude.com` / `claude.ai`
   to refresh? If yes: passthrough-and-allowlist those hosts (refreshed
   token then lives in-session — documented residual) or intercept the
   refresh too. The plan's main unknown; the rest is assembly.
4. `server_connect` address-overwrite pinning confirmed on current
   mitmproxy; policy hot-reload latency measured.
5. Time-boxed (half a day): Infisical agent-vault against scenarios 1–2 —
   flag for the owner only if it clearly beats the addon path.
Fallback trigger: a structural failure of 1 or 2 → the per-protocol design
(plan revision 2, git history) is the fallback; re-plan at that point.

### M1 — Orchestrator: config, credential store, policy plumbing
Config keys; migration; `credentials.ts` (boot + runtime, file-backed);
placeholder mint/drop; `policy.ts` writer + status reader; reconciler
assertions; the five REST routes. Unit tests: mint uniqueness, atomic
write, file shapes, detach-revokes, reconciler re-write after deletion.
No behavior change yet (nothing consumes the files).

### M2 — The engine swap
New `proxy/Dockerfile` + `boxes_policy.py` + pytest stage; port `cidr.ts`
vetting with its full test table; compose volumes; delete the Node proxy.
Acceptance: the existing smoke test passes unchanged with translation
**off** and no allowlist — the new engine must be behavior-compatible
before it becomes policy-bearing. Allowlist probes (§8.4–5) land here.

### M3 — Session wiring
`sessionEnv` emits placeholders + CA env vars when translation on (real
tokens when off); entrypoint writes the CA file and the `~/.boxes/env`
sourcing. Acceptance: live session completes a turn and pushes with
`EGRESS_TOKEN_TRANSLATION=on`; `docker exec env` contains no real
credential.

### M4 — Dynamic credentials in the dashboard
The SessionInfo card and library view over the M1 routes; mid-session
delivery via `~/.boxes/env`; detach as live revocation; `/healthz` policy
sync surfaced. Acceptance (stub e2e + one live check): attach an
`NPM_TOKEN`-style credential to a running session, `!curl` its host
authenticated within seconds, detach, same call rejected.

### M5 — The security gate
Smoke-test extensions (§8) green in all modes; README/ARCHITECTURE
rewritten (the env-token-leak risk moves from accepted to
mitigated-by-default); `live-test.sh` gains the translated turn. Owner
flips `EGRESS_TOKEN_TRANSLATION` default to `on` if M0–M4 gave no reason
not to.

## 7. Risks

- **OAuth refresh flow** (M0.3) — the one item that could reshape the
  Anthropic leg; contained by the two named handlings.
- **mitmproxy is a large new TCB member.** Mitigated: pinned image,
  interception limited to injection hosts (all else opaque), CA key never
  leaves its volume, addon never logs credential values, policy volume
  read-only to it.
- **A tool ignoring the CA env vars** fails TLS *only* against injection
  hosts — a confusing shape. Mitigation: README troubleshooting table
  (Anthropic's own agent-proxy README is the model; our env-var set
  matches theirs).
- **Mid-session delivery reaches shells, not the running adapter** —
  documented nuance (§4); the adapter's own credentials ride container
  env from create.
- **Placeholder shape drift**: a client-side token format check tightening
  breaks placeholders loudly (auth error), not silently.
- **PAT blast radius** (owner-accepted): the injected GitHub credential is
  as broad as the PAT; it never enters sessions, and narrowing it stays a
  GitHub-side setting. Scoped short-lived tokens remain available later
  (§10) with no sandbox-side change.
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
2. **Runtime credential persistence**: `DATA_DIR/credentials.json` (0600,
   doctrine-conform, recommended) is assumed — veto if you'd rather they
   be session-lifetime only and vanish on orchestrator restart.
3. **Allowlist granularity**: one deployment-wide list for v1 (this plan)?
   Per-session lists ride the same policy.json trivially later.
4. Ship `.env.example` with the §8 working allowlist commented in?

## 10. Enabled later, out of scope now

- **Short-lived scoped GitHub credentials** (deferred by owner decision):
  the injection point makes them a policy.json refresh, zero sandbox-side
  change, if the PAT's blast radius ever bothers us.
- **Content-aware git policy** at the proxy (Anthropic's design): the
  injection point already sees decrypted git smart-HTTP; "pushes only to
  branch X" is an addon rule away.
- **Per-session allowlists and an egress audit view** in the dashboard
  (denials already log per placeholder = per session; status.json can
  carry tallies).
- **More profiles**: the credential model already carries them; profiles
  become named bundles of auto-attached credentials.
