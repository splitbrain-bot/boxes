# Build Plan: Replace acp-ui with an in-dashboard thread view (assistant-ui)

Status: PROPOSED (revision 1). Owner decision on 2026-08-30: the frontend is
assistant-ui (React), embedded in our own dashboard; the standalone acp-ui
app goes away. Every fact in §2 was verified by installing the packages and
reading the shipped type declarations and registry payloads on 2026-08-30;
pin the versions named there. Audience: a coding agent. Follow milestones in
order. Do not begin implementation until the owner approves this plan.

---

## 1. Why, and what must be true afterwards

acp-ui is a separate application with its own session management and its own
UX, and we can only influence it upstream. The concrete failures that forced
this decision, each of which must be demonstrably fixed by this plan:

| # | Complaint | Mechanism that fixes it (details in §6) |
|---|-----------|------------------------------------------|
| 1 | acp-ui's session panel duplicates our dashboard | The thread view lives *inside* the dashboard at `/sessions/:id`; there is no second app and no second session list |
| 2 | No ArrowUp to recall previous messages | `unstable_useComposerInputHistory()` — an upstream hook with exactly terminal semantics, spread onto the composer input |
| 3 | Input loses focus after each send | We own the vendored composer; autofocus on mount and refocus after send are asserted by the e2e test |
| 4 | `!bang` local commands don't work | First-party feature: composer text starting with `!` runs in the session container via a new exec endpoint, never touching the model |
| 5 | Can't see output of commands | Tool-call parts render name, args, status and output through the vendored tool components; `!bang` output rides the same rendering path |
| 6 | No way to switch into auto mode | Header mode switcher driven by the session's advertised modes → `session/set_mode`; live via `current_mode_update` |

What stays: the orchestrator, the ACP gateway (browser-facing WS protocol
unchanged — external ACP clients keep working), the egress proxy, the session
image, container lifecycle, reaper, both test scripts.

What goes: the acp-ui build stage, the `/ui` route, `dashboard/src/acpui.ts`
and its tests, the localStorage-seeding connect flow. Connecting becomes SPA
navigation.

## 2. Verified facts (source-inspected 2026-08-30; pin these versions)

**`@assistant-ui/react` 0.15.17** (published within the last day; actively
maintained; peer deps `react ^18 || ^19`).

- `useExternalStoreRuntime<T>(store: ExternalStoreAdapter<T>)` is exported
  from the package root and mounts via `<AssistantRuntimeProvider>`. It lives
  under a `legacy-runtime/` path internally but is the supported
  external-state entry point; its successor (`ExternalThread` from
  `@assistant-ui/core/store`) has the same shape. If a later upgrade removes
  the hook, the migration is mechanical.
- `ExternalStoreAdapter` carries everything we need, verified field by field:
  `messages` + `convertMessage` (to `ThreadMessageLike`), `isRunning`,
  `isSendDisabled`, `onNew`, `onCancel`, `onRefetchThread`, and
  **`onRespondToToolApproval(options: RespondToToolApprovalOptions)`**.
  A `queue?: ExternalThreadQueueAdapter` field exists for prompt queueing —
  not used in v1, but the upgrade path for the adapter's promptQueueing/
  steering `_meta` extensions is already present upstream.
- **Tool approval is first-class and maps 1:1 onto ACP.** A
  `ToolCallMessagePart` may carry
  `approval: { id, options?: ToolApprovalOption[], approved?, optionId?, resolution? }`;
  `ToolApprovalOptionKind` is `"allow-once" | "allow-always" | "reject-once"
  | "reject-always"` — ACP's `allow_once` etc. with hyphens; ACP's
  `optionId`/`name` map to `id`/`label`. `ToolApprovalResponse` returns
  `{ optionId }`, which converts directly to ACP's
  `{ outcome: { outcome: "selected", optionId } }`.
- `unstable_useComposerInputHistory()` returns `{ onKeyDown }` to spread on
  `ComposerPrimitive.Input`: ArrowUp on an empty draft recalls previously
  sent user messages, ArrowDown steps back and restores the draft; yields to
  IME, popovers, multi-line caret movement. Documented as unstable → pin the
  exact package version; if it changes, the behavior is ~40 lines to inline
  in a file we own.

**Styled components** come from a shadcn-format registry, vendored into the
repo as source files we own:

- `https://r.assistant-ui.com/base/<name>.json` (the CLI shells out to
  `shadcn add` with these URLs; we can fetch the JSON and write the files
  directly, avoiding the interactive CLI). `thread.json` declares deps
  `@assistant-ui/react`, `lucide-react` and registry deps: shadcn `button`,
  `skeleton`, plus `attachment`, `file`, `follow-up-suggestions`, `image`,
  `markdown-text`, `reasoning`, `tooltip-icon-button`, `tool-fallback`,
  `tool-group`, and (via markdown-text) `use-copy-to-clipboard`.
- The vendored sources use **both** semantic `aui-*` classes **and** Tailwind
  utility classes. `@assistant-ui/styles` 0.3.7 ships precompiled CSS for the
  147 `aui-*` classes **only** — verified: zero utility classes in it. So the
  registry components require Tailwind; the styles package supplies the
  `aui-*` layer on top.
- Tailwind v4 needs no PostCSS/Vite: `@tailwindcss/cli` 4.3.3 is a standalone
  binary (`tailwindcss -i src/globals.css -o dist/main.css`) with automatic
  content detection. The dashboard build becomes two commands (tailwind for
  CSS, esbuild for JS), still no bundler framework. The owner accepted the
  Tailwind adoption when choosing assistant-ui.
- Markdown: `@assistant-ui/react-markdown` 0.14.13 (peer `^0.15` of react
  pkg; wraps `react-markdown`) + `remark-gfm`, used by the vendored
  `markdown-text` component.

**Current gateway behavior this plan builds on** (from the code as of
`b5618b2`): the downstream answers `initialize` from the cached upstream
response; answers `session/new` with the bare `{ sessionId }` when a thread
already exists (a fresh creation passes the full upstream response through,
which includes the adapter's advertised modes); forwards `session/load`,
`session/prompt`, `session/set_mode`, `session/cancel` etc. verbatim;
broadcasts every upstream `session/update` to all attached browsers; flushes
queued permission requests to a newly attached browser; WS auth is the
`bearer.<token>` subprotocol, token available to the dashboard from
`GET /api/sessions` (same origin, behind the deployment's auth).

## 3. Architecture after the change

```
Browser ──────────────────────────────────────────────────────────────
  React SPA (one app, one origin, served by the orchestrator at /)
  ├── session list / create / info views      (ported from Preact)
  └── /sessions/:id  = THREAD VIEW
      ├── vendored assistant-ui components    (ours to edit)
      ├── useExternalStoreRuntime(adapter)
      ├── thread store  ← translate(session/update*)   [replay + live]
      ├── AcpClient      ⇄ /ws/sessions/:id/acp        [unchanged protocol]
      └── !bang runner   ⇄ POST /api/sessions/:id/exec [new]
──────────────────────────────────────────────────────────────────────
  Orchestrator: gateway unchanged on the wire, plus two quality fixes (§7.3);
  new exec endpoint (§7.4). Everything below the gateway untouched.
```

One thread per session remains the model. assistant-ui's thread-list
machinery is not used; our session list is the thread list.

## 4. Tech stack changes

| Concern | Was | Becomes |
|---|---|---|
| UI library | Preact + preact-iso + @preact/signals | React 19 + wouter (2 kB router) + `useSyncExternalStore` stores |
| Chat UI | acp-ui (separate app) | vendored assistant-ui registry components (base flavor) |
| Chat runtime | — | `useExternalStoreRuntime` over our ACP client |
| Markdown | (acp-ui's) | `@assistant-ui/react-markdown` + `remark-gfm` |
| CSS | plain per-component CSS | same for dashboard views; + Tailwind v4 (`@tailwindcss/cli`) + `@assistant-ui/styles` for the thread |
| Build | esbuild only | esbuild (JS) + tailwind CLI (CSS); `tsc --noEmit` still gates both in Docker |

Pins: `@assistant-ui/react@0.15.17`, `@assistant-ui/react-markdown@0.14.13`,
`@assistant-ui/styles@0.3.7`, `@tailwindcss/cli@4.3.3`, `react@^19`,
`wouter` latest at implementation time. Registry components are pinned by
being committed; upgrades are a re-vendor with a reviewable diff.

## 5. Repository changes

```
dashboard/src/
├── main.tsx                    # React mount + wouter routes
├── globals.css                 # tailwind import + @assistant-ui/styles +
│                               #   theme-token bridge to our palette
├── stores/
│   ├── sessions.ts             # list polling (useSyncExternalStore port of store.ts)
│   └── thread/
│       ├── acp-client.ts       # JSON-RPC over WS: initialize/new/load/prompt/
│       │                       #   cancel/set_mode; answers request_permission;
│       │                       #   reconnect with backoff; $/ping-free
│       ├── translate.ts        # ACP session/update* → our message model (pure)
│       ├── thread-store.ts     # message list, isRunning, modes, pending
│       │                       #   approvals, exec records; subscribe API
│       └── thread-store.test.ts
├── views/
│   ├── SessionList.tsx/.css    # ported; card tap → /sessions/:id
│   ├── SessionCreate.tsx/.css  # ported
│   ├── SessionThread.tsx/.css  # NEW: runtime wiring + header (badges, mode
│   │                           #   switcher, link to info)
│   └── SessionInfo.tsx/.css    # ops from old SessionDetail (stop/delete/
│                               #   volumes/network/proxy warning) + external-
│                               #   client connect info (wss URL + token)
├── components/
│   ├── assistant-ui/…          # vendored registry sources (thread, markdown-
│   │                           #   text, tool-fallback, tool-group, reasoning,
│   │                           #   tooltip-icon-button, attachment, …)
│   ├── ui/…                    # vendored shadcn button, skeleton, lib/utils
│   └── (existing dashboard components ported)
DELETED: dashboard/src/acpui.ts, acpui.test.ts, store.ts (replaced),
         SessionDetail.* (split into SessionThread/SessionInfo),
         orchestrator Dockerfile acpui-build stage, /ui serving in index.ts.
orchestrator/src/exec.ts        # NEW: container exec runner (§7.4)
shared/types.ts                 # + ExecRequest/ExecRecord shapes
```

## 6. UX requirements, precisely

1. **Session management** — the dashboard's list is the only session UI.
   Tapping a card opens the thread directly. Ops move to `/sessions/:id/info`.
2. **ArrowUp history** — `unstable_useComposerInputHistory()` spread onto the
   vendored `ComposerPrimitive.Input`. e2e-asserted.
3. **Focus** — composer autofocuses on thread mount and after every send,
   including sends resolved by error; asserted in e2e (send → `document.activeElement`
   is the input). If the vendored composer doesn't already do it, we add it
   there — it is our file.
4. **`!bang` commands** — composer text starting with `!` is intercepted in
   `onNew` (never sent to the adapter, costs no tokens): `POST
   /api/sessions/:id/exec` streams combined stdout+stderr; rendered as a
   tool-call part `toolName: "shell"` with args `{command}` and streaming
   result, so it gets the same collapsible output UI as agent tool calls.
   History persists server-side (§7.4) and is appended after replay on
   reload, ordered by time (interleaving into the replayed transcript is not
   attempted — ACP replay carries no timestamps; documented limitation).
5. **Command/tool output** — ACP `tool_call` / `tool_call_update` params
   (title, kind, status, content including terminal output, locations) map
   onto tool-call parts; the vendored `tool-fallback` renders args and
   results collapsibly, and we extend it (our file) to render ACP content
   blocks and diffs. Streaming `content` deltas update `result` live.
6. **Mode switching** — modes come from the full `session/new` response
   (fresh thread) or the `session/load` response (existing); tracked via
   `current_mode_update` notifications; a header segmented control issues
   `session/set_mode`. Whatever the adapter advertises (e.g. default /
   acceptEdits / bypassPermissions) appears without hardcoding.

Permission prompts (not on the complaint list but load-bearing): incoming
`session/request_permission` attaches `approval` (options mapped per §2) to
the matching tool-call part; the user's choice resolves the JSON-RPC request
via `onRespondToToolApproval`. Queued requests flushed on attach take the
same path. A request cancelled upstream sets `resolution: "cancelled"`.

## 7. Component specifications

### 7.1 AcpClient (browser)
Connects to `wss(s)://<origin>/ws/sessions/:id/acp` offering
`['acp.v1', 'bearer.<token>']` (token from the sessions API; URL derived
from `location`, never configured). JSON-RPC 2.0, one message per text
frame; no `$/ping` (that was acp-ui's habit, not the protocol's).
Handshake: `initialize` → `session/new` → if the response carries no
`modes`, treat as existing thread and `session/load` (replay arrives as
`session/update` notifications). Handles server→client requests
(`session/request_permission`) by delegating to the thread store and
responding with its resolution. Reconnects with capped backoff on close;
on reconnect, repeats the handshake (fresh replay rebuilds the store).
Surfaces connection state for the header.

### 7.2 translate.ts + thread-store.ts
Pure translation of ACP updates into an append-only message model:

| ACP `session/update` kind | Store effect |
|---|---|
| `user_message_chunk` | append/extend current user message text |
| `agent_message_chunk` | append/extend assistant text part |
| `agent_thought_chunk` | append/extend reasoning part |
| `tool_call` | new tool-call part (id, name/title, kind, status, args) |
| `tool_call_update` | merge status/content/result into that part |
| `plan` | replace plan state (rendered in header or as a part) |
| `current_mode_update` | update modes state |
| unknown kinds | keep raw, log, render nothing (forward-compat) |

`convertMessage` maps this model to `ThreadMessageLike`. Exec records
convert to assistant messages with a `shell` tool-call part. `isRunning`
tracks prompt in flight (set on send, cleared on `session/prompt` response
or cancel). The store is framework-free and fully unit-tested — including
approval attachment/resolution, replay rebuild, and out-of-order
`tool_call_update`.

### 7.3 Gateway additions (small, wire-compatible)
a) **Prompt echo**: when forwarding `session/prompt` from downstream X,
   synthesize `user_message_chunk` update(s) to the *other* downstreams so a
   second device sees the prompt live (today it only appears after its next
   replay). No change for single-device use; external clients unaffected.
b) **Replay routing**: while a `session/load` forwarded for downstream X is
   in flight, deliver `session/update` notifications only to X. Prevents
   another browser's reattach from duplicating the full history into every
   open tab. (Replay is by definition a re-send of history.) Unit-tested
   with two fake downstreams.

### 7.4 Exec endpoint (orchestrator)
`POST /api/sessions/:id/exec {command}` → runs `bash -lc <command>` as
`agent` in `/workspace/repo` (fallback `/workspace`) via the existing
dockerode exec plumbing; streams combined output as chunked
`text/plain` (client reads via fetch body reader); hard limits: 120 s
wall clock, 256 KiB output, then the exec is killed and the response marked
truncated/timed out. Exit code in a trailer line. On completion the record
(command, output, exit code, timestamps) is inserted into a new `exec_log`
table (migration 2); `GET /api/sessions/:id/exec` lists records for
post-replay rendering. Same session-id validation and auth posture as the
rest of `/api`. The command runs inside the session's existing isolation
(internal network, read-only rootfs, caps dropped) — no new privilege is
introduced, and the endpoint never shell-executes on the host.

### 7.5 Theme bridge (globals.css)
`@import "tailwindcss"` + `@import "@assistant-ui/styles/index.css"` +
a token block defining the shadcn-convention variables (`--background`,
`--primary`, …) from our existing palette in both schemes, so vendored
components and dashboard views share one look. Tailwind preflight lands
before our per-component CSS; the dashboard's element-level `button`/`input`
rules move into explicit classes so preflight and dashboard styles cannot
fight over bare elements.

## 8. Milestones

### M1 — React migration (no assistant-ui yet)
Swap Preact→React 19, preact-iso→wouter, signals→`useSyncExternalStore`
store; port list/create views and components; split SessionDetail into a
placeholder thread route + SessionInfo. Acceptance: `npm run check` and unit
tests green; Chromium screenshots of list/create/info match the current UI;
card tap navigates to `/sessions/:id`.

### M2 — Toolchain + vendored components
Add tailwind CLI build step; vendor the registry components + shadcn
button/skeleton/utils; write globals.css theme bridge. Acceptance: a
playground route rendering the vendored Thread over a canned in-memory
external store shows fully styled composer, user/assistant messages,
markdown, reasoning, and a tool call — light and dark screenshots, no
unstyled elements, no console errors.

### M3 — Live thread: client, store, runtime
AcpClient + translate + thread-store + runtime wiring; replay on attach;
streaming; cancel. Acceptance (e2e against a stub ACP gateway — a Node WS
server speaking the agent side with canned scripts): send → streamed
markdown reply renders progressively; reload mid-conversation → full thread
reappears via replay; a second tab receives live updates; cancel stops the
run state.

### M4 — The six UX items + permissions
Everything in §6. Acceptance, each asserted in the stub e2e: ArrowUp recalls
the previous prompt into the composer; after send the input is focused;
`!echo hi` renders a shell tool call with output `hi` (stub exec endpoint)
and never reaches the stub agent; a tool call with streamed output shows it
collapsibly; a `session/request_permission` renders options, clicking
answers the JSON-RPC request, and a queued one is delivered on attach; the
mode switcher lists stub-advertised modes and emits `session/set_mode`, and
a `current_mode_update` moves the control.

### M5 — Gateway refinements + exec endpoint (server side)
§7.3 a+b with unit tests over two fake downstreams; §7.4 endpoint + migration
+ limits tests (timeout, truncation, exit code, missing container). Acceptance:
orchestrator suite green; e2e now exercises real exec streaming end-to-end
against a live orchestrator process with a stubbed docker layer.

### M6 — Removal, integration, docs
Delete acp-ui stage/route/files and the localStorage connect flow; Dockerfile
dashboard stage = `tsc --noEmit` + tailwind + esbuild; update
ARCHITECTURE.md (frontend section rewritten) and README (connect = open the
session; external-ACP-client instructions move to SessionInfo/README
appendix); verify scripts/live-test.sh still passes unchanged (it drives the
WS directly). Acceptance: full test matrix green
(orchestrator/dashboard/proxy unit + stub e2e); `docker compose config`
valid; repo contains no reference to acp-ui outside ARCHITECTURE.md history
notes.

Out of scope for v1 (explicitly): attachments/images, message branching &
edit-resend, prompt queueing/steering UI (upstream `queue` adapter exists —
natural M7), syntax highlighting in code blocks (add-on package later),
multi-thread-per-session.

## 9. Risks

- **The one unverifiable-here integration** remains the live adapter: modes
  payload shape and replay behavior against real `claude-agent-acp` need one
  session on the owner's host after M4 (same caveat as the original plan's
  M1). The stub gateway encodes the ACP v1 schema, so drift shows up as a
  concrete diff, not a mystery.
- `unstable_useComposerInputHistory` may change signature — pinned version;
  fallback is inlining the behavior into the vendored composer (~40 lines).
- `useExternalStoreRuntime` is in a `legacy-runtime` path upstream: exported,
  documented, but its successor exists. Mitigation: our adapter object
  already matches `ExternalThreadProps` field-for-field; migration is a
  mount-point swap.
- Approval UI rendering by the stock components is unconfirmed (the *types*
  are verified; the default rendering may need our tool-fallback to draw the
  option buttons). Either way the file is vendored and ours; M4 acceptance
  covers it.
- Tailwind preflight vs. dashboard CSS interactions — bounded by M2's
  screenshot acceptance and the class-scoping rule in §7.5.
- Bundle size grows (React + radix-ui + zustand internals). Irrelevant for a
  self-hosted single-user tool; not a goal.

## 10. Fixed decisions (this revision)
1. The chat UI is part of the dashboard; no standalone frontend container.
2. assistant-ui with vendored registry components; primitives + vendored
   sources are the customization surface; upstream upgrades come through
   re-vendoring diffs, never at image-build time from a moving ref.
3. React 19 + wouter; Tailwind v4 via standalone CLI + esbuild; no Vite/
   webpack; `tsc --noEmit` still gates every image build.
4. The browser speaks plain ACP to the existing gateway; the gateway stays
   client-agnostic (external ACP clients remain supported) except the two
   additive fixes in §7.3.
5. `!bang` execution is a REST feature of the orchestrator scoped to the
   session container, persisted in SQLite, rendered as a shell tool call.
6. One thread per session; the session list is the thread list.
