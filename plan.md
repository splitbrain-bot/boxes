# Several threads per session

Last modified: 2026-08-30 23:24
Repo state: commit `2f60238`, plus the uncommitted model-dropdown and
missing-token-warning work in the working tree.

## What Boxes is, and how a conversation works today

Boxes runs AI coding-agent sessions in isolated Docker containers and gives
you a web UI to drive them. One session is one long-lived container with two
volumes: `/workspace`, which holds the agent's work, and `/home/agent`, which
holds the agent's own state, including the transcripts of its conversations.

The orchestrator, not the browser, is the agent's client of record. It keeps
one persistent connection per session to an Agent Client Protocol (ACP)
adapter running inside the container, spawned as a long-lived `docker exec` of
`claude-agent-acp`. That connection outlives any browser, which is why a turn
finishes while your phone is locked.

In ACP, one conversation is called a *session*. This document calls it a
**thread**, to keep it apart from a Boxes session.

A Boxes session has exactly one thread, and that is the limitation this plan
removes. It shows up in three places:

- `sessions.acp_session_id` is a single column in SQLite.
- When the orchestrator spawns the adapter it either replays the stored thread
  with `session/load`, or, when there is none, mints one with `session/new`.
  A fresh thread is then put into `auto` mode and on the Opus model.
- The browser runs its own ACP handshake over `/ws/sessions/:id/acp`:
  `initialize`, then `session/new`, then `session/load` when the answer to
  `session/new` carried no modes. The gateway answers `session/new` with the
  session's existing thread id. That is deliberate: without it, every browser
  reconnect would start a second conversation.

Every update the adapter sends is broadcast to every attached browser.

## The problem

There is no way to start a fresh conversation against a workspace an agent has
already prepared. Today the only way to clear the context is to delete the
session, which also deletes the workspace, or to run `/compact`, which
summarises rather than resets.

Two things are wanted, and they are different:

- **New thread** — a fresh, empty context on the same workspace.
- **Fork** — a second thread that starts from an existing one's context, so
  you can branch an investigation without disturbing the original.

## What the adapter already gives us

All of this was checked against the pinned adapter,
`@agentclientprotocol/claude-agent-acp@0.70.0`, running in a real session
container.

- Its `initialize` answer advertises `loadSession: true` and
  `sessionCapabilities: { additionalDirectories, close, delete, fork, list,
  resume }`.
- `session/new` with `cwd: /workspace` mints a fresh thread on the same
  workspace. This is the "new thread" case exactly.
- `session/fork` takes the source thread's id and returns a new thread
  carrying that thread's context. Its answer carries `modes` and
  `configOptions`, the same as `session/new`.
- `session/list` filtered by `cwd` returns only threads that have a transcript
  on disk. A thread that has been minted but never prompted does not appear —
  confirmed by a live call that returned an empty list. So the adapter cannot
  be the source of truth for which threads exist; Boxes has to keep its own
  record.
- `session_info_update` carries a title the agent SDK generates. The adapter
  pushes it at the end of each turn. That gives a thread a real name for free
  once it has been used.
- The gateway already forwards `session/new`, `session/fork`, `session/list`,
  `session/resume`, `session/close` and `session/delete` to the adapter, so no
  new forwarding is needed.

One route is closed. The Claude Code commands `/new` and `/fork` are handled
by the Claude Code terminal, not by the agent. The adapter's command list has
41 entries — `model`, `compact`, `context`, `agents`, `effort`, `rename`,
`recap` among them — and none of `new`, `fork`, `clear` or `resume`. Sending
those as prompts would do nothing, however they are typed.

## The goal

A Boxes session owns several threads. The list shows each session with its
threads under it. Opening a thread opens that conversation. Two buttons make
new ones: one starts fresh, one forks the thread you are on. Everything else
about the session — the container, both volumes, the network, the egress
policy — is shared, so an extra thread costs nothing.

## The design decision to make first

**One thread is current at a time, per session.**

The session row records which thread is current. The gateway keeps answering
the browser's `session/new` with that thread's id, so the ACP contract the
browser and any external ACP client speak does not change at all. Switching
threads is a REST call followed by the browser reconnecting, which is a path
that already exists and is already tested: the client reconnects with a
backoff, and `onResetThread` throws away the old model before the replay
rebuilds it.

The alternative was to put a thread id in the WebSocket URL, so two browsers
could watch two threads of one session at once. That is rejected here. It
would mean `UpstreamSession` holding several live threads on one adapter
connection and `Broadcast` routing every update by thread id, which is a much
larger change to the part of the system that is hardest to get right. It stays
possible later; nothing in this plan blocks it.

## Steps

### 1. Database

Add migration 4 to `orchestrator/src/db.ts`. Migrations are plain SQL strings
applied in order and tracked by `user_version`; migration 3 already uses
`ALTER TABLE ... DROP COLUMN`, so that is available.

```sql
CREATE TABLE threads (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  acp_session_id TEXT,
  title          TEXT,
  ordinal        INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX idx_threads_session ON threads(session_id, ordinal);
ALTER TABLE sessions ADD COLUMN current_thread_id TEXT;
```

Then move the existing data: for every session that has an
`acp_session_id`, insert one thread row with `ordinal` 1 and make it current.
A session whose `acp_session_id` is null gets no row; the orchestrator mints
one on the next spawn, exactly as it does today. Finally drop
`sessions.acp_session_id`.

`ordinal` is what an unnamed thread is called — "Thread 1", "Thread 2" — until
the adapter supplies a title. It is per session and never reused.

### 2. `UpstreamSession` (`orchestrator/src/gateway/upstream.ts`)

Everywhere the class reads or writes `sessions.acp_session_id`, it reads or
writes the current thread's row instead. The spawn path keeps its shape: load
the current thread, and mint one when there is none.

Three new operations:

- `newThread()` — send `session/new`, insert a thread row, make it current,
  and apply the default mode and model. The default-mode and default-model
  steps already exist and already run only on a freshly minted thread, which
  is the correct rule here too.
- `forkThread(sourceThreadId)` — the same, with `session/fork` and the source
  thread's ACP id. The fork answer carries `modes` and `configOptions`, so the
  same two default steps apply unchanged.
- `switchThread(threadId)` — record the new current thread, then drop every
  attached browser. Each reconnects on its own and lands on the new thread.

One existing behaviour needs care. When the adapter reports that a stored
thread is gone — a thread minted but never prompted does not survive the
adapter restarting — the code today clears `sessions.acp_session_id`. It must
now clear only that thread's row, and leave the session's other threads alone.

Record the title too: when a `session_info_update` arrives carrying one, write
it to the current thread's row.

### 3. REST API (`orchestrator/src/app.ts`)

- `GET /api/sessions/:id/threads` — every thread of a session.
- `POST /api/sessions/:id/threads` with an optional `{ "from": "<threadId>" }`
  — no `from` means a fresh thread, a `from` means fork that one. Answers with
  the new thread, which is now current.
- `POST /api/sessions/:id/threads/:threadId/select` — make one current.

Offer forking only when the adapter advertised `sessionCapabilities.fork` in
its `initialize` answer, which the orchestrator already caches verbatim. The
capability is marked unstable in the ACP schema, so the UI must cope with it
being absent.

### 4. Shared types (`shared/types.ts`)

Add a `ThreadSummary` — id, ACP id, title, ordinal, created and last-active
timestamps — and carry `threads` plus `currentThreadId` on `SessionSummary`,
so the list can draw the tree from the poll it already makes. `SessionDetail`
inherits both. Add a flag saying whether forking is offered.

### 5. Dashboard

- `SessionCard` grows a list of the session's threads under its badges: the
  current one marked, each row opening that thread. This is the tree.
- Two actions on the card: **New thread** and **Fork**, the second shown only
  when the adapter offers it. Both call the REST endpoint and then open the
  session.
- Opening a thread that is not current is a select call followed by
  navigation.
- The thread view needs to say which thread it is on. The header is already
  full at phone width with the mode and model selects, so this belongs on the
  existing name line — the session name, then the thread's title or its
  ordinal, truncated.

### 6. Tests

- `dashboard/e2e/stub-gateway.ts` learns `session/fork` and answers
  `session/new` with a distinct thread id each time, so a switch is
  observable.
- `dashboard/e2e/stub-orchestrator.ts` learns the three thread routes.
- Browser tests: a new thread starts empty, a fork carries the earlier
  messages, and switching back returns to the first thread's transcript.
- Orchestrator tests: the migration moves an existing `acp_session_id` into a
  thread row, and a missing thread clears only its own row.

### 7. Documentation

`ARCHITECTURE.md` describes one thread per session in several places,
including the gateway section and the SQLite schema. Update those, and the
REST table.

## Deliberately not in scope

- **Deleting a thread.** The adapter supports `session/delete`, so this is
  cheap to add later. It is left out to keep the first change reviewable.
- **Two browsers on two threads of one session at once.** See the design
  decision above.
- **Renaming a thread by hand.** The adapter generates titles.
- **Splitting the `!bang` command history per thread.** Those commands ran in
  the container, not in a conversation, so they stay session-scoped and appear
  under every thread. Permission requests, the running-turn flag and the debug
  log stay session-scoped for the same reason.

## Risks

- `session/fork` is marked unstable in the ACP schema and may change or be
  withdrawn. Gating it on the advertised capability keeps that from breaking
  the build.
- Switching threads closes the browser's socket, so the header shows
  "reconnecting" for a moment. This is honest but visible.
- A thread minted and never prompted disappears when the adapter restarts.
  That is true today and already handled; the plan only narrows the handling
  to one thread.

## Progress

Not started.
