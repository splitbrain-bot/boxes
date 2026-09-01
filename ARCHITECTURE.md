# Architecture

Boxes runs AI coding-agent sessions in isolated Docker containers and lets a
browser drive them over the Agent Client Protocol (ACP). One orchestrator
process owns everything: the REST API, the web assets, the agent connections,
the container lifecycle and the database.

This document describes how the system is put together. [`README.md`](./README.md)
covers running it and the risks that come with it.

## The property everything else serves

**A running agent turn continues when the browser disconnects.**

The orchestrator, not the browser, is the ACP client of record. It holds one
persistent stdio connection per session to the `claude-agent-acp` adapter
inside the session container. Browsers attach and detach as views, and nothing
a browser does reaches the adapter except the messages the gateway forwards.

Two consequences shape the rest of the design:

- The agent connection outlives any browser, so a long-lived process has to own
  it and be able to rebuild it without losing the thread.
- Thread history is replayed by the adapter's own `session/load` from the
  session's home volume, so the orchestrator stores no transcript of its own.

A session owns several *threads* — ACP calls one conversation a session, and
this document calls it a thread to keep it apart from a Boxes session. The
container, the workspace, the home volume, the network and the egress policy
are the session's and are shared, so a second thread costs nothing but its own
transcript. Each
connection is pinned to one thread, so two of them can be watched at once; see
[Several threads per session](#several-threads-per-session).

## Processes

```
                        phone or desktop browser
                                  │ https / wss
                    ┌─────────────▼─────────────┐
                    │  any reverse proxy        │  TLS and authentication,
                    │  (optional)               │  except on /ws
                    └─────────────┬─────────────┘
              ┌───────────────────▼───────────────────┐
              │            orchestrator               │
              │  /  dashboard   /api  REST            │
              │                 /ws   ACP gateway     │
              │                                       │
              │  SQLite · reaper · Docker client      │
              └───┬───────────────────────────────┬───┘
                  │ /var/run/docker.sock          │ docker exec, stdio
                  │      ▲ policy push (compose network, bearer)
   ┌──────────────▼──────┴───────┐                │
   │       egress proxy          │                │
   │  attached to every session  │                │
   │  network under the alias    │                │
   │  "proxy"; holds the policy  │                │
   │  and the credentials in     │                │
   │  memory, nothing at rest    │                │
   └──────┬───────────────┬──────┘                │
          │               │                       │
   ┌──────▼───────┐ ┌─────▼────────┐              │
   │ session-a1b2 │ │ session-c3d4 │◄─────────────┘
   │ net sn-a1b2  │ │ net sn-c3d4  │  claude-agent-acp runs as a
   │ (internal)   │ │ (internal)   │  long-lived exec, not as PID 1
   └──────────────┘ └──────────────┘
```

| Process | Built from | Role |
|---|---|---|
| orchestrator | `orchestrator/Dockerfile` | Serves every route, owns the sessions, holds the Docker socket |
| egress proxy | `proxy/Dockerfile` | The only route out of a session network, and where credentials are put on the wire |
| session container | `session-image/Dockerfile` | Runs the agent and the ACP adapter, one container per session |

The orchestrator and the proxy are compose services. Session containers are
created at runtime through the Docker API, so they appear in no compose file.

That makes the session image the orchestrator's to keep, not compose's: it
pulls `SESSION_IMAGE` when it is missing and again every
`SESSION_IMAGE_PULL_MINUTES`, and a session moves onto what arrived the next
time it is *started* — never while it runs, where recreating the container
would kill the adapter exec mid-turn. Recreating is otherwise cheap and is how
a session container changes anything about itself: the rootfs is read-only and
everything durable is in the two mounts, so the workspace and the thread
history come across untouched. For the same reason nothing outside the
orchestrator may recreate one — the container id in the database and the
runtime proxy attachment would both be lost — so the template carries
`com.centurylinklabs.watchtower.enable=false`.

`compose.yaml` publishes one port, on loopback, and names no reverse proxy:
what sits in front is a deployment decision, not part of the system. The one
constraint it places on that decision is that `/ws` must not be behind HTTP
authentication — see below.

## One origin, one port

The orchestrator serves everything a browser needs:

| Path | Handler |
|---|---|
| `/` | Dashboard bundle, with a single-page fallback |
| `/api/...` | REST |
| `/ws/sessions/:id/acp` | ACP gateway |
| `/healthz` | Version, session count, proxy warnings and whether a Claude token is configured |

A GET that matches no route falls back to the dashboard's `index.html`, so
client-side routes survive a reload. Anything under `/api` or `/ws` gets a
404 instead.

The dashboard is the only frontend, and it is served from the orchestrator's
own image. Two things follow:

- The browser derives the WebSocket URL from its own location, so no
  deployment setting can make it wrong and the API carries no endpoint URL.
- The whole stack runs behind one published port, with no reverse proxy.

## REST API

`orchestrator/src/app.ts` defines the routes; `SessionManager` does the work.
Request and response shapes live in `shared/types.ts`, which both the
orchestrator handlers and the dashboard's `api.ts` import.

| Method and path | Does |
|---|---|
| `GET /api/sessions` | Summaries of every live session |
| `POST /api/sessions` | Creates a session and returns it |
| `GET /api/sessions/:id` | One session with its Docker object names |
| `POST /api/sessions/:id/start` | Starts a stopped container |
| `POST /api/sessions/:id/stop` | Stops the container and drops the upstream |
| `DELETE /api/sessions/:id` | Deletes the session, its workspace and home volume included |
| `GET /api/sessions/:id/threads` | Every conversation the session owns |
| `POST /api/sessions/:id/threads` | Adds one and makes it the session's default; `{"from":"<threadId>"}` forks that one instead of starting empty |
| `POST /api/sessions/:id/threads/:threadId/select` | Makes one the session's default |
| `GET /api/sessions/:id/log?after=&limit=` | A page of tapped ACP messages |
| `POST /api/sessions/:id/exec` | Runs one command in the container, streaming its output |
| `GET /api/sessions/:id/exec` | Commands already run in this session |
| `GET /api/sessions/:id/review/tree` | Tree, git status per path, comment counts, the resolved root and base — the whole left panel |
| `GET /api/sessions/:id/review/file?path=` | Content, diff markers and comments — the whole file view |
| `PUT /api/sessions/:id/review/annotations` | Creates or replaces one line's comment |
| `DELETE /api/sessions/:id/review/annotations?path=&line=` | Deletes one comment |
| `GET /api/sessions/:id/review/status` | The poll fingerprint: three cheap local hashes |
| `PUT /api/sessions/:id/review/base` | Sets the revision the review is compared against, or clears it |
| `DELETE /api/sessions/:id/review` | Deletes `REVIEW.md` — "New review" |
| `GET /api/agent-sets` | Every agent set, the global one first |
| `POST /api/agent-sets` | Adds a set |
| `GET /api/agent-sets/:setId` | One set with its `AGENTS.md`, skills and commands |
| `PATCH /api/agent-sets/:setId` | Renames a set, or replaces its `AGENTS.md` |
| `DELETE /api/agent-sets/:setId` | Deletes a set. The global one is refused |
| `PUT /api/agent-sets/:setId/items` | Creates a skill or command, or replaces the one under that name |
| `DELETE /api/agent-sets/:setId/items?kind=&name=` | Deletes one |
| `GET /api/agent-sets/:setId/preview` | What a session naming this set would get, global set merged in |
| `GET /api/push/key` | The deployment's VAPID public key, which a browser subscribes with |
| `POST /api/push/subscribe` | Registers a browser for Web Push, or refreshes what is stored for it |
| `DELETE /api/push/subscribe` | Forgets one browser's subscription |

The API carries no authentication of its own; a reverse proxy is expected to
provide it for `/` and `/api`, and the published port binds to loopback so
that an unproxied deployment is not an exposed one. `/ws` is the exception in
both directions: it must *not* be behind HTTP authentication, because a
browser cannot attach Basic credentials to a WebSocket upgrade, and it does
not need to be, because the gateway authenticates the upgrade itself.

### Local commands

A composer line starting with `!` is a local command: the dashboard
intercepts it, so it never reaches the model, costs no tokens, and cannot be
read as an instruction.

`exec.ts` runs it as `bash -lc <command>` inside the session container, as the
non-root `agent` user, in the container's existing isolation — internal
network, read-only rootfs, capabilities dropped. No new privilege is
introduced, and nothing shell-executes on the host: the command travels as an
argument to the container's own shell and never reaches a host command line.

The response is chunked `text/plain` rather than JSON, so the browser can
render the output as it arrives, and ends with a trailer line carrying the
exit code and whether either limit was hit. Both limits are enforced by the
orchestrator rather than trusted to the container: 120 seconds of wall clock
and 256 KiB of output, after which the exec is killed. Finished runs go into
`exec_log`, ring-pruned per session.

The browser writes the output straight into the thread as a code block, which
grows as the chunks arrive. Output is what the command was run for, so it is
shown rather than folded away behind a tool call that has to be opened first.
The fence is grown past the longest run of backticks in the output, so output
carrying a fence of its own cannot break out of the block.

The browser appends stored runs *after* whatever the replay produced rather
than interleaving them. ACP replay carries no timestamps, so where they belong
in the transcript is not recoverable.

## The frontend

One React app, served at `/`. The session list is the thread list: a thread is
`/sessions/:id/threads/:threadId`, and `/sessions/:id` is whichever thread the
session has current — so every older link and bookmark still works. The ops
that used to share that page — start, stop, delete, the details, the
connection fields for an external ACP client — live at `/sessions/:id/info`.
What the agent is configured with belongs to the deployment rather than to any
one box, so it hangs off the list instead: `/agents` lists the sets and
`/agents/:setId` edits one.

Each card carries its session's threads under its badges, the default one
marked, so the list is the tree. Each row is a plain link to that thread,
because opening one is a plain navigation now: the connection names its own
thread, so nothing has to be switched first. Opening a thread still makes it
the session's default, as a fire-and-forget POST that neither blocks the
navigation nor disturbs anybody. A row carries its own badges — a running
turn, a waiting approval — because with two threads live that is the only
place that says which one is busy. **New thread** and **Fork** sit under them,
the second only when the adapter offers it.

The thread view names which thread it is on beside the session's name,
*always* rather than only when the session has more than one: two tabs on one
session are otherwise indistinguishable, which is the whole point. It also
carries its own **Fork**, because that is where the motion starts — you are in
a thread doing something long and you want a second one to ask about it. The
button posts and then reveals the new thread as a link with `target="_blank"`,
so the working thread stays where it is and the new tab is opened by a real
click. A `window.open` after the await is the thing to reach for, and it is
what popup blockers exist to stop.

The chat itself is [assistant-ui](https://www.assistant-ui.com/). Its
components are installed into `src/components/assistant-ui/` by the official
CLI, in the shadcn distribution model: the sources are committed and are ours
to edit, and an upgrade is a CLI re-run reviewed as a diff rather than a
version bump that changes the UI silently. Six edits are ours so far, each
marked in the source: ArrowUp history on the composer, returning focus after
a send, opening a tool group when a call inside it is waiting on the user,
dropping the add-attachment button because nothing here takes an attachment,
following the bottom of the viewport for output that is not a turn, and the
slash-command list below.

Because those components are written in Tailwind utilities, Tailwind is a
build dependency rather than a style choice, and it compiles from source on
every build. `globals.css` is the whole design system: the tokens, and the
`@theme inline` block bridging them into Tailwind colours. That bridge is a
correctness requirement, not theming polish — Tailwind v4 emits a utility only
for a colour its theme defines, so without it `bg-background` and every other
token utility the installed components use would silently vanish.

The browser speaks plain ACP to the gateway, so it is a client like any other
and the gateway stays client-agnostic. That is not only tidiness: this
dashboard replaced a separate chat application served alongside it, and the
gateway needed no protocol change to swap one for the other. An external ACP
client still attaches to the same endpoint, with the URL and token from
`/sessions/:id/info`.

```
AcpClient    ⇄ …/threads/:threadId/acp  JSON-RPC over one WebSocket, one thread
translate.ts   session/update*       →  an append-only message model (pure)
thread-store   the live thread          messages, modes, models, approvals, exec
convert.ts     that model            →  what useExternalStoreRuntime reads
```

`translate.ts` being pure is what makes replay and live streaming the same
code path: a reconnect repeats the handshake, `session/load` re-sends the
history as ordinary notifications, and folding them rebuilds the thread. An
update kind this build predates is kept and rendered as nothing, so a newer
adapter cannot break an older dashboard.

`available_commands_update` carries the slash commands this agent accepts, and
the composer completes them: a leading `/` opens the list, each further
character narrows it, and picking one writes the command's name into the
composer. It completes rather than sends, because a command often takes
arguments and running it is the agent's job. The list is whatever the adapter
advertises, so it follows the agent rather than this build.

Two behaviours are worth knowing because they look like bugs otherwise. A turn
blocked on a permission request reports itself as *not running* — it is
waiting for the user, and the runtime derives a message's requires-action
status from its unresolved approval only while the thread is idle, so claiming
otherwise would hide the very question holding up the turn. And ACP's
permission vocabulary maps onto assistant-ui's approval vocabulary by rename
alone: `allow_once` to `allow-once`, `optionId`/`name` to `id`/`label`.

## The ACP gateway

Two halves, in `orchestrator/src/gateway/`.

### Upstream: one connection per session

`upstream.ts` holds the connection to the adapter. `SessionManager` creates one
`UpstreamSession` per session on first use and keeps it for the process's life.

Starting it, in `ensureStarted`:

1. Start the container and make sure the egress proxy is attached.
2. Spawn `claude-agent-acp` as a `docker exec` with `Tty: false`. Docker frames
   stdout and stderr into one stream, so the streams are demuxed. stdout
   carries newline-delimited JSON-RPC; stderr is log-only.
3. Send `initialize` with empty client capabilities: no filesystem, no
   terminal, no elicitation. That confines adapter-to-client traffic to
   `session/update` and `session/request_permission`. The response is cached
   verbatim.
4. Replay the session's *default* thread with `session/load`, or, when it has
   none or the adapter no longer holds it, mint one with `session/new` and
   store its id. Then re-issue `session/load` for every other thread an
   attached browser is watching, so a respawn brings back every conversation
   this connection has to carry rather than only one of them. A watched thread
   the adapter cannot bring back has its browsers' sockets closed, because the
   id they hold is one the adapter would now reject; each reconnects and pins
   whatever that thread is next.

A fresh thread is then switched into `auto` mode, when the adapter advertises
a mode by that id — except a fork, which starts in `plan`. A fork shares the
thread it came from's checkout, and the point of one is to ask about work the
original is still doing, so it starts in a mode that reads rather than writes.
That does not fix the shared workspace; it stops the common accident, and
flipping the fork to `auto` is one tap in the header. Only the thread the
adapter has just minted goes through this: from then on the mode is the
user's, and a reconnect must not undo it. An adapter offering no such mode is
left in whichever mode it starts in, and a switch that fails is logged rather
than failing the spawn.

A spawn that fails is retried three times, waiting 1, 3 and 8 seconds. After
that the session's status becomes `error`.

The guard on `ensureStarted` is the cached `initialize` response rather than
the connection object. The connection exists as soon as the exec stream is
wired up, but its handshake takes a few hundred milliseconds, and a browser
arriving inside that window has to wait rather than be told the upstream is
unavailable.

A `session/load` that comes back with `resourceNotFound` is not a failure. The
agent SDK writes a transcript only once a prompt has run, so an id minted by
`session/new` and never prompted does not survive the container stopping. Only
that thread's row loses its adapter id and gets a freshly minted conversation;
the session's other threads have transcripts of their own and are untouched.
Any other error is rethrown, which keeps a transient fault from discarding a
live thread.

When the adapter exits on its own, the connection is torn down and nothing
reconnects immediately. The next forwarded message calls `ensureStarted` again,
which re-spawns and re-issues `session/load`. A deliberate stop sets a flag
that suppresses even that.

### Downstream: one connection per browser

`downstream.ts` speaks ACP as an agent toward browsers. JSON-RPC terminates on
both sides, so each connection runs its own id space and the SDK correlates
request and response within it.

There are two upgrade paths, and each connection is **pinned to one thread**
for its whole life. `/ws/sessions/:id/threads/:threadId/acp` is a connection
to that conversation; `/ws/sessions/:id/acp` names none and means whichever
thread the session has current. The short path is what an external ACP client
and every link from before this existed use, so their contract does not change
at all — only the dashboard learns the longer one. A path naming a thread that
is not the session's is refused at the handshake, as a 404 before a WebSocket
exists, the same way an unknown session is: a connection is pinned for its
whole life, so there is no later point at which to find this out.

The upgrade is authenticated on the handshake. A browser cannot set an
`Authorization` header on a WebSocket, so a client offers the token as a
`bearer.<token>` subprotocol entry alongside `acp.v1`. The gateway compares it
against `WS_AUTH_TOKEN` in constant time and selects `acp.v1` explicitly,
rather than relying on the client to list it first.

Which thread the connection is on is settled once, at attach, and needs the
adapter first: a thread minted and never prompted has no adapter-side
conversation until one is made, and pinning to an id the adapter has forgotten
would leave every prompt on it failing. The handle counts as attached from the
moment the socket opens — that is what the reaper counts — and nothing is
routed to it until its thread is settled.

Three methods are answered or reshaped rather than forwarded:

- `initialize` returns the cached upstream response, so its `_meta` extensions
  reach the browser intact.
- `session/new` returns the ACP id of the thread this connection is pinned to.
  Which thread that is, is decided outside ACP, so a browser or an external
  ACP client speaks the same contract either way: a `session/new` that hands
  back an id the client did not choose.
- `$/ping`, which some ACP clients send every 25 seconds, is dropped before the
  SDK sees it. JSON-RPC forbids replying to a notification. The dashboard
  sends none.

Everything else in `FORWARDED_REQUESTS` and `FORWARDED_NOTIFICATIONS` goes
upstream untouched, `_meta` included. Detaching removes the handle from the
broadcast set and touches nothing else.

### Who each update goes to

`broadcast.ts` decides. Sending every update to every browser is almost
right, and wrong in three places that only appear with more than one attached —
a phone and a desktop watching the same session, or two tabs on two threads of
one box.

**Every rule is scoped to a thread**, because every rule is about one
conversation. A connection is pinned to a thread and each `session/update`
carries the thread it is about, so routing is a lookup rather than a guess.

- **An update goes only to the browsers watching its own thread.** One naming
  a thread nobody is watching is dropped rather than broadcast, which is the
  honest reading and also what stops a background thread's stream reaching the
  wrong tab.
- **A forwarded prompt is echoed to every browser on its thread, the sender
  included.** The adapter is only required to replay a prompt later, not to
  echo it live, so without this the browser that sent it shows nothing until
  its next reload. While the gateway is echoing *that thread*, an adapter that
  *does* echo is suppressed, so either kind of adapter produces exactly one
  copy. Replay is exempt: there the adapter is reading back history the
  gateway never saw.
- **A replay goes only to the browser that asked for it, and silences only its
  own thread.** `session/load` is by definition a re-send of the whole thread,
  so broadcasting it rendered every other open tab's conversation twice — but
  a replay of one thread must not hold back another thread's live updates,
  which is the bug two open tabs hit first.

### Several threads per session

A workspace an agent has already prepared is worth keeping; the context it
built up on the way there is often not. So a Boxes session owns several
threads, and two things make new ones: **New thread** starts an empty one on
the same workspace, and **Fork** branches the one you are on so an
investigation can go two ways without disturbing the original. Everything else
about the session is shared, so an extra thread costs nothing but its own
transcript.

**A connection names its thread, and `current_thread_id` is the default.**
The thread is in the WebSocket URL, so one session's adapter connection
carries every thread anybody is watching and two tabs can hold two
conversations of one box at once. The session row still records a current
thread, but only as what a connection that names none gets — the short
WebSocket path, `/sessions/:id`, an external client, a bookmark from before
this existed. Selecting a thread moves that default and nothing else: no live
connection is pinned to it, so nobody is dropped and nothing reconnects, which
is what makes opening a thread a plain navigation rather than a call.

The motion this exists for: you are in a thread doing something long, you fork
it, and you ask the fork about what it is doing without stopping it or losing
your place. That is narrower than parallelism in general, and it is the benign
case — a thread that reads and answers does not fight the working thread over
the checkout the way two threads both editing would. It is still one
workspace: `plan` mode on a fork narrows that to deliberate acts rather than
removing it, and a user who flips the fork to `auto` and edits gets exactly
the conflict they asked for. A git worktree per thread is the honest fix and a
larger change than this.

Whether the adapter serves two prompts concurrently is not settled here. The
wire allows it — the ACP SDK keys pending responses by JSON-RPC id with no
write queue, so two `session/prompt` calls naming different threads can be in
flight on one connection — but `claude-agent-acp` holds every thread of a
session in one process and may queue the second behind the first. Nothing in
the UI claims otherwise: the per-thread badges report what a thread is doing,
which is true either way.

The adapter is not the source of truth for which threads exist. `session/list`
returns only threads that have a transcript on disk, and a thread minted but
never prompted has none, so Boxes keeps its own record in the `threads` table.
A thread goes by the title the agent generates — the adapter pushes it as a
`session_info_update` at the end of a turn, and it is written to the row the
update's own ACP id names — and until then by its ordinal, which is per
session and never reused.

Forking is offered only when the adapter advertised
`sessionCapabilities.fork` in its `initialize` answer, which the orchestrator
already caches verbatim. The capability is marked unstable in the ACP schema,
so an adapter that drops it costs the dashboard a button rather than a build.

A running turn and a waiting permission request belong to the thread, not the
session. `threads.turn_active` records the first, and the session's answer is
derived as any of its threads — two sources of truth for whether a turn is
running is precisely the thing that goes stale. A permission request records
the thread that asked, goes to a browser watching *that* thread, and queues
when only another thread's browser is attached, exactly as it does with none.

Deleting a thread is not implemented, though the adapter supports
`session/delete`. `!bang` command history, the exec log and the debug log stay
session-scoped: those things happened in the container rather than in a
conversation, so they appear under every thread.

### Permission requests

The adapter blocks on `session/request_permission` until it gets an answer,
which is the behaviour Boxes wants: an unattended turn pauses instead of
proceeding without consent.

- The request goes to the most recently active browser **watching the thread
  that asked**. A browser watching another thread is not asked: it is looking
  at a different conversation, and a question about one thread's tool call
  cannot be answered from another's transcript. If that browser vanishes
  mid-question, the request falls back to the queue rather than failing the
  turn.
- With nobody on that thread, the request is stored in `pending_requests`
  against the thread's ACP id and, when `NTFY_URL` is set, a notification is
  posted. The next browser to attach *to that thread* gets its queued requests
  delivered to it, and only those.
- After `PERMISSION_HOLD_MINUTES`, `PERMISSION_FALLBACK` decides. `hold` keeps
  waiting. `deny` answers with a reject option taken from the request's own
  options list, never an invented one, and cancels the request when none is
  offered. Nothing auto-approves.

### Notifications

Two events are worth interrupting somebody for: a permission request has been
queued, and a turn has finished. Both are announced from the gateway through
`notify.ts`, and both are gated on the same condition — **no browser is
watching that thread**. That is not a heuristic about attention, it is the
same test that decides whether a permission request is queued in the first
place, so the two agree about what "you are not here" means. A turn finishing
in front of you is the screen you are already looking at.

The announcement names the conversation, not only the box. With two threads
live, "your session needs you" is not something you can act on from a lock
screen.

`Notifier` fans one event out to two channels and awaits neither of them from
the gateway's side. A turn already waiting on a human must not also wait on a
push service, so every failure inside is logged and swallowed.

- **`NTFY_URL`**, when set: one POST, no other requirement, and it reaches a
  phone with no browser running at all.
- **Web Push** (`push.ts`), to every browser that subscribed: RFC 8291
  `aes128gcm` payload encryption over RFC 8188, authenticated with an RFC 8292
  VAPID assertion. This is what survives the app being closed, which is the
  reason the feature exists.

The crypto is implemented on `node:crypto` rather than taken as a dependency.
It is about a hundred lines, and `push.test.ts` drives it against the RFC's
own published example — matching that byte for byte is worth more than a
round-trip test, because an implementation can be self-consistent and still
produce a body no browser can open.

The VAPID keypair is generated into `DATA_DIR/vapid-keys.json` on first use
and reused from then on, the same shape as the WebSocket token in `secret.ts`
and for the same reason: regenerating it would silently invalidate every
subscription anybody had made. It is generated lazily, so a deployment nobody
subscribes from never writes one.

A subscription is one browser, not one user — Boxes has no accounts, so
whatever authenticates `/api` is what decides who may register. An endpoint
must be `https` and must name a host rather than an address literal, so the
route cannot be used to aim the orchestrator at the LAN it can see. A
subscription the push service answers with 404 or 410 is dropped on the spot:
that is the ordinary end of one, not an error.

Delivery needs two things Boxes cannot provide for itself. The Push API does
not exist on a page served over plain HTTP (`http://localhost` excepted), so
push works on the loopback default and behind a TLS reverse proxy and nowhere
else. And iOS exposes it only to a page added to the Home Screen, which is why
the dashboard ships a manifest and why the toggle tells an uninstalled iPhone
to install rather than that it cannot.

## Session lifecycle

Creating a session, in `SessionManager.create`:

1. Validate the name, and the agent set if one was named.
2. Make sure the session image is on the host, pulling it if it is not. Before
   anything is allocated, so a deployment whose first pull failed gets one
   clear answer rather than a half-created session and a teardown.
3. Generate a session id server-side. User input never reaches a Docker object
   name.
4. Allocate a `/24` out of `SESSION_SUBNET_POOL` and insert the row as
   `creating`.
5. Create the network `sn-<id>`, attach the egress proxy, create the workspace
   directory `${DATA_DIR}/workspaces/<id>`, write the merged agent
   configuration to `${DATA_DIR}/agents/<id>`, create the volume `home-<id>`,
   create the container `session-<id>`, and start it.

Any failed step tears the whole session down and marks it `error`.

The container's `HostConfig` is a fixed template that user input never reaches.
It runs as `SESSION_UID:SESSION_GID` — numbers rather than the image's `agent`,
so one setting decides who a session is. The default is 1020, deliberately off
the 1000 the `ubuntu` base account holds, as does a host's first login user.
The session image builds its `agent` user on the same numbers, because a
session's home is a named volume Docker ownership-initialises from the image
and nothing outside the container can chown it afterwards; `ensureSessionImage`
reads the image's own user back and warns when the two have drifted. Pointing
the orchestrator's own user at `SESSION_UID` is what lets it drop root, since
the workspace chown then has nothing to do.

It runs non-root with `ReadonlyRootfs`, `CapDrop: ALL`,
`no-new-privileges`, a tmpfs `/tmp`, memory, CPU and pids limits, and
`Init: true`. That last one matters: the kernel discards default-disposition
signals for PID 1, so without docker-init the entrypoint's `sleep` would never
see SIGTERM and every stop would wait out the grace period. The only
caller-supplied values are the session id and the profile secrets.

The entrypoint installs the agent configuration into `~/.claude`, sets the git
and gh identity, and then holds the container open.
The adapter is spawned separately by the gateway, so browser churn never
restarts the container. Both run in `/workspace`, which is the session's own
workspace directory and starts empty.

| Status | Means |
|---|---|
| `creating` | The row exists, the Docker objects are being built |
| `running` | The container is up |
| `stopped` | Stopped deliberately, reaped, or found missing at boot |
| `error` | Creation failed, or the adapter would not start |
| `deleted` | Removed. Nothing moves a row out of this state |

Deleting stops and removes the container, detaches the proxy, removes the
network, the workspace directory, the materialized agent configuration and the
home volume, and clears the session's pending requests and log rows. Nothing refers to either once the session is
gone, so they go with it rather than being left orphaned.

At boot, `reconcile` lists containers by the `boxes.session` label and aligns
the stored rows with them: live containers are adopted, missing ones are marked
stopped, and every running session's proxy attachment is re-checked. Turn flags
are cleared, because a turn cannot survive the restart that killed the
connection owning it.

## Where a session's files live

A session's workspace is a directory under the orchestrator's own data
directory — `${DATA_DIR}/workspaces/<id>` — bind-mounted at `/workspace` in
the session container. It used to be the named volume `ws-<id>`, mounted only
into that container, which left the orchestrator with no filesystem path to
the agent's work at all: reaching a file meant a `docker exec`.

The change is what makes reviewing a session's code possible without an exec
round trip per read, without booting a stopped container, and with git run as
an ordinary child process. It grants the orchestrator no privilege it did not
already have — it holds the Docker socket — but it does expose that process to
hostile *content*, which is why the review layer keeps symlink containment and
git hardening as maintained invariants, each in one file with a test.

The home volume stays a named volume. It holds thread transcripts and whatever
credentials a login inside the session created; nothing outside the container
reads it, and review has no business there.

**Naming the bind source.** Bind sources are resolved by the Docker daemon,
not by the process asking for the mount, so the orchestrator cannot hand the
daemon its own `/data/workspaces/<id>`. At boot it identifies its own
container — from `/proc/self/mountinfo`, `/proc/self/cgroup` or
`/etc/hostname`, whichever answers — and takes the `Source` of the mount whose
`Destination` is `DATA_DIR`. With the shipped compose that is
`/var/lib/docker/volumes/boxes-data/_data`, a plain daemon-side directory that
binds the same way on Linux and inside Docker Desktop's VM. Outside a
container the two paths are the same and the inspection is skipped. Where
neither works — a nested or rootless daemon, a compose file mounting a real
host directory — `HOST_DATA_DIR` names it outright. Getting this wrong would
be silent, since the daemon would create an empty directory at the unresolved
path and mount that, so a failure to resolve it is fatal at boot.

**Ownership.** A bind mount, unlike a named volume, is not
ownership-initialised by Docker, so every path the orchestrator creates in a
workspace is chowned to uid 1000 — the session image's `agent` user, named as
a constant in `workspaces.ts`. That is what lets the agent write in its own
workspace, and lets it edit or delete the `REVIEW.md` the review surface
writes there. `workspaces/` itself is 0700: one session's files are not
another's, and the only thing that reads across all of them is this process.

**Sessions from before the change** keep their `ws_volume` and a null
`workspace_dir`, and migrate at their next start, which is the only moment a
container can be recreated with a different mount. The order loses nothing at
any step: create the directory, copy the volume into it through a one-shot
helper container that can see both (`cp -a`, which preserves the agent's
ownership), recreate the session container with the bind, start it, and only
then delete the volume. A crash before the row is updated leaves a
volume-backed session that migrates again on the next attempt. A *running*
legacy session is left alone and comes through at its next stop/start cycle.

## What the agent is configured with

An `AGENTS.md`, skills and slash commands are managed from the dashboard and
stored in the database, in named *sets*. The set `global` is seeded by the
migration that creates the tables and goes into every session; a session may
name one more, and `agents.ts` merges the two. `AGENTS.md` files are
concatenated, global first — prose accumulates, and a set should add to the
house rules rather than silently replace them. Skills and commands are a union
by name, the named set winning, because two files cannot share one name and
"the same command, but for this project" is the thing the second set exists to
express.

**The database is the truth and the files are derived from it.** At every
create and every start, a session's merged set is written to
`${DATA_DIR}/agents/<id>` and bind-mounted **read-only** at `/boxes/agent`. The
layout is already the one it takes under `~/.claude` — `CLAUDE.md`,
`skills/<name>/SKILL.md`, `commands/<name>.md` — so the entrypoint copies and
interprets nothing.

**Why the copy exists at all.** `~/.claude` is on the home volume, which the
orchestrator has no path to and has no business in: it holds the transcripts
and whatever a login inside the box created. Mounting over it read-only would
break the box; mounting it writable would let the agent edit what the dashboard
says is configured. So the configuration arrives beside `~/.claude` and the
entrypoint installs it.

**The manifest is what makes the install reversible.** The materialized
directory carries a `manifest` naming every path in it. The entrypoint removes
exactly what the *previous* start recorded in `~/.claude/.boxes-managed`,
installs the current manifest, and leaves a copy of it behind. So a skill
deleted in the dashboard disappears from the box, while anything the agent
itself put in `~/.claude` is never touched. Manifest lines are checked, not
trusted: they decide what gets deleted.

**An edit reaches a box at its next start**, and the UI says so. A half-live
mechanism that reloaded an `AGENTS.md` but not a skill would be worse than a
rule anyone can state.

Two details follow from Docker rather than from the design. The materialized
directory's contents are replaced in place and its inode kept, because a
running container has it bind-mounted and swapping the directory would leave
that container mounted on an unlinked one. And a session created before this
existed has no such mount — mounts are fixed when a container is created — so
`start` recreates its container once, the same trade `migrateWorkspace` and
`rollOntoCurrentImage` make and cheap for the same reason. That check runs
*after* the image roll, because a roll recreates the container from
`containerSpec`, which already binds the configuration: a session that moves
image comes back with the mount and the check finds nothing left to do. The
other order would recreate the same container twice.

Deleting a set is not blocked. Sessions that named it keep running and keep
what is installed in them; the foreign key clears the column and they fall back
to the global set alone at their next start.

## Code review

The review surface browses a session's workspace, shows a file highlighted,
takes a comment on a line, and writes all of it to a `REVIEW.md` at the review
root. The format is the desktop [`review`](https://github.com/splitbrain/review)
tool's, byte for byte, so a review started in one is continued in the other —
`orchestrator/src/review/fixtures/` holds files that tool wrote, and the tests
assert the bytes.

What it buys over running that tool separately is that the review lives where
the agent works. `REVIEW.md` is a file of the project under review, so
"address the comments in REVIEW.md" is a one-line prompt, and the review view
and the thread close a loop rather than being two applications.

**REVIEW.md is the single source of truth.** There is no annotation table.
Every mutation is read → parse → apply → serialize → write-tmp-then-rename,
under a per-session lock, with the file's hash checked between the read and the
write. A moved hash means the agent edited the file mid-mutation, and the whole
thing is re-read and re-applied once. A lost race costs one visible refresh
rather than data, because every write re-serializes the whole parsed file. What
is written is chowned to uid 1000, so the agent can edit or delete it.

**Where the review roots.** `/workspace` starts empty and an agent usually
clones into a subdirectory, so the workspace itself is frequently not the
repository. At review open: the workspace if it is itself a git work tree; else
the single directory it holds if that is one, which is the common shape; else
the workspace with the git features off, the way the desktop tool degrades
outside a repository. The answer is cached on the session row and re-validated,
since the agent can delete the directory it named.

**Nothing here starts a container.** Reads and git both run in the
orchestrator, so the natural moment to review — the agent is done, the box has
idled out — costs nothing, and none of these endpoints touches a session's
activity timestamp: polling a review must not hold off the reaper.

**Freshness is polling**, the pattern the session list already uses: the view
asks `review/status` every 5 s while its tab is visible and refetches only when
one of three hashes moved. With the files local that costs three hashes rather
than three execs. Push — an fs watcher and a `/ws/sessions/:id/review` upgrade
beside the ACP gateway — is an additive later stage that nothing depends on.

**Drift** ports from the desktop tool as-is: each annotation stores three lines
of context above and below the annotated line, and a check compares the stored
context against the current source, relocating on an exact match elsewhere and
marking `(outdated)` when it is gone. It runs on a file fetch and, across every
annotated file, on a tree fetch.

**Two invariants, one file each**, because the orchestrator now reads a tree
the agent controls:

- Symlink containment lives in `review/fs.ts`. Every client path resolves
  through `realpath` and must land under the root's own realpath; a symlink
  final component is refused outright, since what it points at can change after
  the tree was listed. The residual `realpath`/open race is documented where the
  check is, along with what closing it would cost.
- Git hardening lives in `review/git.ts`. Repo-local config executes commands
  on exactly the operations review runs — `core.fsmonitor` on status, external
  diff drivers and `textconv` on diff. Every invocation takes its argv prefix
  and environment from one builder there, and a test plants both configs in a
  repository and asserts the hook never ran.

### The review view

`/sessions/:id/review`, with the open file in the search string
(`?path=src/app.ts`) so a file is linkable and the back button works — which on
a phone is also how you get from a file back to the tree. Entry points: a
Review action in the thread header next to Fork, and one on the session card,
where it works whether or not the box is running. The view owns the whole
viewport the way the thread view does.

Boxes is driven from a phone, so the desktop tool's three panels and hover
interactions do not survive. The feature set does; the layout does not. What
replaces it is one set of components in two arrangements rather than two
parallel UIs:

- **The tree** is a column from `md` up and a shadcn Sheet below it, closing on
  selection. Same component, same status colours and comment badges.
- **Comments are inline**, GitHub-style, on every screen size. There is no
  right-hand sidebar to reflow away.
- **Tap replaces hover.** Tapping a line's gutter is how a comment starts;
  tapping a gutter marker opens the diff hunk as a sheet, which is also the
  only place deleted lines exist. Gutter targets are 44 px on touch.
- **Prev/next replaces the scrollbar minimap.** Annotation markers on a
  scrollbar are unusable on touch, and "the next thing that needs me" is what
  the minimap was for — so the toolbar says it directly, with counts and paired
  step buttons for changes and comments.
- **The code pane** is a CSS grid per line: a sticky line-number gutter, the
  code cell scrolling horizontally as one block, and a wrap toggle. Every line
  being its own element is what makes it addressable at all.

Highlighting is client-side, with Shiki: the API ships plain text and the
browser tokenizes it. Both themes are tokenized at once and travel as
`--shiki-light`/`--shiki-dark` custom properties on each span, so a light/dark
switch costs no re-tokenize. The engine is Shiki's JavaScript regex engine, so
there is no wasm fetch, and grammars load per file type on demand. The whole
review route is lazily imported, so none of it — the pane, the tree, the sheet
primitives, the engine, the grammars — is in the bundle a browser opening a
conversation downloads.

Server-side highlighting was considered and dropped: it puts render markup on
the wire, couples the orchestrator to presentation, and the phone still has to
paint it.

Beyond that: paths are validated against the tree, not merely against the root,
so the API serves what the browser was offered; every refusal is the same 404;
file reads are capped at 2 MiB and binaries are refused by a NUL sniff; and
file content and comments are agent-influenced, so the frontend renders them as
text nodes only.

## Network isolation

Two legs, both in Docker's own primitives. Nothing touches the host firewall
and no service needs `NET_ADMIN`.

Every session network is created `internal`: no NAT, no default route. An agent
has no L3 path to the LAN, the internet, or another session. The egress proxy
is then attached to that network under the alias `proxy`, and the container
gets `HTTP_PROXY` and `HTTPS_PROXY` pointing at it. Every proxy-aware client
honours those; anything else has no route out, which is the intended failure
mode.

The proxy itself (`proxy/src/`) runs three listeners:

| Listener | Bound to | Role |
|---|---|---|
| front door | `0.0.0.0:3128` | Faces the sessions: allowlist, vetting, and the choice between an opaque tunnel and interception |
| interception engine | loopback, ephemeral | Terminates TLS for translated hosts and swaps the credential (`inject.ts`, on mockttp) |
| upstream tunnel | loopback, ephemeral | The one place a connection actually leaves, so both routes out are vetted identically |

The front door (`forward.ts`) handles plain HTTP with an absolute request URI
and CONNECT. Only ports 80 and 443 are allowed. Its critical rule is in
`vetTarget`: check the allowlist, resolve the hostname, reject if **any**
resolved address is private, then connect to one **vetted address** without
resolving again. Checking every answer and pinning the connection is what
closes DNS rebinding, since a hostname must not pass with a public record and
connect with a private one. `cidr.ts` holds the range checks; v4-mapped and
v4-compatible IPv6 forms are vetted as the IPv4 address they reach, and
unparseable input fails closed.

The design fails closed. If the proxy is down or detached, sessions have no
egress at all, because there is no direct route to fall back to.

### The allowlist

`EGRESS_ALLOWED_HOSTS` is one deployment-wide list, checked at CONNECT before
any DNS lookup. Exact names and one-label wildcards — `*.example.com` matches
`a.example.com` and neither `example.com` nor `a.b.example.com` — matched
case-insensitively, with address literals matched only as literals. Empty is
off: any public host, private ranges still denied. A configured credential's
hosts are implied members, so a narrow list cannot sever the traffic the proxy
exists to authenticate. The grammar lives in `policy.ts` as pure functions.

### Token translation

A session holds placeholders. Real credentials exist only in the
orchestrator's environment and in the proxy's memory.

A host becomes a *translated host* when its credential is configured. Reaching
one, the front door hands the CONNECT to the interception engine instead of
tunnelling it — by replaying the CONNECT on loopback, so the engine picks the
certificate for the host the client actually asked for. The engine terminates
TLS under the deployment CA and `decideCredentials` rules on the request:

| The request carries | What happens |
|---|---|
| the deployment's placeholder | rewritten to carry the real credential |
| any other credential | 403 from the proxy; nothing reaches the host |
| no credential | forwarded unauthenticated, as it always was |

The swap is value-level: the placeholder is replaced wherever it appears in the
credential header, which covers `Bearer <p>`, `token <p>`, a bare value, and
the HTTP Basic pair git's credential helper produces — one mechanism instead of
a rule per tool.

Everything else stays an opaque tunnel that never reaches the engine, so
interception is bounded by policy rather than by trust in the engine. And every
request the engine forwards leaves through the upstream tunnel, so the vetting
above governs the connection that actually happens: decrypting a host buys it
no way around the checks.

`api.anthropic.com`, `github.com`, `api.github.com` and
`*.githubusercontent.com` are the translated hosts, fixed in `config.ts`
alongside the headers each credential travels in. They are facts about the
services rather than preferences, so they are not configurable.

### The control channel

The proxy has no configuration file, no database and no CA on disk. It boots
empty and the orchestrator pushes it a policy — the allowlist, the CA key and
certificate, and the credential map — over an HTTP endpoint on the compose
network, held in memory only.

Two things keep it out of a session's reach. It binds to the compose network
alone: sessions sit on internal networks with no route to that address, because
the proxy bridges them at L7 and does not route. `control.ts` finds that
address by asking the kernel which local address the default route uses, which
is an exact description of the compose interface, since internal networks
install no default route; failing that it binds to loopback, because no control
channel is a safe failure and an exposed one is not. And it requires a bearer
token that nobody configures: the first push over that interface claims the
channel and every later push must match it.

The orchestrator's side is `egress.ts`. The CA and the placeholders are
generated once and persisted in `DATA_DIR` at mode 0600, beside the generated
WebSocket token — regenerating them per boot would strand every running
session, which holds the old certificate in its trust file. Rotation is
deleting that file.

## State, and where truth lives

Docker is the runtime truth. SQLite holds metadata, and the two are reconciled
at boot and on every read that reports container state.

`orchestrator/src/db.ts` opens the database in WAL mode under `DATA_DIR` and
applies migrations tracked by `user_version`.

| Table | Holds |
|---|---|
| `sessions` | One row per session: names, Docker object names, status, which thread is the default, timestamps |
| `threads` | One row per conversation: which session owns it, the adapter's id for it, the agent's title, its ordinal, whether a turn is running on it |
| `pending_requests` | Permission requests waiting for a browser, each recording the thread that asked |
| `acp_log` | A debug tap of forwarded messages, ring-pruned to 5000 rows per session |
| `exec_log` | Local commands and their output, ring-pruned to 200 rows per session |
| `push_subscriptions` | One row per browser registered for Web Push, keyed by the push service's endpoint |
| `agent_sets` | One row per named set of agent configuration, plus its `AGENTS.md`. The row `global` is seeded and applied to every session |
| `agent_items` | The skills and slash commands of a set, keyed by set, kind and name |
| `counters` | The subnet allocation counter |

Two kinds of state deliberately stay out of the database. Secrets live only in
the environment, in the session containers, and in the generated token file;
`log.ts` redacts anything credential-shaped before it reaches stderr. Thread
transcripts live in the session's home volume, read back by the adapter.

Pending requests are the one place where the database and memory both matter.
The row lets the dashboard show that something is waiting and survives a
restart; the resolver that answers the request is in memory only, so
`clearStale` drops rows left behind by a previous process.

## Background loops

| Loop | Interval | Does |
|---|---|---|
| Reaper (`reaper.ts`) | 60s | Stops sessions that are idle on all four counts: no running turn on any thread, no waiting permission request, no attached browser, and no activity for `IDLE_STOP_MINUTES`. It never deletes. The turn count is derived from the threads; the other three stay session-scoped, because they are about the box rather than the conversation |
| Proxy reconciler (`reaper.ts`) | 60s | Re-asserts both halves of the proxy's state: its attachment to every running session's network, which `compose up` can drop by recreating the container, and the policy it holds, which a restart erases entirely. Both show up in `/healthz` |
| Maintenance | 60s, with the reaper | Prunes each session's debug log to its ring size |

The dashboard polls `GET /api/sessions` every 5 seconds while its tab is
visible, and pauses while it is hidden.

## Configuration and secrets

`config.ts` parses the environment once at boot with zod, so a misconfigured
deployment fails at startup rather than at first use. Every setting has a
working default, which is why the stack runs with no `.env` at all.

That file is the only place a default is written down, and the only place
that knows which settings exist. `compose.yaml` hands the orchestrator an env
file wholesale (`BOXES_ENV`, defaulting to `.env` and optional), so adding a
setting means editing the schema and nothing else. It sets no value at all.
The one thing it names is the two credentials, listed with no value so that
they can be exported in a shell rather than written down at all. The cost is
that `environment` overrides `env_file` whether or not the shell has a value,
so those two names cannot come from a `BOXES_ENV` file outside the repo —
they come from the shell or from `./.env`, which compose reads for both.
Every other setting is unaffected. Where compose has to agree with a default
— `/data`
for the volume mount, `boxes-egress-proxy` for the container the orchestrator
attaches to session networks — it agrees by using the same value, not by
restating it as configuration, and the comment at each site says which
default it is matching.

`DATA_DIR` and the rest stay configurable because the orchestrator also runs
outside a container, under `npm run dev` and in its own tests. Inside the
image every default is already the right answer, which is why compose passes
an env file and otherwise stays out of it.

An empty value counts as unset. `NTFY_URL=` in an env file arrives as an
empty string, and failing the boot on a setting nobody set would be a poor
way to read it.

`WS_AUTH_TOKEN` is the exception, because a shipped default for a secret would
be a published password. Left unset, `secret.ts` generates a token on first
boot and writes it to `DATA_DIR/ws-auth-token` with mode 0600, so it survives
restarts and rebuilds. Setting the variable wins, which is also how the token
is rotated.

The same reasoning covers the egress material. `egress.ts` generates the CA,
the placeholders and the control-channel bearer on first boot and stores them
in `DATA_DIR/egress-secrets.json` at mode 0600. They are generated rather than
configured, and they persist rather than being regenerated, because running
sessions hold them.

Profile credentials — the Claude token, the GitHub token and the git identity —
are injected into a session container at create time and nowhere else. With
translation on, what is injected is a placeholder: the real value never enters
a session container, and never reaches a filesystem outside the orchestrator's
own data volume. The CA certificate travels the same path, as
`BOXES_PROXY_CA`, which the entrypoint writes to `~/.boxes/proxy-ca.crt` for
the four CA-trust variables to point at.

## Build-time pins

The ACP adapter version is pinned in `session-image/Dockerfile` rather than in
configuration, so the running agent is the one this commit names and no `.env`
entry can change it.

Frontend dependencies are pinned in `dashboard/package.json` and resolved by
`package-lock.json`, which every Docker stage installs with `npm ci` rather
than `npm install`. `@assistant-ui/react` and `@assistant-ui/react-markdown`
carry exact versions rather than ranges: the composer's history behaviour
comes from a hook upstream documents as unstable, so the version that behaves
is the version that ships.

Every package type-checks before it bundles, in its own Docker stage, so an
image cannot be built from code that fails `tsc --noEmit`.

## Code map

```
orchestrator/src/
  index.ts              Boot, the WS upgrade, the background loops, shutdown
  app.ts                REST routes, the exec endpoint, the static bundle
  exec.ts               Local commands: limits, streaming, the exec log
  config.ts             Environment parsing, and the translatable credential set
  secret.ts             WS auth token: configured, stored, or generated
  notify.ts             "A thread wants you", fanned out to ntfy and Web Push
  push.ts               VAPID and RFC 8291 payload encryption, on node:crypto
  egress.ts             CA and placeholders, the policy, and the push to the proxy
  db.ts                 SQLite, schema migrations, the debug log
  sessions.ts           Session lifecycle, the owner of every UpstreamSession
  workspaces.ts         Workspace directories on the data volume: paths, ownership
  agents.ts             Agent sets: AGENTS.md, skills, commands; the merge and the materialized bundle
  docker.ts             Containers, networks, volumes, the adapter exec
  review/
    service.ts          Per-session façade: root, the REVIEW.md read-modify-write, the fingerprint
    store.ts            REVIEW.md: parse, serialize, mutate, drift (pure)
    gitstatus.ts        Porcelain and name-status parsing, base resolution
    difflines.ts        Unified diff to line markers, hunks and deletion markers (pure)
    tree.ts             git ls-files or a walk into a tree, and the ignore lists
    fs.ts               Contained reads and writes under one root: the symlink invariant
    git.ts              The one place a git process is spawned: fixed argv, scrubbed env
  subnet.ts             Per-session /24 allocation
  reaper.ts             The idle reaper and the proxy reconciler
  log.ts                Structured stderr logging with secret redaction
  gateway/
    upstream.ts         One persistent ACP client per session, carrying every watched thread
    downstream.ts       One ACP agent connection per browser, pinned to one thread
    broadcast.ts        Which browsers each adapter update goes to, routed by thread
    pending.ts          Permission requests waiting for an answer

proxy/src/
  main.ts               The three listeners, the in-memory policy, the denial tally
  forward.ts            Absolute-URI HTTP and CONNECT: allowlist, vetting, pinning
  policy.ts             Allowlist grammar and the credential decision, as pure functions
  inject.ts             TLS interception and the swap, on mockttp
  control.ts            The authenticated policy push, and where it may be reached
  cidr.ts               Resolved-IP vetting, the security boundary

dashboard/
  index.html            Vite entry; sets the dark class before first paint
  public/               Served from the bundle root: the service worker, the manifest, the icons
  vite.config.ts        React, Tailwind, the dev proxy, both test projects
  components.json       Where the shadcn and assistant-ui CLIs install to
  e2e/                  Browser tests, and the stub orchestrator and gateway
  src/
    main.tsx            React mount and the routes
    globals.css         The whole design system: tokens and the @theme bridge
    api.ts              Typed fetch client
    stores/
      sessions.ts       Polled session list and health, read by useSyncExternalStore
      push.ts           Web Push registration: the service worker, the subscription, the toggle's state
      thread/
        acp-types.ts    The slice of the ACP schema the browser speaks
        acp-client.ts   JSON-RPC over the WebSocket, and the handshake
        translate.ts    session/update notifications → a message model (pure)
        thread-store.ts The live thread: messages, modes, models, approvals, exec
        convert.ts      That model in the shape the runtime reads
        exec.ts         !bang commands against the exec endpoint
    views/              SessionList, SessionCreate, SessionThread, SessionInfo, AgentSets
    components/
      assistant-ui/     Installed registry sources, ours to edit
      ui/               Installed shadcn primitives

shared/types.ts         REST shapes and the control-channel contract
session-image/          The per-session container image and its entrypoint
scripts/                Security smoke test and credentialed live test
```

## Testing

`scripts/smoke-test.sh` is the security gate and needs no credentials. It
creates two throwaway sessions and asserts the isolation properties from inside
one of them: no proxy-bypassing egress, no private-range access through the
proxy, no cross-session reachability, no docker socket, a read-only root
filesystem, a contained fork bomb, and that the intended egress and writes do
work. Every probe passes `curl -f`, so a 403 from the proxy leaves a non-zero
exit status.

`scripts/live-test.sh` covers what only a real inference call can prove:
subscription auth inside the container, a turn running to completion after the
browser leaves, the thread replaying on reattach, and a permission request held
with nobody watching.

The review surface is tested at three levels, because it has three kinds of
thing to get wrong. The format is asserted byte-for-byte against REVIEW.md
files the desktop tool's own Go code wrote (`orchestrator/src/review/fixtures/`,
with its own README on provenance), the same reviews being rebuilt from the same
inputs and each file round-tripped. The invariants have tests that are the
attacks: a symlink out of the workspace, a symlink through a directory, and a
traversal all coming back as the same 404, and a repository-local
`core.fsmonitor` and `textconv` planted in a real repository with an assertion
that neither ever ran. The seven routes are driven over their real handlers, a
real database and a real git repository in a temp directory — no Docker at all,
which is what stage one bought for the tests as much as for the feature —
covering root resolution, drift, concurrent writes and that none of them touches
a session's activity timestamp.

Unit tests cover the pure logic that is easiest to get quietly wrong: the
proxy's range checks, subnet allocation, the WebSocket upgrade check, update
routing with two browsers attached — including two on *two* threads, where an
update for one must not reach the other, a replay of one must not silence the
other's live updates, and an update nobody is watching is dropped — the exec
limits, the schema migrations that turned one thread per session into several
and then moved the running turn onto them, the spawn path against a stand-in
adapter — a forgotten thread costing the session only that thread, a turn
recorded against its own thread, a permission request reaching only a browser
on the asking thread, a turn announced only when nobody was watching it, and a
respawn reloading every watched thread — and the translation of ACP
notifications into the thread's message model — including replay, out-of-order
tool updates, and an update kind this build predates.

Web Push is the one piece tested against somebody else's numbers: `push.ts`
has to produce a body a browser can open, and no round-trip test can show
that, so `push.test.ts` reproduces the worked example in RFC 8291 byte for
byte and verifies the VAPID assertion against the key it advertises.

The dashboard also runs a browser suite. It builds the production bundle and
serves it the way the orchestrator does, from a stub orchestrator and a stub
ACP gateway that speaks the agent side from canned scripts — including its
own several threads per session with each socket pinned to one by its upgrade
path, so a fresh thread starting empty, a fork carrying the source's messages,
a switch bringing the first thread's transcript back, and two tabs on two
threads each keeping to their own conversation are asserted against a gateway
that behaves like the real one.
The review pages are in that suite too, on a phone viewport and a desktop one,
because the two arrangements are different enough that one passing says little
about the other: browse the tree, open a file, tap a gutter marker for the hunk,
comment on a line and see the write reach the API, edit and delete it, set a
base revision, and hand the review to the agent with the prompt staged unsent.
The degraded shapes are there as well — no git, an empty workspace, and a
session whose workspace is still a volume.
That is what asserts the UX properties this frontend exists for, and it is
where a component upgrade is reviewed: `/playground` renders every part kind over a
canned store, so a registry re-run shows up on one page.

One runner throughout: `npm test` in each package is `vitest run`.
