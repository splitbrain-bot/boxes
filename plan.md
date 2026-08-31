# Threads in parallel

Last modified: 2026-08-31
Repo state: implemented on top of commit `0ad8a8b`.

## Where the last change left this

A Boxes session owns several threads. One is current at a time: the session
row names it, the gateway answers every browser's `session/new` with it, and
switching is a REST call that drops the attached browsers so each reconnects
onto the new one.

That was the deliberately small version. Its own design note said the
alternative — a thread id in the WebSocket URL, so two browsers could watch
two threads of one session at once — stayed possible later and was blocked by
nothing. This is that change.

## What is wanted

One thread keeps working while you use another to explore. The concrete
motion: you are in a thread that is doing something long, you fork it, and you
ask the fork questions about what it is doing without stopping it or losing
your place. Two tabs, two conversations, one box.

That is a narrower requirement than parallelism in general, and it is the
benign case. A thread that reads and answers does not fight the working thread
over the checkout the way two threads both editing would. It is still one
workspace, so the risk is real but bounded; see the risks.

## What has to be true for it to work

**The wire already allows it.** The ACP SDK keys pending responses by
JSON-RPC id (`jsonrpc.js`, `prepareRequest`) with no write queue, so two
`session/prompt` calls naming different threads can be in flight on the one
adapter connection. Nothing in the transport serialises them.

**Whether the adapter allows it is unverified.** `claude-agent-acp` holds
every thread of a session in one process, and it may serve two prompts
concurrently or it may queue the second behind the first. Nothing here has
tested that, and it decides how much of this plan is worth building. It is
step 0.

If the adapter turns out to queue, the feature is still worth having — the
explorer's answer arrives after the working turn's next pause rather than
during it — but the UI must not claim otherwise, and that is a different
promise from the one above. Find out before building the rest.

## The design decisions

### 1. A connection is pinned to one thread, and the thread is in the URL

`/ws/sessions/:id/threads/:threadId/acp` is a connection to that thread.
`/ws/sessions/:id/acp` keeps working and means whichever thread is current.

The second half is what makes this cheap. An external ACP client's contract
does not change at all: it connects where it always did and gets the session's
current thread, exactly as today. Only the dashboard learns the longer path.

It also means the browser barely changes. `AcpClient` already sends
`session/new` and takes back an id it does not choose; pinning happens in the
gateway, so the store, the translation layer and the assistant-ui mounting are
untouched. What changes is `wsUrlFor` and which route mounts the view.

### 2. Everything session-wide in `Broadcast` becomes keyed by thread

`Broadcast` holds three pieces of session-wide state, and each has a
thread-scoped meaning that is the same rule in a smaller scope:

| Now | Becomes |
|---|---|
| the set of attached browsers | the set of browsers, each recording which thread it watches |
| `replayTargets`, a set of handles | replay targets per thread |
| `echoingPrompts`, one counter | one counter per thread |

An update is routed by its own `sessionId`, which every `session/update`
carries. The two rules the class exists for survive verbatim, one thread at a
time: a replay goes only to the browser that asked for it, and a prompt the
gateway has echoed is not echoed twice. What is fixed is that a replay of one
thread no longer silences another thread's live updates, which is exactly the
bug you would hit first with two tabs open.

This is the part the previous plan called the hardest to get right, and it is
also the part that needs no Docker to test. `broadcast.test.ts` should carry
the weight.

### 3. `current_thread_id` survives, as the default rather than the truth

It stops being what every connection gets and becomes what a connection that
does not name a thread gets: `/sessions/:id`, `/ws/sessions/:id/acp`, an
external client, a bookmark from before this change.

One consequence is worth stating plainly: **switching threads stops dropping
browsers.** Selecting a thread now only moves a default, and no live
connection is pinned to it, so the reconnect flicker the last plan listed as a
visible cost disappears. `switchThread` loses its `dropDownstreams()` call and
becomes an ordinary write.

### 4. A fork starts in `plan` mode, not `auto`

The explorer thread shares the working thread's checkout. If a question makes
it decide to edit a file, it collides with the thread that is mid-turn, and
neither agent can see the other doing it.

The default-mode step already runs on exactly one thread — the one the adapter
has just minted — so a fork can be given `plan` where a fresh thread is given
`auto`, at the cost of one parameter. That does not solve the shared
workspace, it just stops the common accident. Flipping the fork to `auto` is
one tap in the header the user already has, and then it is their decision
rather than a surprise.

## Steps

### 0. Find out whether the adapter runs two turns at once

Before any of the below. In a real session container, against the pinned
adapter: mint two threads, start a long prompt on the first, and prompt the
second while the first is still streaming. Watch whether the second's updates
interleave or only begin after the first's `stopReason`.

Record the answer in this file. If it queues, stop and re-scope: the gateway
work below is still correct, but step 8's UI must say "queued behind the other
thread" rather than implying two turns run at once, and the payoff is smaller
than this plan assumes.

**Not run, and still unanswered.** The environment this was implemented in has
no Docker daemon and no Claude token, so there was no real session container
to put the question to, and there is no way to answer it short of one — a
stand-in adapter would only report what the stand-in was written to do.

What was built instead is the half the answer does not change. Everything in
steps 1–7 is correct either way: routing an update to the thread it names,
recording a turn against the thread it runs on, asking the browser watching the
thread that asked, and reloading every watched thread on a respawn are all
right whether the adapter interleaves two turns or queues the second. And step
8's UI was written to claim nothing about it: the per-thread badges report what
a thread *is* doing, which is true under either answer, and no copy anywhere
promises that two turns run at once.

What is still owed, once a real deployment can run the experiment: if the
adapter interleaves, this is done as written. If it queues, the explorer's
answer arrives after the working turn's next pause rather than during it, and
the thread view should say so — a queued-behind-another-thread note in the
composer's place, driven by the session's other threads' `turnActive`, which
the API already reports per thread. That is a small addition on top of what is
here, not a change to it.

### 1. Gateway: a connection names its thread

`orchestrator/src/index.ts` — the upgrade path regex `WS_PATH` gains a second
shape capturing an optional thread id. Reject an upgrade naming a thread that
does not belong to the session, at the handshake, the way an unknown session
is already rejected: a 404 before a WebSocket exists.

`downstream.ts` — `attachDownstream(ws, sessionId, threadId | null, manager)`.
The handle records the ACP thread it is for, resolved once at attach: the
named thread's `acp_session_id`, or the current thread's when none was named.
`session/new` answers with that, rather than with `up.current`.

A thread with no `acp_session_id` — minted but never prompted, and the adapter
restarted since — is the one case needing care. Today the spawn path re-mints
into the row. Keep that, and have attach wait for `ensureStarted` before
resolving the handle's thread, so the id it pins is the live one.

### 2. `Broadcast`: route by thread

As the table in decision 2. `add(handle, acpThreadId)`; `update(params)` reads
`params.sessionId` and delivers only to the handles watching it;
`beginPrompt`/`endPrompt` and `beginReplay`/`endReplay` take the thread they
are about. An update naming a thread nobody watches is dropped rather than
broadcast, which is the honest reading and also what stops a background
thread's stream reaching the wrong tab.

`byRecency` becomes `byRecency(acpThreadId)`, since its only caller is picking
who to put a permission request to.

### 3. Turns: `turn_active` moves onto the thread

`sessions.turn_active` becomes `threads.turn_active`, and the session's
"a turn is running" is derived as any of its threads. Two sources of truth for
whether a turn is running is precisely the thing that goes stale, so the
session column goes rather than being kept in step.

`forwardRequest` already receives the prompt's params, which carry the thread
id, so it knows which row to set. The places that clear it — a deliberate
stop, an adapter exit, a cancel, boot reconciliation — clear every thread of
the session, which is correct: none of those leave a turn running.

The reaper's idle test reads the derived value. Its other three counts
(waiting permission, attached browser, last activity) stay session-scoped;
they are about the box, not the conversation.

### 4. Permissions: to a browser watching the thread that asked

`session/request_permission` params carry the thread id, so
`onPermissionRequest` picks its target from `byRecency(thread)` rather than
from every attached browser. A browser watching another thread is not asked,
and with nobody on that thread the request queues as it does today.

`pending_requests` needs the thread, so `flushPendingTo` gives a browser only
the requests for the thread it is watching. Add the column rather than parsing
it back out of the stored params on every read: the params carry it, but a
query wants a column, and the per-thread pending count is worth having for
step 8's badges. Existing rows need no backfill — `clearStale` drops rows left
by a previous process at boot, so the column can be nullable and unbackfilled.

### 5. Respawn: reload every thread that is being watched

A real gap, and new. Today the spawn path loads the current thread, so an
adapter that dies and comes back has the one thread every browser is on. With
two browsers on two threads, a respawn would load one of them and the other
browser's next prompt would name a thread the adapter has not loaded.

`UpstreamSession` keeps the set of threads its attached browsers are watching
and re-issues `session/load` for each on spawn, the current one included. The
set is derived from the handles, so it needs no storage and shrinks as tabs
close.

The alternative is to drop every socket on a respawn and let each browser's
own handshake re-load its thread. That reuses machinery that already works and
is fewer moving parts, but it turns a recovery the browser cannot currently
see into a visible reconnect. Prefer the reload; fall back to this if the
reload proves awkward.

### 6. Database

Migration 5:

```sql
ALTER TABLE threads ADD COLUMN turn_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_requests ADD COLUMN acp_session_id TEXT;
ALTER TABLE sessions DROP COLUMN turn_active;
```

Nothing needs moving. A turn cannot survive the restart that applies the
migration, so every thread starting at 0 is not a loss of state but the truth.

### 7. Shared types

`ThreadSummary` gains `turnActive` and `pendingCount`. `SessionSummary` keeps
`turnActive` and `pendingCount` as the derived session-wide values, so the
existing badges keep working unchanged and the per-thread ones are additive.

### 8. Dashboard

- `wsUrlFor(sessionId, threadId?)`, and `useThread` takes the thread.
- A route `/sessions/:id/threads/:threadId` mounting the same view.
  `/sessions/:id` stays and means the current thread, so every existing link
  survives.
- The card's thread rows become plain `<Link>`s to the per-thread route. This
  deletes work: opening a thread stops being a REST call followed by a
  navigation. Opening one still selects it as the session's default, but as a
  fire-and-forget POST that neither blocks the navigation nor disturbs
  anything, because no live connection is pinned to the default any more.
- Per-thread badges on those rows: a running turn, a waiting approval. With
  two threads live this is the only place that says which one is busy.
- The thread view names its thread **always**, not only when the session has
  more than one. Two tabs on one session are otherwise indistinguishable,
  which is the whole point of the change.
- **Fork from inside the thread**, which is where the motion actually starts.
  The button posts, then reveals the new thread as a link with
  `target="_blank"`, so the working thread stays where it is and the new tab
  is opened by a real click. A `window.open` after the await is the thing to
  reach for and it is what popup blockers exist to stop; one extra tap is
  cheaper than an unreliable one. This is the least settled part of the plan.

### 9. Tests

`broadcast.test.ts` carries the core, with no Docker and no browser:

- an update for one thread does not reach a browser watching another
- a replay of one thread does not silence another thread's live updates
- a prompt echo reaches only the threads' own watchers
- an update for a thread nobody watches is dropped

`upstream.test.ts`, against the existing stand-in adapter:

- a prompt sets `turn_active` on its own thread and no other
- a permission request goes to a browser watching the asking thread, and
  queues when only another thread's browser is attached
- a respawn re-issues `session/load` for every watched thread

The stub gateway learns that a socket belongs to a thread, taken from the
upgrade path, and addresses its updates accordingly. Browser tests: two tabs
on two threads of one session, a prompt in one leaving the other's transcript
untouched and its composer usable; and the existing "a second tab sees updates
live" test still passing, because two tabs on the *same* thread must still
share everything.

### 10. Documentation

`ARCHITECTURE.md`: the "Several threads per session" section states the
one-current-thread rule and the rejected alternative as settled, and both
change. The gateway's `session/new` bullet, the "Who each update goes to"
section, the schema table and the WebSocket path all move. The section should
end up describing pinned connections with a default, which is a smaller claim
than what it says now.

## What this makes simpler

Worth noting, because it is unusual for a change of this size:

- `switchThread` stops dropping browsers, and the reconnect flicker goes.
- The card's thread rows stop needing a REST call to open.
- `sessions.turn_active` stops being a second source of truth.

## Deliberately not in scope

- **Per-thread workspaces.** The honest fix for two threads editing is a git
  worktree per thread under `/workspace`, which the adapter's
  `additionalDirectories` capability could carry. That is a larger change and
  a different one; this plan makes two threads *watchable* in parallel and
  leans on `plan` mode to keep the explorer out of trouble.
- **Split view.** Two transcripts side by side is a third layout on top of the
  two this adds, and two tabs already answers the desktop case.
- **Per-thread `!bang` history, exec log and debug log.** Those ran in the
  container, not in a conversation. They stay session-scoped and appear under
  every thread, as they do today.
- **Deleting a thread.** Still cheap, still deferred.

## Risks

- **The adapter may queue concurrent prompts.** Step 0 exists to find out
  before anything is built on the assumption. This is the risk that decides
  whether the plan is worth executing as written.
- **One workspace, two agents.** `plan` mode on a fork narrows this to
  deliberate acts; it does not remove it. A user who flips the fork to `auto`
  and edits gets exactly the conflict they asked for, and Boxes will not
  notice on their behalf.
- **`Broadcast` is the load-bearing part.** Every routing rule in it exists
  because broadcasting to everyone was wrong in a way that only showed up with
  two browsers attached. Making it thread-aware risks reintroducing precisely
  those bugs, in a shape the current tests would not catch. Hence the four
  tests in step 9 before anything else in that file changes.
- **A background tab holds an open connection.** Two tabs is two upstream
  attachments per session, so `attachedCount` doubles and the reaper's
  "nobody is watching" test is held off by a tab the user forgot. That is
  already true of two tabs on one thread today; it just becomes the normal
  case rather than the accident.

## Progress

Done, except step 0, which could not be run here — see the note under it, and
the paragraph it ends with for what is still owed.

Steps 1–10 are implemented, and both suites are green: 104 orchestrator tests
and 80 dashboard tests, the browser suite included.

What landed, against the plan:

- **`Broadcast` is keyed by thread** (step 2), and its four new tests were
  written before it changed, as the risk section asked. `replayTargets` became
  a map from thread to the browsers replaying it, `echoingPrompts` a count per
  thread, and `byRecency` takes the thread to ask. An update naming a thread
  nobody watches is dropped.
- **A connection names its thread** (step 1). `WS_PATH` gained the optional
  `/threads/:threadId` shape, and a path naming another session's thread is a
  404 at the handshake. Which thread a connection is on is settled once, at
  attach, after `ensureStarted` — and a thread whose row has no
  `acp_session_id` gets one minted into it there, which covers the
  minted-never-prompted case for every thread rather than only the current one.
- **`turn_active` moved onto the thread** (steps 3, 6), with the session's
  answer derived from its threads, and the reaper reading the derived value.
- **Permissions go to a browser watching the asking thread** (step 4), with
  `pending_requests.acp_session_id` carrying the thread and per-thread counts
  feeding step 8's badges.
- **A respawn reloads every watched thread** (step 5). The reload was preferred
  over dropping every socket, as the plan said; the fallback is used only for
  the narrow case it is right for — a watched thread the adapter cannot bring
  back, whose browsers are holding an id it would now reject.
- **The dashboard** (step 8) has the per-thread route, thread rows as plain
  links with per-thread badges, a thread that always names itself, and Fork
  inside the thread revealing a `target="_blank"` link.

Three deliberate departures, each small:

- **A cancel clears only its own thread**, not every thread of the session.
  Step 3 grouped a cancel with the stop, exit and boot cases as "clear every
  thread ... none of those leave a turn running", which stopped being true the
  moment threads run in parallel: cancelling one thread says nothing about
  another that is mid-turn. The other three still clear every thread.
- **Adding a thread stops dropping browsers too**, not only switching. Step 3
  called out `switchThread`; `newThread` and `forkThread` dropped browsers for
  the same reason, and step 8's fork-from-inside-the-thread requires that the
  thread you forked from stays exactly where it is. With nothing left dropping
  every socket, `dropDownstreams` became `dropWatchers(thread)`, whose only
  caller is the respawn case above.
- **`Broadcast.add` did not gain the thread as a parameter.** The thread is a
  field on the handle instead, mutable until the pin settles, because the
  handle has to be counted as attached from the moment its socket opens — the
  reaper counts it — while its thread cannot be known until the adapter
  answers. A handle with no thread yet receives nothing, which is right: it
  has not asked for anything either. `UpstreamSession` reads the same field to
  derive the watched-thread set for a respawn.

Also carried through: `ARCHITECTURE.md` and `README.md` both describe pinned
connections with a default, and the info view now returns to the exact thread
it was opened from rather than to whichever one is current.
