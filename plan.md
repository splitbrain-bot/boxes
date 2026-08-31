# Code review in Boxes

Last modified: 2026-08-31
Repo state: planned on top of commit `cd4269a`.

## What is wanted

The standalone desktop tool [`review`](https://github.com/splitbrain/review) —
browse a project's files, read them highlighted, tap a line to leave a
comment, everything persisted to a `REVIEW.md` the agent can read back — built
into Boxes, against a session's workspace, in the stack Boxes already has:
Node + TypeScript in the orchestrator, React + Tailwind + shadcn in the
dashboard. Same features:

- a file browser over the session's workspace,
- syntax-highlighted file viewing,
- per-line comments: add, edit, delete,
- read and write of `REVIEW.md`, **byte-compatible with the desktop tool's
  format**, so a review started in one is continued in the other,
- git awareness: file statuses in the tree, changed/added lines marked in the
  gutter, deletions marked between lines, compare against a base revision,
- and one thing the desktop tool cannot have: the review lives where the agent
  works. `REVIEW.md` is written into the workspace, so "address the comments
  in REVIEW.md" is a one-line prompt — the review view and the thread close a
  loop instead of being two applications.

The additional requirement over the desktop tool is that it must work on a
phone, because Boxes is driven from one. That rules out porting the desktop
tool's three-panel layout and its hover interactions as they are; the feature
set survives, the layout does not.

## The constraint everything is designed around

**The reviewed files are inside the session container, and the orchestrator
has no mount into it.** The desktop tool reads the filesystem it runs on;
Boxes cannot. The workspace is a named volume mounted only into the session
container, and the one road the orchestrator already has into it is
`docker exec` — the same road the `!bang` commands take (`exec.ts`,
`dk.runCommandExec`).

So every review operation is an exec: listing files is `git ls-files`, reading
a file is `cat`, git status is `git status --porcelain`, writing `REVIEW.md`
is a `cat > tmp && mv` with the content on stdin. That settles several things
at once:

- **No new privilege.** Review sees exactly what the agent sees, inside the
  container's existing isolation. Nothing mounts the volume anywhere new.
- **The container must be running.** Opening the review view starts a stopped
  container, exactly as opening a thread does (`execTarget` already does
  this).
- **Latency is an exec round trip** — tens of milliseconds per call. Fine for
  interactive browsing, poor for chatty protocols, which is why the API below
  batches (tree + statuses + annotation markers in one response, file content
  + diff + annotations in one response) and why live updates poll instead of
  pretending we can watch files.
- **No fsnotify.** The desktop tool watches the filesystem and pushes over a
  WebSocket. There is no inotify across the exec boundary worth trusting, so
  freshness comes from polling a cheap fingerprint endpoint, below.

The alternatives were considered and rejected: mounting session volumes into
the orchestrator breaks the "nothing shares a filesystem with the sandbox"
property and fights the one-container-per-volume lifecycle; running a helper
server inside the session image adds a second listener inside the sandbox and
a version coupling between images. Exec is slower and simpler and uses only
machinery that exists.

### Exec plumbing this needs

`runCommandExec` takes a shell string (`bash -lc <command>`), which is right
for `!bang` and wrong for review: review paths are user input and must never
be spliced into a shell string. Two additions to `docker.ts`:

- `runArgvExec(containerId, argv, workingDir, { stdin? })` — same demux and
  exit-code handling as today, but `Cmd` is the argv array itself, no shell,
  with optional `AttachStdin` for the write path.
- On top of it in a new `orchestrator/src/review/exec.ts`: `capture(argv,
  limit)` (buffer output up to a byte cap, return `{output, exitCode,
  truncated}`) and `writeFile(relPath, content)` — argv
  `['sh', '-c', 'cat > "$1.tmp" && mv -- "$1.tmp" "$1"', 'sh', <abs path>]`,
  content on stdin. The path travels as a positional parameter, not as shell
  text, and the write is atomic, matching the desktop tool's flush.

Review execs do not go through `exec.ts`'s `runCommand`: they must not land in
`exec_log` (they are not user commands), and they want per-call output caps
(a 2 MiB file read, a 64 KiB status). They do call `manager.touch(id)` so an
active review holds off the idle reaper, which otherwise cannot see a REST
poller the way it sees an attached WebSocket.

### Where the review roots

`/workspace` starts empty and the agent usually clones a project into a
subdirectory, so `/workspace` itself is frequently not the repo. Root
resolution, at review open and cached on the session row:

1. If `/workspace` is a git work tree (`git -C /workspace rev-parse
   --show-toplevel`), root there.
2. Else, if `/workspace` contains exactly one directory and it is a git work
   tree, root there — the overwhelmingly common shape.
3. Else root at `/workspace` with git features off (the desktop tool degrades
   the same way: plain tree, no statuses, no diff).

`REVIEW.md` is written at that root, which is what makes it visible to the
agent as a file of the project it is working on, and what keeps the format
contract with the desktop tool (it also writes at the reviewed root).

## The REVIEW.md contract

The desktop tool's `internal/store` is ported to TypeScript as pure functions,
keeping the format exactly:

```
# Code Review

_Started: 2026-08-31_

---

## `src/app.ts`

#### Line 42

The comment, as written. A line that would parse as this document's own
structure is backslash-escaped on write.

```typescript context
39: …three lines of context above…
42: the annotated line
45: …three lines below…
```
```

`#### Line N (outdated)` marks an annotation whose context no longer matches.
The `context` word in the fence info string separates a stored context block
from a code sample inside a comment; parsing is strict when the marker is in
use. Context radius is 3, line numbers are 1-based, files sort
lexicographically, lines numerically. The Go implementation's `parse.go` /
`write.go` / `drift.go` are the specification; the round-trip and drift test
tables port with them.

**REVIEW.md is the single source of truth, and it is shared with the agent.**
The orchestrator holds no annotation table; every mutation is
read → parse → apply → serialize → write, under a per-session mutex, with the
file's hash checked between read and write. If the hash moved (the agent
edited REVIEW.md mid-mutation), re-read and re-apply once. This is the same
last-writer honesty the desktop tool has with its file watcher, without the
watcher.

Drift detection ports as-is: on file fetch and on each poll tick that reports
a changed workspace, compare each annotation's stored context against the
current source; relocate on an exact context match elsewhere, mark
`(outdated)` when it is gone, flush when anything changed.

## Backend: module and API

New module `orchestrator/src/review/`, pure logic separated from exec I/O so
the tests need no Docker:

```
orchestrator/src/review/
  store.ts        parse/serialize REVIEW.md, mutation, drift (pure; port of internal/store)
  gitstatus.ts    porcelain/name-status parsing, base resolution (pure parsers; port)
  difflines.ts    unified-diff → line markers, hunks, deletion markers (pure; port)
  tree.ts         git ls-files / find output → tree, ignore lists (port of internal/filetree)
  safepath.ts     path containment under the review root (port of internal/safepath)
  exec.ts         capture/writeFile on runArgvExec; root resolution
  service.ts      the per-session review façade: cache, mutex, fingerprint
```

Routes in `app.ts`, shapes in `shared/types.ts` like every other endpoint.
Batched deliberately — a phone on a slow link gets one round trip per screen:

| Method and path | Does |
|---|---|
| `GET /api/sessions/:id/review/tree` | Tree, git status per path, per-file annotation counts, the resolved root and base — the whole left panel in one response |
| `GET /api/sessions/:id/review/file?path=` | `{ content, truncated, binary, size, lines, diff: {lines, hunks, deletions}, annotations }` — the whole file view in one response |
| `PUT /api/sessions/:id/review/annotations` | `{path, line, comment}` — create or update, returns the file's annotations |
| `DELETE /api/sessions/:id/review/annotations?path=&line=` | Delete one |
| `GET /api/sessions/:id/review/status` | `{ reviewHash, headCommit, statusHash }` — the poll fingerprint, three cheap execs |
| `PUT /api/sessions/:id/review/base` | `{rev}` or `{rev: null}` — resolve via `git rev-parse` + `git merge-base` in the container, persist on the session row |
| `DELETE /api/sessions/:id/review` | Delete REVIEW.md — the "New review" button |

Git invocations are the desktop tool's, verbatim where possible:
`-c core.quotepath=false status --porcelain -uall`, `diff --name-status
<base>`, `ls-files --others --exclude-standard`, `diff <rev> --unified=3
--no-color -- <path>`, `merge-base <commit> HEAD` — each as argv with `--`
before any path.

One migration: `review_base` (the resolved base commit and the rev as given)
and `review_root` columns on `sessions`. Nothing else touches the schema —
annotations live in the file.

Freshness is polling, not push, in v1. The dashboard already polls
`/api/sessions` every 5 s while visible; the review view polls
`review/status` the same way and refetches tree/file/annotations only when a
fingerprint moved, running drift server-side on that transition. The desktop
tool's WebSocket push is a later stage if polling feels laggy — it would be a
new upgrade path (`/ws/sessions/:id/review`) beside the ACP gateway, not a
change to it — but nothing below depends on it.

### Security

- Every client-supplied path goes through the `safepath` port against the
  review root before any exec; escape attempts 404 like an unknown session.
- No user input ever reaches a shell string; argv arrays only, `--`
  separators for git, content over stdin.
- Output caps per endpoint (file reads 2 MiB then `truncated: true`; binary
  sniffed by NUL byte and refused with `binary: true`).
- File content and comments are agent-influenced and hostile by assumption:
  the frontend renders them as text nodes only — highlight tokens become
  React elements, never `dangerouslySetInnerHTML`. Comments render as plain
  text in v1 (no markdown rendering of comment bodies).
- The endpoints sit under `/api` behind whatever authenticates it, and change
  nothing about the reverse-proxy contract.

## Frontend

### Route and entry

`/sessions/:id/review`, with the open file in the search string
(`?path=src/app.ts`) so a file is linkable and back-button works. Entry
points: a Review action in the thread header next to Fork, and on the session
card. The view owns the whole viewport like the thread view does.

### Layout: one commenting UI, two arrangements

The desktop tool's three panels and hover tooltips do not survive a phone, so
the design collapses to patterns that work at both sizes instead of two
parallel UIs:

- **Comments are inline, GitHub-style** — a card under the annotated line —
  on every screen size. No right-hand sidebar to reflow away; the same
  component both arrangements render.
- **The tree is a panel on desktop and a Sheet on mobile.** ≥ `md`: a
  collapsible left column. Below: full-screen code, tree in a shadcn Sheet
  opened from the header, closing on selection. Same tree component, badges
  for git status colour and comment count on both.
- **Tap replaces hover.** Line commenting: tap/click a line highlights it and
  shows the composer — inline under the line on desktop, a bottom sheet on
  mobile (the keyboard is coming up anyway). Diff hunks: the desktop tool
  shows them on gutter hover; here a tap on the gutter marker opens the hunk
  as a sheet/popover. Deletion markers likewise.
- **The scrollbar minimap becomes prev/next.** Scrollbar annotation markers
  are unusable on touch scrollbars. Instead a compact toolbar: next/previous
  change, next/previous comment, comment count. Cheaper, and honestly better
  on desktop too. A decorative overview rail can come later; it is paint, not
  function.
- **Code pane mechanics:** CSS grid per line — sticky line-number gutter,
  code cell scrolling horizontally as one block (`overflow-x` on the pane, so
  the gutter stays put), a wrap toggle for prose-ish files. Gutter tap
  targets ≥ 44 px on touch. Tailwind only, tokens from `globals.css`, same as
  the rest of the dashboard.

New shadcn primitives this needs (`npx shadcn add`, committed like the
existing ones): `sheet`, `popover`, possibly `drawer`.

### Highlighting

Client-side, with Shiki (`shiki/core` + lazily imported grammars and the
CSS-variables theme bound to the existing design tokens, so light/dark just
works). The API ships plain text; the browser tokenizes and renders each line
as spans — which is also what makes every line an addressable, tappable row.
Grammars load per file type on demand and are code-split out of the main
bundle; files past the size cap or with pathological lines render un-tokenized
rather than janking the tab. Server-side highlighting (the Chroma role) was
considered and dropped: it puts render markup on the wire, couples the
orchestrator to presentation, and the phone still has to paint it.

### State

`stores/review.ts` in the zustand style of `sessions.ts`: tree, statuses,
open file (content, tokens, diff), annotations, base, the status-poll loop
(visible tab only), and optimistic annotation mutation with rollback on a
failed PUT.

### Closing the loop with the agent

A **"Hand to agent"** action on the review view: navigates to the session's
current thread with the composer prefilled — "Read REVIEW.md and address the
comments in it." — not sent, just staged. One line of integration, and it is
the reason this feature belongs inside Boxes at all.

## What is deliberately not ported

- **WebSocket live updates and file watching** — polling a fingerprint
  instead (v1; push is an additive later stage).
- **The hover scrollbar minimap** — replaced by prev/next navigation.
- **Graceful shutdown closing the tab** — meaningless here; the view is a
  route, not an app.
- **The comment sidebar** — inline comments on all sizes.
- **Chroma server-side HTML** — Shiki tokens client-side.

## Stages

Each lands green and shippable on its own.

1. **Pure ports + exec plumbing.** `review/{store,gitstatus,difflines,tree,
   safepath}.ts` with the Go tests' tables ported (round-trip fixtures
   asserted byte-for-byte against files the Go tool wrote); `runArgvExec` with
   stdin support in `docker.ts`; `review/exec.ts` capture/write/root
   resolution. No routes yet.
2. **REST surface.** `service.ts`, the seven routes, `shared/types.ts`
   shapes, the `sessions` migration, `app.test.ts` coverage driving the real
   routes over a fake exec layer (the same pattern the exec endpoint's tests
   use).
3. **Read-only viewer.** Route, entry points, tree (desktop column + mobile
   sheet), file view with Shiki tokens, git status colours, diff gutter
   markers, hunk sheet, prev/next navigation. Usable as a browse-the-
   workspace feature by itself.
4. **Commenting.** Composer (inline / bottom sheet), annotation CRUD against
   REVIEW.md, inline comment cards, comment badges in tree and toolbar, "New
   review", "Hand to agent".
5. **Base revision + drift.** Base picker in the header (status bar shows the
   active base, as the desktop tool does), `statusesSince` behaviour, drift
   check on fetch and on fingerprint change, `(outdated)` rendering.
6. **Polish and the browser suite.** Review pages in the dashboard e2e suite
   against a stub orchestrator serving canned review responses (tree → open →
   comment → REVIEW.md write asserted, on desktop and mobile viewports);
   optional WS push and overview rail if polling proves laggy.

## Risks and open ends

- **Adapter and reviewer writing REVIEW.md concurrently.** Hash-guarded
  read-modify-write with one retry keeps it honest; a lost race costs one
  visible refresh, not data, because every write re-serializes the whole
  parsed file.
- **Huge workspaces.** Tree capped (~20k entries, then a "tree truncated"
  notice); `git ls-files` does the heavy lifting where there is a repo; the
  desktop tool's ignore lists (node_modules, dist, binaries…) port as-is.
- **Exec churn from polling.** Three tiny execs per open review view per 5 s,
  visible-tab only. If it shows up, the fingerprint collapses to one exec
  (one `sh -c` computing all three hashes — static script, no user input).
- **Shiki bundle weight.** Grammars and engine lazy-loaded; the thread view's
  bundle must not grow. Verified in stage 3 by the build's chunk report.
- **A session with no git.** Everything degrades to tree + read + comment,
  statuses and diffs empty — same as the desktop tool outside a repo.
- **Reaper interplay.** Review polling touches the session; without that an
  idle-looking session under active review would be stopped mid-read.
