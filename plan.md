# Build Plan: Replace acp-ui with an in-dashboard thread view (assistant-ui)

Status: PROPOSED (revision 4). Owner decisions incorporated:
(2026-08-30 a) the frontend is assistant-ui, embedded in our dashboard; the
standalone acp-ui app goes away. (2026-08-30 b) no vendor scripts, no
committed build artifacts, no parallel build paths: dependencies dictate the
frontend tech, so the project adopts that ecosystem's canonical toolchain
outright, and prior stack rules (esbuild-only, no Tailwind, plain
per-component CSS) are void. Styles compile from source on every build.
(2026-08-30 c) **one build system for the whole repository, not per tier**:
since the frontend needs Vite, the orchestrator and proxy build with Vite
too, and esbuild leaves the repo. By the same rule there is one test runner
(Vitest) — node:test migrates.
Facts in §2 were verified against installed packages and live registry
payloads on 2026-08-30. Audience: a coding agent. Follow milestones in
order. Do not begin implementation until the owner approves this plan.

---

## 1. Why, and what must be true afterwards

acp-ui is a separate application with its own session management and its own
UX, and we can only influence it upstream. The concrete failures that forced
the frontend decision, each of which must be demonstrably fixed:

| # | Complaint | Mechanism that fixes it (details in §6) |
|---|-----------|------------------------------------------|
| 1 | acp-ui's session panel duplicates our dashboard | The thread view lives *inside* the dashboard at `/sessions/:id`; there is no second app and no second session list |
| 2 | No ArrowUp to recall previous messages | `unstable_useComposerInputHistory()` — an upstream hook with exactly terminal semantics, spread onto the composer input |
| 3 | Input loses focus after each send | We own the installed composer component; autofocus on mount and refocus after send are asserted by the e2e test |
| 4 | `!bang` local commands don't work | First-party feature: composer text starting with `!` runs in the session container via a new exec endpoint, never touching the model |
| 5 | Can't see output of commands | Tool-call parts render name, args, status and output through the tool components; `!bang` output rides the same rendering path |
| 6 | No way to switch into auto mode | Header mode switcher driven by the session's advertised modes → `session/set_mode`; live via `current_mode_update` |

What stays: the orchestrator's and proxy's source code and behavior (only
their build/test tooling changes, §4), the ACP gateway (browser-facing WS
protocol unchanged — external ACP clients keep working), the egress proxy,
the session image, container lifecycle, reaper, both test scripts.

What goes: the acp-ui build stage, the `/ui` route, `dashboard/src/acpui.ts`
and its tests, the localStorage-seeding connect flow, and the entire
Preact-era dashboard toolchain and styling system.

## 2. Verified facts (source-inspected 2026-08-30; pin these versions)

**`@assistant-ui/react` 0.15.17** (published within the last day; actively
maintained; peer deps `react ^18 || ^19`).

- `useExternalStoreRuntime<T>(store: ExternalStoreAdapter<T>)` is exported
  from the package root and mounts via `<AssistantRuntimeProvider>`. It lives
  under a `legacy-runtime/` path internally but is the supported
  external-state entry point; its successor (`ExternalThread` from
  `@assistant-ui/core/store`) has the same field shape, so a later migration
  is mechanical.
- `ExternalStoreAdapter` carries everything we need, verified field by
  field: `messages` + `convertMessage` (to `ThreadMessageLike`), `isRunning`,
  `isSendDisabled`, `onNew`, `onCancel`, `onRefetchThread`, and
  **`onRespondToToolApproval(options: RespondToToolApprovalOptions)`**.
  A `queue?: ExternalThreadQueueAdapter` field exists for prompt queueing —
  not used in v1, but the upgrade path for the adapter's promptQueueing/
  steering `_meta` extensions already exists upstream.
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
  in a component file we own.

**Styling and components — why Tailwind is dictated, not chosen.**

- Components are installed from a shadcn-format registry
  (`https://r.assistant-ui.com/base/<name>.json`) into the project source
  tree by the official CLIs (`npx assistant-ui add thread` shells out to
  `npx shadcn add <registry-url>`). Installed sources are committed —
  that is the shadcn distribution model, not a custom mechanism — and
  upgrades are a re-run with `--overwrite`, reviewed as a diff.
- The installed sources use both semantic `aui-*` classes and Tailwind
  utility classes: `thread.aui.tsx` alone carries 175 distinct utility
  tokens (variants like `dark:hover:bg-accent`, values like `-mb-7.5`,
  opacity forms like `border-border/60`). `@assistant-ui/styles` 0.3.7
  covers only the 147 `aui-*` classes — verified: zero utility classes in
  it. Nothing published by upstream can style these components without a
  Tailwind compile; therefore Tailwind is a build dependency.
- Compilation was proven end-to-end: Tailwind v4 over the installed sources
  with `@import "tailwindcss"` + `tw-animate-css` +
  `@assistant-ui/styles/index.css` + the theme bridge emits every utility
  the components use (spot-checked variants, fractional values, opacity
  modifiers) in ~100 ms.
- **Trap, verified:** Tailwind v4 silently omits utilities like
  `bg-background` unless `@theme` defines those colors. The
  shadcn-convention token block (§7.5) is a correctness requirement, not
  theming polish.
- `thread` registry deps: shadcn `button`, `skeleton`, plus `attachment`,
  `file`, `follow-up-suggestions`, `image`, `markdown-text` (which pulls
  `@assistant-ui/react-markdown` 0.14.13 + `remark-gfm`), `reasoning`,
  `tooltip-icon-button`, `tool-fallback`, `tool-group`,
  `use-copy-to-clipboard`; npm deps `lucide-react`.

**Vite as the server build — proven, not assumed.** A PoC with the
orchestrator's dependency shape (node builtins + `ws` + native
`better-sqlite3`) built with `vite build` (`build.ssr: 'src/index.ts'`,
`target: 'node22'`) in 30 ms: builtins and npm deps — the native module
included — stay external by default (the semantics of today's
`esbuild --packages=external`), the output is a plain ESM file, and the
bundle boots and serves. The proxy is stdlib-only, so its Vite output is
the same single self-contained file it ships today.

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
  ├── session list / create / info views      (restyled on the new stack)
  └── /sessions/:id  = THREAD VIEW
      ├── assistant-ui components (installed sources, ours to edit)
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

## 4. One toolchain (repo-wide)

| Concern | Choice |
|---|---|
| Framework | React 19 |
| Build | Vite 8 — the single build system for every package. Dashboard: `@vitejs/plugin-react` 6, `vite build` emits JS+CSS together. Orchestrator and proxy: `build.ssr` Node bundles (verified §2), replacing esbuild, which leaves the repo |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` 4.3.3, compiled from source on every build; `tw-animate-css`; `@assistant-ui/styles` for the `aui-*` layer |
| Components | assistant-ui registry (base flavor) + shadcn primitives, installed by their official CLIs, sources committed; `components.json` in repo |
| Chat runtime | `@assistant-ui/react` 0.15.17, `useExternalStoreRuntime` |
| Markdown | `@assistant-ui/react-markdown` 0.14.13 + `remark-gfm` |
| Router | `react-router` 8 (library mode: `BrowserRouter`/`Routes`) |
| State | `useSyncExternalStore` over plain TS stores (sessions polling, thread store) |
| Tests | Vitest 4 — the single test runner for every package; the orchestrator's and proxy's node:test suites migrate (runner imports change; the node:assert assertions run unchanged under Vitest) |
| Type gate | `tsc --noEmit` before `vite build` in every package's Docker stage, unchanged |
| Dev loop | `vite dev` with `/api`, `/healthz`, `/ws` proxied to the orchestrator |

House styling rule (replaces the plain-CSS rules): Tailwind utilities and
shadcn/assistant-ui components everywhere in the dashboard; design tokens
live once in `globals.css` as CSS variables bridged into `@theme`; the
Preact-era `tokens.css`/`base.css`/per-component `.css` files are deleted,
and the existing views are restyled during the port, so the app has exactly
one styling system.

Each package keeps its own package.json and Docker stage (that layering is
what lets images build independently), but all three carry the same three
scripts on the same tools: `check` = `tsc --noEmit`, `build` = `vite build`,
`test` = `vitest run`, with vite/vitest pinned to identical versions across
packages.

## 5. Repository changes

```
dashboard/                      # becomes a standard Vite app
├── index.html                  # Vite entry (moves from src/ to root, Vite convention)
├── vite.config.ts              # react() + tailwindcss() + /api,/ws dev proxy + vitest config
├── components.json             # shadcn/assistant-ui CLI config (aliases, css path)
├── tsconfig.json               # app config; tsconfig.node.json for vite.config
├── package.json                # scripts: dev / build (vite) / check (tsc) / test (vitest)
└── src/
    ├── main.tsx                # React mount + <BrowserRouter> routes
    ├── globals.css             # @import tailwindcss, tw-animate-css,
    │                           #   @assistant-ui/styles; token block + @theme
    │                           #   bridge; dark variant config (§7.5)
    ├── lib/utils.ts            # cn() — installed by shadcn CLI
    ├── stores/
    │   ├── sessions.ts         # list polling (port of store.ts)
    │   └── thread/
    │       ├── acp-client.ts   # JSON-RPC over WS (§7.1)
    │       ├── translate.ts    # ACP session/update* → message model (pure)
    │       ├── thread-store.ts # messages, isRunning, modes, approvals, exec
    │       └── *.test.ts       # Vitest
    ├── views/
    │   ├── SessionList.tsx     # restyled: Tailwind + shadcn Card/Badge/Button
    │   ├── SessionCreate.tsx   # restyled: shadcn form controls
    │   ├── SessionThread.tsx   # NEW: runtime wiring + header (badges, mode
    │   │                       #   switcher, link to info)
    │   └── SessionInfo.tsx     # ops from old SessionDetail + external-ACP-
    │                           #   client connect info (wss URL + token)
    └── components/
        ├── assistant-ui/…      # installed registry sources (thread, markdown-
        │                       #   text, tool-fallback, tool-group, reasoning,
        │                       #   tooltip-icon-button, attachment, …)
        └── ui/…                # installed shadcn primitives (button, skeleton,
                                #   + card/badge/input/dialog as the views need)
DELETED: dashboard/src/acpui.ts + test, store.ts, main.css, styles/tokens.css,
         styles/base.css, every per-component/view .css file, SessionDetail.*,
         orchestrator Dockerfile acpui-build stage, /ui serving in index.ts.
orchestrator/src/exec.ts        # NEW: container exec runner (§7.4)
orchestrator/vite.config.ts     # NEW: build.ssr node bundle; vitest config
proxy/vite.config.ts            # NEW: same; esbuild devDependency removed
shared/types.ts                 # + ExecRequest/ExecRecord shapes
```

## 6. UX requirements, precisely

1. **Session management** — the dashboard's list is the only session UI.
   Tapping a card opens the thread directly. Ops move to `/sessions/:id/info`.
2. **ArrowUp history** — `unstable_useComposerInputHistory()` spread onto the
   installed `ComposerPrimitive.Input`. e2e-asserted.
3. **Focus** — composer autofocuses on thread mount and after every send,
   including sends resolved by error; asserted in e2e (send →
   `document.activeElement` is the input). If the installed composer doesn't
   already do it, we add it there — it is our file.
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
   onto tool-call parts; the installed `tool-fallback` renders args and
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
or cancel). The store is framework-free and fully unit-tested under Vitest —
including approval attachment/resolution, replay rebuild, and out-of-order
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

### 7.5 globals.css: tokens and dark mode
One file owns the design system: `@import "tailwindcss"`,
`@import "tw-animate-css"`, `@import "@assistant-ui/styles/index.css"`;
shadcn-convention CSS variables (`--background`, `--primary`, …) defined for
light and dark from our existing palette; an `@theme inline` block bridging
them into Tailwind color tokens (mandatory — see the §2 trap); dark mode as
the shadcn-standard class variant
(`@custom-variant dark (&:where(.dark, .dark *))`) with a three-line inline
script in `index.html` applying `.dark` from `prefers-color-scheme` before
first paint (manual toggle is a later nicety, not v1).

## 8. Milestones

### M0 — Backend toolchain migration
Orchestrator and proxy move from esbuild + node:test to Vite (`build.ssr`)
+ Vitest; Dockerfiles updated; esbuild removed from the repo. No source
changes beyond test-runner imports. Acceptance: both suites green under
Vitest; the built orchestrator bundle boots against a data dir and fails at
the absent docker socket exactly as the esbuild bundle did; the built proxy
bundle serves and denies exactly as before (re-run its live checks);
`docker compose config` valid.

### M1 — Vite toolchain + React port + restyle
Stand up the Vite app (config, tsconfig split, scripts, dev proxy); port
list/create views and the session store to React + react-router; restyle
them with Tailwind + shadcn primitives (button/card/badge/input/dialog via
`npx shadcn add`); delete the Preact toolchain, esbuild config and all old
CSS; split SessionDetail into a placeholder thread route + SessionInfo.
Acceptance: `npm run check` and `npm run test` green; `vite build` output
served by the orchestrator's static handler works with SPA fallback;
Chromium screenshots of list/create/info in light and dark, visually
coherent (not pixel-identical — this is a restyle); card tap navigates to
`/sessions/:id`.

### M2 — assistant-ui components + playground
`npx assistant-ui add thread` (and the deps it pulls) with committed
`components.json`; write §7.5's globals.css. Acceptance: a playground route
rendering the installed Thread over a canned in-memory external store shows
fully styled composer, user/assistant messages, markdown, reasoning, and a
tool call — light and dark screenshots, no unstyled elements, no console
errors.

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
dashboard stage = `npm ci` + `tsc --noEmit` + `vite build`; update
ARCHITECTURE.md (frontend section rewritten: stack, one-build rule, component
installation model) and README (connect = open the session; external-ACP-
client instructions move to SessionInfo/README appendix); verify
scripts/live-test.sh still passes unchanged (it drives the WS directly).
Acceptance: full test matrix green (orchestrator/dashboard/proxy unit + stub
e2e); `docker compose config` valid; repo contains no reference to acp-ui
outside ARCHITECTURE.md history notes.

Out of scope for v1 (explicitly): attachments/images, message branching &
edit-resend, prompt queueing/steering UI (upstream `queue` adapter exists —
natural M7), syntax highlighting in code blocks (add-on package later),
multi-thread-per-session, manual dark-mode toggle.

## 9. Risks

- **The one unverifiable-here integration** remains the live adapter: modes
  payload shape and replay behavior against real `claude-agent-acp` need one
  session on the owner's host after M4 (same caveat as the original plan's
  M1). The stub gateway encodes the ACP v1 schema, so drift shows up as a
  concrete diff, not a mystery.
- `unstable_useComposerInputHistory` may change signature — pinned version;
  fallback is inlining the behavior into the installed composer (~40 lines).
- `useExternalStoreRuntime` is in a `legacy-runtime` path upstream: exported,
  documented, but its successor exists. Mitigation: our adapter object
  already matches `ExternalThreadProps` field-for-field; migration is a
  mount-point swap.
- Approval UI rendering by the stock components is unconfirmed (the *types*
  are verified; the default rendering may need our tool-fallback to draw the
  option buttons). Either way the file is installed source and ours; M4
  acceptance covers it.
- The restyle in M1 changes the dashboard's look. Bounded by screenshot
  review in both schemes; the palette carries over via the token block.
- Vite and Tailwind become load-bearing build dependencies — for every
  package, not just the dashboard. That is the point of the pivot: both are
  ecosystem-canonical and actively maintained, the server-build semantics
  were verified before adoption (§2), and `tsc --noEmit` still gates every
  image build.

## 10. Fixed decisions (this revision)
1. The chat UI is part of the dashboard; no standalone frontend container.
2. assistant-ui with registry components installed by the official CLIs;
   installed sources are committed and are the customization surface;
   upgrades come through CLI re-runs reviewed as diffs, never at image-build
   time from a moving ref.
3. One build system and one test runner for the whole repository: Vite 8
   and Vitest 4 in every package — dashboard (React 19, Tailwind v4
   compiled from source every build, shadcn-convention theming) and the
   Node services (`build.ssr` bundles) alike. esbuild and node:test leave
   the repo. The former esbuild-only / no-Tailwind / plain-CSS rules are
   revoked. No vendor scripts, no committed generated artifacts, no
   parallel build paths.
4. Tailwind utilities + shadcn/assistant-ui components are the one styling
   system for the entire dashboard; design tokens live once in globals.css.
5. The browser speaks plain ACP to the existing gateway; the gateway stays
   client-agnostic (external ACP clients remain supported) except the two
   additive fixes in §7.3.
6. `!bang` execution is a REST feature of the orchestrator scoped to the
   session container, persisted in SQLite, rendered as a shell tool call.
7. One thread per session; the session list is the thread list.
