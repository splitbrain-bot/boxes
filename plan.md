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

## Where the files live: the workspace becomes a bind mount

Today a session's workspace is the named volume `ws-<id>`, mounted only into
the session container — the orchestrator has no filesystem path to it, and
reaching the files means `docker exec`. This plan changes that first:
**session workspaces become directories under the orchestrator's own data
volume, bind-mounted into their session containers.** The orchestrator then
reads and writes review data as ordinary files, and runs git itself.

An exec-based design (every read a `docker exec`) was considered and set
aside: the orchestrator already holds the Docker socket, so direct access
grants it no privilege it lacks, and the exec tax was real — an exec round
trip per interaction, no review without booting the container, no honest file
watching. The residual concerns direct access does raise — symlinks in an
agent-controlled tree, git executing repo-local config — are handled as
maintained invariants in the security section below, not by architecture.

What direct access buys, concretely:

- **Reviewing a stopped session.** File reads and every git operation run in
  the orchestrator, so the natural moment for a review — the agent is done,
  the box has idled out — needs no container start at all, and review
  polling never holds off the reaper.
- **Plain code.** The desktop tool's design ports nearly one-to-one:
  filesystem reads, git as a child process, atomic REVIEW.md writes.
- **Real file watching** later, instead of polling forever: fs events work on
  a directory the process can see.

### The storage change

- New sessions get a workspace directory `${DATA_DIR}/workspaces/<id>`,
  created at session create (the `workspaces/` parent mode 0700; the
  directory chowned to uid 1000, the session image's `agent` user, since a
  bind mount — unlike a named volume — is not ownership-initialised by
  Docker), and `rm -rf`ed at delete where `removeVolume` runs today.
- The container template's `Binds` entry becomes
  `<hostWorkspacesPath>/<id>:/workspace`. Bind sources are resolved by the
  daemon, so the orchestrator must name the **host-side** path of its own
  `/data`: at boot it inspects its own container (id from `/etc/hostname`)
  and takes the `Source` of the mount whose `Destination` is `DATA_DIR`.
  With the shipped compose that resolves to
  `/var/lib/docker/volumes/boxes-data/_data`, a plain daemon-side directory
  that binds fine on Linux and inside Docker Desktop's VM alike. Outside a
  container (`npm run dev`, tests) the two paths are the same and the
  inspection is skipped.
- **The home volume stays a named volume.** It holds transcripts and
  whatever credentials a user creates by logging in inside the session;
  review has no business there and nothing else needs it mounted.
- `sessions` gains a `workspace_dir` column; `ws_volume` stays for legacy
  rows. **Legacy sessions migrate on their next start:** the start path sees
  a volume-backed row, copies the volume's content into the new directory
  (a one-shot helper container running `cp -a`, since the orchestrator has
  no path to the volume — the very problem being removed), recreates the
  session container with the bind (containers are disposable here: read-only
  rootfs, everything durable is in the two mounts), and deletes the volume.
  A *running* legacy session keeps working untouched and migrates at its
  next stop/start cycle; the review view tells it to.
- `scripts/smoke-test.sh` grows the matching assertions: the workspace is
  still writable from inside, one session cannot see another's workspace,
  and `workspaces/` on the data volume is 0700.

Verify early (first thing in stage 1, on both OSes the README supports): the
subpath-of-a-volume bind on Docker Desktop, and uid-1000 ownership surviving
the round trip. This is the plan's one load-bearing assumption about Docker
behaviour.

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
read → parse → apply → serialize → write-tmp-then-rename, under a per-session
mutex, with the file's hash checked between read and write. If the hash moved
(the agent edited REVIEW.md mid-mutation), re-read and re-apply once. The
file is chowned to uid 1000 after write so the agent can edit or delete it.

`REVIEW.md` is written at the review root — see below — which is what makes
it visible to the agent as a file of the project it is working on, and what
keeps the format contract with the desktop tool (it also writes at the
reviewed root).

Drift detection ports as-is: on file fetch and on each poll tick that reports
a changed workspace, compare each annotation's stored context against the
current source; relocate on an exact context match elsewhere, mark
`(outdated)` when it is gone, flush when anything changed.

### Where the review roots

`/workspace` starts empty and the agent usually clones a project into a
subdirectory, so the workspace directory itself is frequently not the repo.
Root resolution, at review open and cached on the session row:

1. If the workspace is a git work tree (`git rev-parse --show-toplevel`),
   root there.
2. Else, if it contains exactly one directory and that is a git work tree,
   root there — the overwhelmingly common shape.
3. Else root at the workspace with git features off (the desktop tool
   degrades the same way: plain tree, no statuses, no diff).

## Backend: module and API

New module `orchestrator/src/review/`, pure logic separated from I/O so the
parser tests need no filesystem:

```
orchestrator/src/review/
  store.ts        parse/serialize REVIEW.md, mutation, drift (pure; port of internal/store)
  gitstatus.ts    porcelain/name-status parsing, base resolution (pure parsers; port)
  difflines.ts    unified-diff → line markers, hunks, deletion markers (pure; port)
  tree.ts         git ls-files / directory walk → tree, ignore lists (port of internal/filetree)
  fs.ts           contained reads/writes under one workspace: containment, caps, atomic write
  git.ts          the one place a git process is spawned: fixed argv, hardened env
  service.ts      the per-session review façade: root resolution, cache, mutex, fingerprint
```

Routes in `app.ts`, shapes in `shared/types.ts` like every other endpoint.
Batched deliberately — a phone on a slow link gets one round trip per screen:

| Method and path | Does |
|---|---|
| `GET /api/sessions/:id/review/tree` | Tree, git status per path, per-file annotation counts, the resolved root and base — the whole left panel in one response |
| `GET /api/sessions/:id/review/file?path=` | `{ content, truncated, binary, size, lines, diff: {lines, hunks, deletions}, annotations }` — the whole file view in one response |
| `PUT /api/sessions/:id/review/annotations` | `{path, line, comment}` — create or update, returns the file's annotations |
| `DELETE /api/sessions/:id/review/annotations?path=&line=` | Delete one |
| `GET /api/sessions/:id/review/status` | `{ reviewHash, headCommit, statusHash }` — the poll fingerprint, cheap local hashing |
| `PUT /api/sessions/:id/review/base` | `{rev}` or `{rev: null}` — resolve via `git rev-parse` + `git merge-base`, persist on the session row |
| `DELETE /api/sessions/:id/review` | Delete REVIEW.md — the "New review" button |

None of these start or touch the session container. Git invocations are the
desktop tool's, verbatim where possible: `-c core.quotepath=false status
--porcelain -uall`, `diff --name-status <base>`, `ls-files --others
--exclude-standard`, `diff <rev> --unified=3 --no-color -- <path>`,
`merge-base <commit> HEAD` — all local operations, no network, no hooks. The
orchestrator image gains the `git` package.

One migration beyond the storage change: `review_base` (the resolved base
commit and the rev as given) and `review_root` columns on `sessions`.
Annotations live in the file.

Freshness is polling in v1: the review view polls `review/status` every 5 s
while the tab is visible — the pattern the session list already uses — and
refetches tree/file/annotations only when a fingerprint moved, running drift
on that transition. With the files local this costs three hashes, not three
execs. The desktop tool's push model becomes an honest later stage: fs
watching works on a directory the orchestrator can see, and a
`/ws/sessions/:id/review` upgrade path beside the ACP gateway (same bearer
subprotocol) can replace the poll without touching the gateway. Nothing below
depends on it.

## Security

The boundary shift is deliberate and accepted: the orchestrator — which holds
the Docker socket — now reads an agent-controlled tree and runs git over it.
The mount adds no privilege it lacks; what it adds is exposure of that
process to hostile *content*. Two invariants keep that exposure bounded, and
both live in exactly one file each so they stay reviewable:

- **Symlink containment, in `review/fs.ts`.** Every client-supplied path is
  resolved with `realpath` and must land under the review root's own
  realpath; the final component is `lstat`ed and a symlink is refused. That
  contains the obvious attack — `ln -s /data x` in the workspace serving the
  deployment's secrets through the file endpoint. A determined agent racing
  the check against the open remains theoretically possible (Node exposes no
  race-free beneath-only open); accepted, documented in the code, and the
  reads still run with this process's own file descriptors only — no shell.
- **Git hardening, in `review/git.ts`.** Repo-local config can execute
  commands on exactly the operations review runs (`core.fsmonitor` on
  status; external diff drivers, `textconv` and filters on diff). Every git
  process therefore gets a fixed argv prefix and a scrubbed env from one
  builder: `GIT_CONFIG_NOSYSTEM=1`, `HOME` pointed at an empty directory (no
  global config), `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
  `safe.directory` for the root, `-c core.fsmonitor=false`, and diff run
  with `--no-ext-diff --no-textconv`. A unit test asserts the flag set, so
  removing one is a visible act.

The rest is the ordinary hygiene the exec design needed too:

- Paths validated against the tree before use; escape attempts 404 like an
  unknown session.
- Output caps per endpoint (file reads 2 MiB then `truncated: true`; binary
  sniffed by NUL byte and refused with `binary: true`).
- File content and comments are agent-influenced and hostile by assumption:
  the frontend renders them as text nodes only — highlight tokens become
  React elements, never `dangerouslySetInnerHTML`. Comments render as plain
  text in v1.
- The endpoints sit under `/api` behind whatever authenticates it, and
  change nothing about the reverse-proxy contract.

## Frontend

### Route and entry

`/sessions/:id/review`, with the open file in the search string
(`?path=src/app.ts`) so a file is linkable and back-button works. Entry
points: a Review action in the thread header next to Fork, and on the session
card — where it works whether or not the box is running. The view owns the
whole viewport like the thread view does.

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
  instead (v1; push is an additive later stage, and genuinely possible now).
- **The hover scrollbar minimap** — replaced by prev/next navigation.
- **Graceful shutdown closing the tab** — meaningless here; the view is a
  route, not an app.
- **The comment sidebar** — inline comments on all sizes.
- **Chroma server-side HTML** — Shiki tokens client-side.

## Stages

Each lands green and shippable on its own.

1. **Workspace storage.** Bind-mounted workspace directories: the host-path
   resolution at boot, create/delete, the `workspace_dir` migration, the
   legacy copy-and-recreate on start, smoke-test assertions. Proves the
   Docker Desktop bind assumption first. No review code yet — this stage is
   also just a better storage story (a session's files become inspectable on
   the host).
2. **Pure ports + I/O layer.** `review/{store,gitstatus,difflines,tree}.ts`
   with the Go tests' tables ported (round-trip fixtures asserted
   byte-for-byte against files the Go tool wrote); `fs.ts` containment and
   atomic writes; `git.ts` with the hardened invocation builder and its
   flag-set test; git added to the orchestrator image.
3. **REST surface.** `service.ts`, the seven routes, `shared/types.ts`
   shapes, the `review_base`/`review_root` migration, `app.test.ts` coverage
   driving the real routes over a temp-directory workspace with a real git
   repo — no Docker needed, which is the payoff of stage 1 for tests too.
4. **Read-only viewer.** Route, entry points, tree (desktop column + mobile
   sheet), file view with Shiki tokens, git status colours, diff gutter
   markers, hunk sheet, prev/next navigation. Usable as a browse-the-
   workspace feature by itself, stopped sessions included.
5. **Commenting.** Composer (inline / bottom sheet), annotation CRUD against
   REVIEW.md, inline comment cards, comment badges in tree and toolbar, "New
   review", "Hand to agent".
6. **Base revision + drift.** Base picker in the header (status bar shows the
   active base, as the desktop tool does), `statusesSince` behaviour, drift
   check on fetch and on fingerprint change, `(outdated)` rendering.
7. **Polish and the browser suite.** Review pages in the dashboard e2e suite
   against a stub orchestrator serving canned review responses (tree → open →
   comment → REVIEW.md write asserted, on desktop and mobile viewports);
   optional fs-watcher + WS push and overview rail if polling proves laggy.

## Risks and open ends

- **The bind assumption.** Binding a subdirectory of a named volume's
  daemon-side path is the one Docker behaviour this leans on; verified on
  Linux and Docker Desktop before anything is built on it (stage 1). If
  Docker Desktop refuses it, the fallback is compose mounting a real host
  directory for `/data` — a README-visible change, not a redesign.
- **Symlink containment and git hardening are invariants, not one-time
  fixes.** Each lives in one file with a test; the accepted residual (the
  realpath TOCTOU race) is documented where the check lives.
- **Adapter and reviewer writing REVIEW.md concurrently.** Hash-guarded
  read-modify-write with one retry keeps it honest; a lost race costs one
  visible refresh, not data, because every write re-serializes the whole
  parsed file.
- **Legacy migration.** Copy-and-recreate on start is the risky moment for
  existing deployments; it runs only on stopped containers, copies before it
  recreates, and deletes the volume only after the new container started.
- **Ownership drift.** Everything review writes is chowned to uid 1000; the
  uid is a named constant beside the bind template, with the comment
  pointing at the session image's user.
- **Huge workspaces.** Tree capped (~20k entries, then a "tree truncated"
  notice); `git ls-files` does the heavy lifting where there is a repo; the
  desktop tool's ignore lists (node_modules, dist, binaries…) port as-is.
- **Shiki bundle weight.** Grammars and engine lazy-loaded; the thread view's
  bundle must not grow. Verified in stage 4 by the build's chunk report.
- **A session with no git.** Everything degrades to tree + read + comment,
  statuses and diffs empty — same as the desktop tool outside a repo.
