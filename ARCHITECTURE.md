# Architecture

Boxes runs AI coding-agent sessions in isolated Docker containers and lets a
browser drive them over the Agent Client Protocol (ACP). One orchestrator
process owns everything: the REST API, the web assets, the agent connections,
the container lifecycle and the database.

This document describes how the system is put together. [`README.md`](./README.md)
covers setting it up and using it.

## The property everything else serves

**A running agent turn continues when the browser disconnects.**

The orchestrator, not the browser, is the ACP client of record. It holds a
persistent stdio connection to each ACP adapter in the session container — one
per harness a thread of that session runs. Browsers attach and detach as
views, and nothing a browser does reaches an adapter except the messages the
gateway forwards.

Two consequences shape the rest of the design:

- The agent connection outlives any browser, so a long-lived process has to own
  it and be able to rebuild it without losing the thread.
- Thread history is replayed by the adapter's own `session/load` from the
  session's home, so the orchestrator stores no transcript of its own. What it
  keeps is a bounded log per thread, in memory, of what it has forwarded — the
  adapter's replay read once when a thread is brought up, and everything said
  live since — and a browser opening a thread is sent that log rather than a
  fresh replay.

A session owns several *threads* — ACP calls one conversation a session, and
this document calls it a thread to keep it apart from a Boxes session. The
container, the workspace, the home, the network and the egress policy
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
   │ net sn-a1b2  │ │ net sn-c3d4  │  each harness's adapter runs
   │ (internal)   │ │ (internal)   │  as a long-lived exec, not PID 1
   └──────────────┘ └──────────────┘
```

| Process | Built from | Role |
|---|---|---|
| orchestrator | `orchestrator/Dockerfile` | Serves every route, owns the sessions, holds the Docker socket |
| egress proxy | `proxy/Dockerfile` | The only route out of a session network, and where credentials are put on the wire |
| session container | `session-image/Dockerfile` | Runs the agents and their ACP adapters, one container per session |

The orchestrator and the proxy are compose services. Session containers are
created at runtime through the Docker API, so they appear in no compose file.

That makes the session image the orchestrator's to keep, not compose's: it
pulls `SESSION_IMAGE` when it is missing, at every boot, and again every
`SESSION_IMAGE_PULL_MINUTES`, and a session moves onto what arrived the next
time it is *started* — never while it runs, where recreating the container
would kill the adapter exec mid-turn. The copy the tag moved off is removed
once nothing is left on it, which is the only way that space is ever
reclaimed; see [Reclaiming what a session leaves](#reclaiming-what-a-session-leaves). Recreating is otherwise cheap and is how
a session container changes anything about itself: the rootfs is read-only and
everything durable is in the two mounts, so the workspace and the thread
history come across untouched. For the same reason nothing outside the
orchestrator may recreate one — the container id in the database and the
runtime proxy attachment would both be lost — so the template carries
`com.centurylinklabs.watchtower.enable=false`.

Which build of the three is running — its digest, when it was built and what
it takes on disk — is read back off the daemon and reported in `/healthz`,
because a deployment that follows `latest` moves when a watchtower says so
rather than when a person does. The orchestrator's image
and the proxy's are whatever their containers were created from; the session
image is named by `SESSION_IMAGE` outright, so no container has to exist for
it. The session list shows
all three in a footer. `orchestrator/src/images.ts` caches the reading for a
minute: the probe is polled by every open tab, and nothing here moves without
a registry pull behind it.

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
| `/ws/sessions/:id/terminal` | A shell in the session's container |
| `/healthz` | Liveness, and what the deployment is: version, session count, proxy warnings, which harnesses can run a turn and what the deployment holds a credential for, and which build of each image is running. Always 200 while the process serves |
| `/readyz` | Readiness: 200 only when the database answers, the egress policy is in sync and Docker is reachable, which is what creating or starting a session needs |

A GET that matches no other route serves the dashboard's `index.html`, so
client-side routes survive a reload. Anything under `/api` or `/ws` gets a
404 instead.

The bundle is served compressed, and its assets carry a year-long immutable
cache lifetime because their names are content hashes: a new build is a new
name, so a cached one can never be stale. `index.html` is the file that names
them, so it is never cached that way. The document carries a content security
policy of its own, which is what stops agent-written markdown from fetching a
remote image and turning the operator's browser into a way out of the box that
the egress proxy never sees. Every response is logged as one structured line on
stderr, where `docker logs` has it.

The dashboard is the only frontend, and it is served from the orchestrator's
own image. Two things follow:

- The browser derives the WebSocket URL from its own location, so no
  deployment setting can make it wrong and the API carries no endpoint URL.
- The whole stack runs behind one published port, with no reverse proxy.

## REST API

`orchestrator/src/app.ts` defines the routes; `SessionManager` does the work.
Request and response shapes live in `shared/types.ts`, which both the
orchestrator handlers and the dashboard's `api.ts` import. The ACP vocabulary
both sides speak — the subprotocol, the method names, the update kinds — is
`shared/acp.ts`, so a name is spelled once rather than in each package.

Every route that takes a JSON body checks it against a schema in `bodies.ts`
first, and a body that fails one is a 400 naming the field rather than a cast
that misbehaves further in. Path and query parameters are read as they always
were.

| Method and path | Does |
|---|---|
| `GET /api/sessions` | Summaries of every live session |
| `POST /api/sessions` | Creates a session and returns it; `thread` says what its first conversation runs |
| `GET /api/sessions/:id` | One session with its Docker object names |
| `POST /api/sessions/:id/start` | Starts a stopped container |
| `POST /api/sessions/:id/stop` | Stops the container and drops the upstream |
| `DELETE /api/sessions/:id` | Deletes the session, its workspace and home included |
| `GET /api/sessions/:id/threads` | Every conversation the session owns |
| `POST /api/sessions/:id/threads` | Adds one and makes it the session's default; `options` says which harness it runs and what it starts configured with, and `{"from":"<threadId>"}` forks that one instead — on its own harness, so `options` is then ignored |
| `POST /api/sessions/:id/threads/:threadId/select` | Makes one the session's default |
| `POST /api/sessions/:id/threads/:threadId/done` | Marks a conversation done, or takes the mark off: `{"done":true}` |
| `POST /api/sessions/:id/threads/:threadId/background/stop` | Kills one thing the thread left running, or everything it has; answers with how many were signalled |
| `POST /api/sessions/:id/attachments?name=` | Stores one file, raw bytes, in the session's workspace |
| `GET /api/sessions/:id/attachments/:name` | Serves one back; images and PDFs as themselves, everything else as a download |
| `GET /api/sessions/:id/review/dir?path=&fresh=` | One directory: its children with each file's status and comment count, each folder's subtree marks, and the facts the whole view needs. `fresh=1` says the reader has arrived, and retakes git's answer |
| `GET /api/sessions/:id/review/file?path=` | Content, diff markers, the owning repository and comments — the whole file view |
| `PUT /api/sessions/:id/review/file` | Saves one file of the workspace, refusing a save over an edit made since it was read |
| `PUT /api/sessions/:id/review/annotations` | Creates or replaces one line's comment |
| `DELETE /api/sessions/:id/review/annotations?path=&line=` | Deletes one comment |
| `PUT /api/sessions/:id/review/base` | Sets the revision the review is compared against, or clears it; answers with where it resolved in each repository |
| `DELETE /api/sessions/:id/review` | Deletes `REVIEW.md` — "New review" |
| `GET /api/agent-sets` | Every agent set, the global one first |
| `POST /api/agent-sets` | Adds a set |
| `GET /api/agent-sets/:setId` | One set with its `AGENTS.md`, skills and commands |
| `PATCH /api/agent-sets/:setId` | Renames a set, or replaces its `AGENTS.md` |
| `DELETE /api/agent-sets/:setId` | Deletes a set. The global one is refused |
| `PUT /api/agent-sets/:setId/items` | Creates a skill or command, or replaces the one under that name |
| `DELETE /api/agent-sets/:setId/items?kind=&name=` | Deletes one |
| `GET /api/agent-sets/:setId/preview` | What a session naming this set would get, global set merged in |
| `GET /api/harnesses` | Every harness: what the registry says, what its adapter last advertised, and whether it can run |
| `GET /api/credentials` | Every stored credential, as an account and a status. Never a secret |
| `PUT /api/credentials/:id` | Stores one: `{"method":"token","secret":"…"}` |
| `DELETE /api/credentials/:id` | Forgets one, and its hosts stop being intercepted |
| `POST /api/credentials/:id/login` | Starts a login for an account that cannot be pasted |
| `GET /api/credentials/:id/login/:loginId` | Where that login has got to, which the page polls |
| `POST /api/credentials/:id/login/:loginId/code` | Hands back the code the CLI asked to have pasted |
| `DELETE /api/credentials/:id/login/:loginId` | Gives up on one, and the container goes with it |
| `GET /api/settings` | The git identity and each dialog's last choice |
| `PATCH /api/settings` | Writes the ones a body names |
| `POST /api/sessions/:id/threads/:threadId/background/stop` | Stops one task the thread announced, or all of them |
| `POST /api/sessions/:id/background/stop` | Kills everything running in the box, whoever left it there |
| `GET /api/push/key` | The deployment's VAPID public key, which a browser subscribes with |
| `POST /api/push/subscribe` | Registers a browser for Web Push, or refreshes what is stored for it |
| `DELETE /api/push/subscribe` | Forgets one browser's subscription |

The API carries no authentication of its own; a reverse proxy is expected to
provide it for `/` and `/api`, and the published port binds to loopback so
that an unproxied deployment is not an exposed one. `/ws` is the exception in
both directions: it must *not* be behind HTTP authentication, because a
browser cannot attach Basic credentials to a WebSocket upgrade, and it does
not need to be, because the gateway authenticates the upgrade itself.

### The terminal

`/ws/sessions/:id/terminal` is a shell in the session's container, drawn in
the browser by xterm.js at `/sessions/:id/terminal`. Binary frames are the
pty's bytes in both directions; text frames are control from the browser,
which is a window size and nothing else so far.

It is the same box the agent works in, reached directly. `openTerminalExec`
runs the shell as the non-root `agent` user, with `Tty` set so the daemon does
no framing, in the container's existing isolation — internal network,
read-only rootfs, capabilities dropped. No new privilege is introduced: anyone
holding the session's token can already ask the agent to run anything, and
nothing shell-executes on the host — the command is an argument vector handed
to the daemon, and the only part of it the orchestrator composes is a name it
generated itself.

tmux is what makes the shell outlive the page. A box has one shared session,
`boxes`, created detached on first use; each connection then starts a session
of its own grouped with it, so every terminal shows the same windows. Two tabs
are the same shell, a reload comes back to the same scrollback, and the shared
session holds the windows when every client has gone — which is what lets a
build carry on with nobody watching. The server lives in the container and its
socket is in `/tmp`, which is a tmpfs, so a box that stops takes the shell with
it. An image from before tmux gets a plain login shell, which is all of this
except surviving the tab.

A session per connection is what makes one closable. Docker offers no way to
signal a running exec, and dropping the stream would leave the tmux client
attached for good — one more with every tab anybody closed. So a closing
terminal runs `tmux kill-session` against its own session and then drops the
stream. The windows survive, being linked to the shared session too, and no
other terminal on the box is touched.

The upgrade is the one the ACP gateway makes, against the same per-session
token: the path names a box and never a thread, because a terminal belongs to
the box rather than to a conversation. A box that is stopped is started for
it, which takes seconds, so bytes typed before the prompt appears are held and
replayed into the pty rather than dropped.

An open terminal holds the idle reaper off the way an attached browser does —
a build can run for an hour without printing a line, and stopping the
container under it would take the shell and the build with it. That makes a
browser that has gone without saying so expensive, so the server pings every
30 seconds and drops a socket that misses two. Typing marks the session
active, at most once a minute, so closing the tab leaves the box its usual
idle window rather than the next tick.

Back pressure is applied to the pty rather than to the browser. Past a
megabyte of unsent bytes the stream is paused and resumed on drain, which is
what holds up the writer in the container: a terminal producing faster than it
is drawn is ordinary, unlike a browser falling behind on ACP, which is closed.

### Attachments

A file attached to a prompt is uploaded into the session's own workspace, at
`.boxes/attachments/`, and the prompt then says so. That is the whole design,
and what makes it type-agnostic: a PDF, a CSV or a heap dump becomes a path
the agent opens with the tools it already has, where anything carried inside
anything carried inside the message would be limited to what a model reads
directly. A workspace is a plain directory the orchestrator owns, so the
upload is a file write — no container is involved, and a stopped session takes
attachments as a running one does.

Nothing travels inside the message. What the prompt carries is one block of
text naming every attachment, and then what the user typed — context, then
the question about it:

```
<attachments>
The user attached these files to this message. They are saved in the
workspace at the paths below; read them if they are relevant.
- .boxes/attachments/shot.png (image/png, 1.2 MB)
- .boxes/attachments/report.pdf (application/pdf, 840.0 KB)
</attachments>
```

An image the user attached is still shown in the thread: the chip is a
picture, loaded from `GET /api/sessions/:id/attachments/:name`, which reads
it back out of the workspace. So the bytes cross the wire once, on the way
up, and the thread looks the same on the phone that sent the screenshot and
on the desktop that comes to it an hour later.

That endpoint reads out of a tree the agent controls, so it is contained the
way the review's file endpoint is and by the same code — `resolveInRoot` in
`review/fs.ts`, which refuses a path that leaves the directory or is reached
through a link. That is the containment that matters here: a link planted in
the attachments directory would otherwise serve whatever the orchestrator's
own uid can read, `/data` included.

What it serves is declared rather than sniffed. What a browser can show is
served as itself — images, SVG included, and PDF — and everything else as an
`application/octet-stream` download. HTML is the deliberate omission: served
as itself it runs as this origin, and unlike an SVG there is no way to show
it that does not.

Every response carries `nosniff` and `default-src 'none'`, with `sandbox` on
all but the PDF. That CSP is load-bearing rather than decorative: it is what
lets an SVG — which can carry script, and which an agent can write — be
served as an SVG. Opened as a document it has no script, no origin and no
network; behind the `<img>` the thread draws it with, a browser runs nothing
in it anyway. The PDF is the exception because it is rendered by the
browser's own viewer rather than by the page, and a sandboxed document is one
a browser may decline to hand over — which would turn opening it into a
download, the one thing serving it inline was for.

Non-image attachments read as a chip in the thread, and the chip is a link to
that endpoint: a PDF opens in a tab, anything else downloads.

**Text, and not ACP's `resource_link`.** The protocol has a block for naming
a file, and the Claude adapter renders it as `[@name](file://…)` — a bare
markdown link, with no mime type, no size, and nothing saying whether to open
it. The deciding part is what comes back afterwards: an adapter stores that
rendering, not the block, so a reconnected thread would not look like the one
that was sent. Text round-trips through any adapter's transcript exactly as
written, which is what lets the dashboard read this same envelope back —
live from the gateway's echo, or on replay from the adapter — and draw the
attachment in its place, as a picture where it can and as a chip naming the
file otherwise. An envelope this build cannot parse is left alone as text, because showing
the model's own instructions is a better failure than dropping a file the
reader is looking for.

Uploaded names are sanitised to letters, digits, dot, dash and underscore,
with any leading dot dropped. That settles two things at once: as a path
component a name cannot climb out of the directory, and as prompt text it
cannot forge a line of the list it is quoted into — a newline in a filename
would otherwise end its entry early and let the rest read as another. A
`.gitignore` holding `*` goes into `.boxes/`, so attachments do not show up
as untracked files in a repository the agent is working in, and the
repository's own `.gitignore` — a file the user owns — is left alone.

Two limits are set deliberately rather than inherited. `MAX_ATTACHMENT_MB`
(25 by default) bounds one upload, which the orchestrator buffers before
writing out. The gateway's WebSocket takes a 16 MiB frame, where `ws`
defaults to 100 MiB — nothing the dashboard sends approaches either, but the
gateway answers any ACP client, and an ACP prompt may carry an image inline.

## The frontend

One React app, served at `/`. The session list is the thread list: a thread is
`/sessions/:id/threads/:threadId`, and `/sessions/:id` is whichever thread the
session has current — so every older link and bookmark still works. The ops —
start, stop, delete, the details — live at `/sessions/:id/info`.
What the agent is configured with belongs to the deployment rather than to any
one box, so it hangs off the list instead: `/agents` lists the sets and
`/agents/:setId` edits one. The deployment's credentials hang off the same
header for the same reason, at `/settings`: one card per credential with the
account it is for and whether it works, the git identity every box commits as,
and — where an account cannot be pasted — the login, which shows the URL and
the one-time code and asks for a code back where the CLI wants one. Nothing on
that page ever shows a secret.

Each card carries its session's threads under its badges, the default one
marked, so the list is the tree. Each row is a plain link to that thread,
because opening one is a plain navigation now: the connection names its own
thread, so nothing has to be switched first. Opening a thread still makes it
the session's default, as a fire-and-forget POST that neither blocks the
navigation nor disturbs anybody. **New thread** and **Fork** sit under the
rows, the second only when that thread's own adapter offers it. **New thread**
opens the dialog that asks which agent the conversation runs and what it starts
configured with; a fork asks nothing, because it stays on its source's harness
and keeps its settings.

A row is a name and a bullet, and the bullet is that thread's state, in the
one colour vocabulary `StatusBadge` holds: amber for a question waiting on it,
blue for the agent talking on it, dim blue for work still running in it, grey
for a thread with nothing going on. It marked the session's *default* thread
until the work below arrived — green for that one, grey for the rest — which
the row already says in its weight and in `aria-current`, and which spent the
colour that means "the container is up" on something that is not a state a
thread can be in. Being up is a precondition of all four. The dim blue is the
one that could not be shown before: it is the conversation holding the box
awake, which a list of them had no way to point at.

Two rough indicators sit on the card, because a list of boxes is scanned
rather than read. Each row ends in how long ago that conversation last did
anything — `12s`, `5h`, `14d`, always the largest whole unit and always
rounded down — which is what picks the thread you were in out of a box with
six of them. Each card carries how much disk the box is taking up — its
workspace and its home together — in the badge row but not as a badge: it is a measurement rather than a state, and
a pill would put it among the things that say what the session is *doing*.
Neither is a figure to act on, which is the point of the shape — `340 MB` and
`1.4 GB` are different news, `341 MB` and `340 MB` are not. Both are
`lib/rough.ts`; the exact timestamp is on the details view, and the exact
byte count is nobody's question. The ages are re-read on every poll rather
than on a timer of their own, so they move at the same five seconds as
everything else on the card.

Rows carried labelled badges of their own beside the name, for two of those
four states. They are gone: they said in words what the dot says in colour,
and a row is for picking a conversation out of a list rather than for reading
about one. The card keeps its badges, because a card is the whole box and has
things to report that no dot covers.

The thread view names which thread it is on beside the session's name,
*always* rather than only when the session has more than one: two tabs on one
session are otherwise indistinguishable, which is the whole point. It also
carries its own **Fork**, because that is where the motion starts — you are in
a thread doing something long and you want a second one to ask about it. The
button posts and then reveals the new thread as a link with `target="_blank"`,
so the working thread stays where it is and the new tab is opened by a real
click. A `window.open` after the await is the thing to reach for, and it is
what popup blockers exist to stop.

That header gets out of the way while you read, and so does the review's —
one hook and one wrapper serve both, because a thread and a code pane are the
same shape of thing: a full-viewport route whose one scroller is the thing you
came for. A downward run of thirty-odd pixels collapses the row, and two dozen
back up returns it; the space goes straight to the content, which is `flex-1`
below it. Going is a decision about the reading you are doing and coming back
is a request that should not have to be repeated, so the two distances are not
the same. Runs are measured from the last change of direction rather than the
last event, which is what makes a pixel of finger jitter mean nothing and a
slow drift down mean something. The notices under the header do not collapse:
a missing token, a fork to open, an error to read are things to act on rather
than things in the way.

Three things are not reading, and the hook (`use-scroll-away.ts`) declines to
read them as such. A view against the bottom of its scroller is following its
own output — a thread streaming a reply — and stays there for the whole of
it, so nothing decides down there.
That question is asked of the scroller rather than of the app on purpose: the
thread's `isRunning` clears while the last chunks are still landing, measured
rather than guessed, so a header that trusted it moved on its own at the end
of every turn. A single step longer than three hundred pixels is a jump — a
review restoring where a file was left, a hunk being centred — and no hand
produces one. And the collapse itself moves the scroller: growing it by the
header's height makes Chrome nudge `scrollTop` to hold anchored content still,
which arrives as an upward run, which is the signal to come back, which grows
the scroller again. That one is a feedback loop, and it flapped until steps
small enough to be the nudge stopped counting for as long as the transition
runs. In every case the position is kept and the intent is dropped.

The row is collapsed rather than slid over the content: on a phone the point
is the fifty pixels, and chrome floating over the first message covers the
message instead of yielding. Its height is measured with a `ResizeObserver`,
because a two-line title beside two selects is not a number to hardcode and
`auto` is not a value CSS will animate from — and it is `inert` while away, so
nothing in it is tabbable, readable by a screen reader, or clickable through
the clip. That last one has a cost worth knowing: below md the only way to the
review's file tree is the button in its header, so switching files from deep
in a file takes a flick up first.

None of that is the browser's own hiding of its chrome, which the header must
not be at the mercy of. A thread is one dynamic viewport tall with its own
scroller inside, so the document has nothing to scroll — but `100dvh` is
measured against chrome that slides in and out, and every mismatch (the URL
bar expanding, the keyboard opening under a focused composer, rounding on iOS)
leaves the document taller than the screen. The browser scrolls the difference
away to keep the focused thing in view, and what goes off the top is the
header — stranded on a scroller no gesture reaches, because every touch lands
in the thread's instead. So the full-viewport routes mark the document
unscrollable for as long as they are mounted (`use-viewport-lock.ts`), and the
viewport meta asks the keyboard to resize the content rather than slide over
it. What moves the header now is the app, on purpose.

Where a turn is read from is the runtime's business, up to a point. A turn
anchors the prompt that started it to the top of the viewport and writes the
answer underneath, paying for the space an unwritten answer does not fill yet
with a reserve element it shrinks as the answer arrives. That lasts one
screenful. Past it the anchor has nothing left to give, and it holds a
position rather than following one, so a long turn, which is a run of tool
calls and reasoning and rarely anything else, went on writing below the fold
and left it all there until it ended. `use-follow-output.ts` takes over at
that handover and keeps the viewport against the bottom for the rest of the
turn. It watches the scroller and what it holds, because content arriving is
not the only thing that grows a thread: a disclosure animates its height for a
fifth of a second without touching the DOM again.

A reader who takes the scroller away from the bottom is left where they put
it, and arriving back at the bottom rejoins. Which of the two a scroll was is
asked of the input rather than of the position, because the position cannot
answer it: a reader going up a hundred pixels and the browser holding the page
still while a block above them collapses by a hundred both subtract the same
hundred from `scrollTop`, and the turn writing into the same frame moves the
numbers again underneath both. Nothing the browser does to a scroller of its
own accord arrives with a wheel or a finger attached. A key is not counted
among those, however much it looks like input — the composer sits inside the
viewport, so every letter typed into it, and the Return that starts the turn,
arrives at the scroller too.

Which is also why a disclosure does not hold the viewport still while any of
that is going on (`use-disclosure-lock.ts`). The registry's `useScrollLock`
pins `scrollTop` for the length of a collapse, so the line under the reader's
eye stays where it was, and it pins by putting the position back on every
scroll event of the next two hundred milliseconds — including the ones a
thread following its own output makes. The runtime reads that reset as a
reader flicking upward and stops following for good, and a working turn is
disclosures opening and closing, so following survived about one of them. A
thread that has moved with its output in the last second has nothing to hold
still and is not held. One being read at the bottom of a finished turn does,
and still is: opening a tool call there unfolds it below rather than taking
the view to the end of what it printed, which is what the lock is for.

The chat itself is [assistant-ui](https://www.assistant-ui.com/). Its
components are installed into `src/components/assistant-ui/` by the official
CLI, in the shadcn distribution model: the sources are committed and Boxes
edits them, and an upgrade is a CLI re-run reviewed as a diff rather than a
version bump that changes the UI silently. Boxes' own edits are marked
`Boxes edit` in the source, with the reason at the point of the change —
`grep` is the list, because a count in prose here would rot. They are of three
kinds: terminal habits the chat did not have (ArrowUp history on the composer,
returning focus after a send, the slash-command list below), facts about this
deployment the components could not know (a tool call in a session container
cannot be answered from a browser, so only a real question opens a group and
offers buttons), and
the look — the reasoning disclosure drawn as quietly as the tool calls beside
it, and one spinner (`components/Spinner.tsx`) wherever the registry shipped a
rotating icon.

Because those components are written in Tailwind utilities, Tailwind is a
build dependency rather than a style choice, and it compiles from source on
every build. `globals.css` is the whole design system: the tokens, and the
`@theme inline` block bridging them into Tailwind colours. That bridge is a
correctness requirement, not theming polish — Tailwind emits a utility only
for a colour its theme defines, so without it `bg-background` and every other
token utility the installed components use would silently vanish.

The browser speaks plain ACP to the gateway, so it is a client like any other
and the gateway stays client-agnostic. That is not only tidiness: this
dashboard replaced a separate chat application served alongside it, and the
gateway needed no protocol change to swap one for the other. An external ACP
client still attaches to the same endpoint, with the path shape below and the
`wsToken` the session's own summary carries.

```
AcpClient    ⇄ …/threads/:threadId/acp  JSON-RPC over one WebSocket, one thread
translate.ts   session/update*       →  an append-only message model (pure)
thread-store   the live thread          messages, modes, models, approvals, exec
convert.ts     that model            →  what useExternalStoreRuntime reads
```

An image is the one content block that is not prose, and it becomes a part of
its own. Three things send one: a chunk of what the agent or the user said, and
a tool call's result — which is how a screenshot arrives, the agent reading a
PNG back with `Read` and the adapter carrying it inline as base64. ACP has no
place for an image inside a tool call as far as a renderer is concerned, so
`convert.ts` puts it just after the card that produced it, derived from the
call's content on every conversion rather than stored — an update replaces a
call's content wholesale, and its images have to go with it. A block the
browser cannot load is said in words rather than dropped: assistant-ui admits
a data URL or an https one as a src and refuses the rest, so a plain-http
image becomes the link to it.

A message in the user's role is not always the user speaking. Work started in
the background — a command left running, a subagent, a monitor watching
something — does not answer into the turn that started it: it reports later,
and the way it reports is that the harness wakes the agent with a block of XML
sent as though the user had typed it. Left alone that arrives in the thread as
a bubble on the user's side with the tags still in it, which is what it used
to do. `lib/task-notifications.ts` reads the block back out,
`stores/thread/translate.ts` makes it a part of its own, and the thread draws
a quiet row across the conversation instead: an icon for how the task ended,
the summary, and what the task said. A monitor's event is shown, because
reporting it is the whole point of a monitor; a finished task's result is
folded under its summary, because a subagent's answer runs to pages and the
summary already says what happened. It reaches the runtime as a `data` part —
assistant-ui's one open part kind, keyed by name to the component that draws
it — because prose, pictures, files and tool calls are the whole of the closed
set and this is none of them.

The block travels as text, which is the same bargain the attachment envelope
makes and buys the same thing: it survives the adapter's transcript unchanged,
so a reconnected thread draws the row it drew live. One this build cannot
parse is left as the text it is, because showing the XML is a better failure
than dropping what a task said.

`translate.ts` being pure is what makes replay and live streaming the same
code path: a reconnect repeats the handshake, `session/load` sends the
history as ordinary notifications, and folding them rebuilds the thread. An
update kind this build predates is kept and rendered as nothing, so a newer
adapter cannot break an older dashboard.

**What a browser is sent on `session/load` is the gateway's own log of the
thread, not a replay from the adapter.** The gateway asks the adapter to
replay a thread exactly once, when it brings the thread up — at spawn for the
threads being watched, or the first time somebody opens one the spawn left
alone — and reads that replay into a per-thread log (`thread-log.ts`) that
nobody is sent. From then on every update it forwards live on that thread is
appended to the same log, the gateway's own prompt echoes included, so the
log is what a browser watching the thread throughout would have received. A
browser's `session/load` is answered from it without a round trip: the
adapter's modes and options as they stood when the thread was brought up,
kept current from the `current_mode_update` and `config_option_update`
notifications that change them.

The reason is that the adapter's replay and a running turn arrive on one
connection in one shape. The adapter serves a `session/load` while a prompt is
in flight and writes the transcript back as ordinary `session/update`
notifications, interleaved with whatever the turn is saying, and nothing on
either says which it is. There is no way to route that mixture to a browser
correctly: trim it at the message the browser holds and the turn's new
messages are dropped with the history in front of them; send it whole and the
message being written is folded into two pieces either side of an older one.
So the replay is never routed to a browser at all. It is read only when the
thread is otherwise silent — a thread just brought up on a fresh adapter has
nothing running on it, and nothing can be sent on it until the load answers —
and a reconnect mid-turn is served from memory, with the rest of the turn in
it and the adapter not asked.

A reconnect says how much it already holds, so it is sent only the rest. The
browser names the last message the adapter itself gave an id to, in `_meta` on
its `session/load`, and is sent the log from that message onward. A message id
is the anchor because it names a boundary between updates rather than a place
inside one, and the model is only the updates folded in order, so a fold that
starts at a boundary and a fold of everything reach the same thread. The named
message is re-sent rather than skipped, because a socket can drop halfway
through one.

Every way that can fail ends in the whole log. A browser with nothing the
adapter named asks for no resume; a thread that was re-minted under it is not
resumed; a message the log no longer holds means the log whole; and a browser
that no longer holds the message it named rebuilds from scratch. The answer —
`_boxes/replay`, resumed or not — always reaches the browser before the first
update, so it knows whether to keep what it has before anything arrives to
fold into it.

The log is bounded, at a few megabytes per thread, and drops its oldest
message when it grows past that — chunks, tool calls and all, so the cut never
leaves a message starting mid-sentence or a result without its call. What
goes is the top of the thread, which opens at its bottom: scrollback nobody
reaches. A browser that already held it keeps it; a fresh tab on a thread
whose traffic passed the cap opens on the last few megabytes, and the head
comes back the next time the orchestrator restarts and reads the transcript
in again. A thread the adapter turns out not to hold any more loses its log
along with its conversation.

A replay is folded in silence and published once. The notifications are the
same ones live streaming uses, so publishing each one would hand the view
every intermediate state of a conversation it is in the middle of re-reading:
on arrival at a box with any history the thread would assemble itself message
by message, with the viewport chasing the bottom of it. Instead the model is
built up with nothing emitted, and the snapshot that ends the replay is the
whole conversation — which the runtime's autoscroll opens at its end, because
that is where a thread is read from. `session/load` answering is what says the
replay is over:
the gateway forwards the adapter's notifications as they arrive and returns
the result only afterwards, so the answer means "that was all of it". A replay
that never answers publishes nothing at all: the connection is reconnecting,
the view says so, and half a conversation is not a better answer than the
whole of the previous one.

Until a replay has landed the thread shows a placeholder — a pulsing
conversation shape, and nothing that can be acted on. What was there before is
a composer over *How can I help you today?*, which is a claim that the thread
is empty: true of a box that has never been prompted, and on arrival at one
with a conversation in it both wrong and about to be replaced. A reconnect
mid-session keeps showing what it was showing, since the socket dropping is
not news about the conversation; only a first read shows the placeholder.

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

### Going back

Boxes is driven from a phone, where back is *the* navigation control — and in
an installed app on iOS it is the only one, since there is no browser chrome
and no Escape key. Two things make it unpredictable, and they compound.

A back control written as a `<Link>` pushes the view it leaves to, so sessions
→ thread → *back* leaves the stack as sessions, thread, sessions, and the
device's own back button then goes *forward* into the thread that was just
left. Two controls pointing the same way is what "back goes somewhere
unexpected" amounts to, and remembering where a visitor came from does not fix
it: a `from: 'list'` in the history entry's state still pushes.

And a dialog held in component state is invisible to the back gesture. The
press goes to the router, so the screen *behind* the dialog is torn down while
the dialog is the thing meant to be dismissed. The review has both halves of
that to answer for: a hunk sheet must not survive the press that closed the
file underneath it, and the comment composer must not go *with* the file in a
single press, taking whatever had been typed.

So every surface in the app is one of three kinds, and the kind decides what a
press does.

**Places** are routes — the list, a thread, the review, the details, the
forms. Only these push. Each has one structural parent, and leaving one pops
rather than pushes (`use-up.ts`): the entry the visitor came from is still on
the stack, so it is the one they get, and there is nothing to remember and
nothing to get wrong. The pop takes *everything* the view pushed in one step —
the files a review opened, the entries its dialogs left — so leaving is one
press and nothing of the view is left for a later press to fall into. Where
there is nothing of the app's below (a pasted link, a notification, a
home-screen shortcut, all of which start the stack inside the app) the parent
replaces the current entry instead: back then leads out of the app the way it
did before, which is what the browser's own button is for, and up leads to the
parent, which is what the app's control is for. The one thing a page can read
about entries it is not on is the running index React Router keeps in each
entry's state, and that index is what makes "leave" a computed delta rather
than a guess (`lib/history.ts`).

**Drill-downs** are a step inside a place: the review's open file, which is in
the search string so it stays linkable. It pushes on a phone, where the file
takes the screen from the tree, and *replaces* from `md` up, where the tree
stays beside it and picking a file is selecting in a sidebar rather than
travelling — an entry per file there would have back walking a reading history
nobody asked it to keep, while the header's own control says it leaves the
review. Closing pops when there is an entry to pop and rewrites the search
string when there is not, so both arrangements are right and so is a phone
turned between them.

**Modal surfaces** — dialogs, sheets, selects, the image lightbox — push a
*marker*: one history entry at the same URL. Nothing about the page changes,
which is the point; the entry exists to be popped. Back pops it and the
surface closes with the screen behind it untouched. Closing from the inside —
the X, the backdrop, Escape, a saved comment — pops the marker too, so a spent
entry is never left for a later press to spend itself on. The marker is pushed
before the paint that shows the surface, not after, or a press in the gap
would be spent on the screen underneath.

Two details of the marker are load-bearing. It carries the entry's state
forward, because a view reads its own state — which thread a review was opened
from — and an entry that dropped it would change how the view behaves purely
because a dialog had been open. And it is popped only while both the index and
the URL still match what was pushed: a replace keeps the index, and a
confirmation that acts and leaves does exactly that (deleting a session
replaces the entry with the list while its dialog is still mounted), so an
index-only check would pop the visitor back onto the session they had just
deleted.

All of it lives in the primitives under `components/ui`, so every dialog and
sheet in the app has the behaviour without its call site knowing, and the next
one added gets it too. The exceptions are deliberate: a popover and a native
select are dismissed by a tap anywhere and never cover the screen, and a
marker there would race the tap that dismisses them — Radix closes on the way
down, the click lands on whatever was underneath on the way up, and a pop
arriving after that link's push would undo the visitor's own navigation. So
back with a popover open leaves the view, and the popover is closed by the tap
that took the visitor there.

Terminal actions replace rather than push, which is the rest of the rule:
deleting a session lands on the list in place of the view that acted, and
submitting the new-session form spends the form's entry on the thread it made
rather than leaving a form underneath that would make a second box. What sits
*below* those entries may still name a session that is gone — history is the
browser's, not the app's — and the app already answers that with a page saying
so rather than a composer over nothing.

One thing sits outside the router entirely: the review's "Hand to agent"
stages a prompt in the thread's composer. The browser replays history state,
so carrying it there would let back and then forward re-stage it and bring
back a turn nobody typed. History state describes an entry and this describes
a handover, so it lives beside the router in a consume-once module
(`lib/staged-prompt.ts`).

`e2e/back.test.ts` drives all of it through `page.goBack()` against the real
bundle — the stack index after each press, the sheet that closes while its
file stays open, the confirmation that a back press must never answer, and the
deep link with nothing beneath it. Nothing in the suite pressed back before,
which is how the two halves of this came to disagree in the first place.

## Harnesses

A *harness* is an agent and the ACP adapter that drives it. Boxes carries two —
Claude Code behind `claude-agent-acp`, and OpenAI Codex behind `codex-acp` —
and which one runs a conversation is a property of the thread rather than of
the box. One box, one checkout, two agents working on it is the point, so
nothing about a session says which agent it is for.

`orchestrator/src/harness.ts` is the registry: one record per harness, and the
one place a harness-specific value is written down. Everything in it is a value
and nothing in it is behaviour. The modules that spawn an adapter, mint a
thread, materialize an agent set or read a box's process table ask the registry
what this harness wants and then do the one thing they do — so a third harness
is an entry in a table rather than a search through the code for every `if`,
and a harness needing something no field expresses wants a new field rather
than a branch at the call site.

| The record holds | Claude Code | Codex |
|---|---|---|
| `cmd`, the adapter exec'd in the box | `claude-agent-acp` | `codex-acp` |
| `processToken`, what that process is known by in the process table | `claude-agent-acp` | `codex-acp` |
| `residentProcesses`, what under it is the harness rather than work | `claude` | `codex app-server` |
| `defaultModeId`, what a fresh thread starts in | `auto` | `agent-full-access` |
| `forkModeId`, what a fork starts in instead | `plan` | `read-only` |
| `defaultConfig`, what a fresh thread is configured with | `model: opus` | nothing; the adapter's own defaults |
| `sessionMeta`, the `_meta` its session calls carry | the thinking options | none |
| `credentialId`, what must be stored before a thread can run | `claude` | `openai` |
| `env()`, the container environment it needs, holding a placeholder | `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` | `CODEX_API_KEY`, `CODEX_HOME`, `NO_BROWSER`, `INITIAL_AGENT_MODE`, `DEFAULT_AUTH_REQUEST` |
| `layout`, where an agent set is installed under `$HOME` | `.claude/CLAUDE.md`, `.claude/skills`, `.claude/commands` | `.codex/AGENTS.md`, `.agents/skills`, `.codex/prompts` |
| `alwaysBackground`, tools that background their work whatever their input says | `Monitor`, `Workflow` | none |

Two of those rows are decisions rather than readings. Codex's
`agent-full-access` default is one: its other two modes run every command under
bubblewrap, which needs unprivileged user namespaces that a container with
`CapDrop: ALL` and Docker's default seccomp profile is unlikely to grant, and
Codex's own documentation names the container as the boundary for exactly that
case. `CODEX_API_KEY` is another: Codex itself reads no key from its
environment, and what puts one in reach is the adapter, which logs itself in
with the method `DEFAULT_AUTH_REQUEST` names when a session call finds no
account. And the value in that variable is a placeholder, because a real secret
never enters a box — see [Token translation](#token-translation).

**The thread carries the harness.** `threads.harness` records it and defaults
to `claude`, which is what every row that predates the column runs. Nothing
moves a conversation from one harness to another: a transcript can only be
loaded by the adapter that wrote it. A fork is that rule read forward — it
stays on its source's harness and keeps what the source was configured with, so
the options a create request carries are ignored when it names a source.

**A session holds one adapter connection per harness in use.** It is spawned
when a thread of that harness first needs it, so a box with only Claude threads
never starts `codex-acp`, and a box with both runs two adapter processes over
one checkout. See [The ACP gateway](#the-acp-gateway) for what that splits and
what it shares.

**A harness runs when its credential is deliverable.** `/healthz` and
`GET /api/harnesses` report one entry per harness: the credential it needs, a
summary of what is stored for it, and whether a thread of it can run a turn
right now. Only the harnesses this deployment could deliver a credential to at
all are reported — a box holds one placeholder per entry of `CREDENTIAL_SET`,
so a harness whose credential is not in that set could not be given one
whatever the store held. Stored is not the same as usable: a credential can be
perfectly good and still not reach a box, which is what a subscription login
is, so the answer carries the reason as well. The dialogs offer every reported
harness and grey out the ones that cannot run, saying which of those it is.

**The catalogue is what a dialog offers.** A dialog cannot ask an adapter what
modes and options it has, because the thread it would ask about does not exist
yet, and starting a box to find out would cost a container per dialog. So
whenever an adapter answers `session/new`, `session/load` or `session/fork`
with modes or config options, both are cached against its harness in
`harness_catalog`, and `GET /api/harnesses` serves that beside the registry
entry and the health. A deployment that has never run a harness has no
catalogue for it: the dialog then offers the choice of agent alone, the thread
starts on the registry's defaults, and the adapter's first answer corrects the
screen.

## The ACP gateway

Two halves, in `orchestrator/src/gateway/`.

### Upstream: the session, and one connection per harness

`upstream.ts` owns what belongs to the *session*; `gateway/adapter.ts` owns
what belongs to one *adapter process*. `SessionManager` creates one
`UpstreamSession` per session on first use and keeps it for the process's life,
and that session creates an `AdapterConnection` for each harness a thread of it
runs, the first time a thread of that harness needs one — so a box with only
Claude threads never starts `codex-acp`.

The split is what makes two adapters in one box work. The session holds the
browsers, the reading of what the box is running, the permission requests
waiting for an answer, which conversation each message is about, the tap into
`acp_log`, and the container, which is started once however many adapters want
it. A connection holds its exec and its streams, its spawn, the `initialize`
answer it caches, the set of ACP ids that process is holding, its own replay
counter and its own board of running tasks. A load on one harness therefore
cannot mask live activity on the other, and an adapter that exits tears down
its own conversations and leaves the other connection running.

Starting a connection, in `ensureStarted`:

1. Start the container and make sure the egress proxy is attached. Two
   connections coming up at once share that work rather than racing over it.
2. Spawn the harness's `cmd` as a `docker exec` with `Tty: false`. Docker frames
   stdout and stderr into one stream, so the streams are demuxed. stdout
   carries newline-delimited JSON-RPC; stderr is log-only.
3. Send `initialize` advertising one client capability: the async-task
   extension, under the namespace both adapters read it from. Nothing else — no
   filesystem, no terminal, no elicitation — which confines adapter-to-client
   traffic to `session/update`, `session/request_permission` and the task
   updates. The response is cached verbatim, on this connection.
4. Replay this harness's threads. The session's *default* thread with
   `session/load`, or, when it has none or the adapter no longer holds it, mint
   one with `session/new` and store its id. Then re-issue `session/load` for
   every other thread of this harness an attached browser is watching, so a
   respawn brings back every conversation somebody is already reading rather
   than only one of them. A watched thread the adapter cannot bring back has its
   browsers' sockets closed, because the id they hold is one the adapter would
   now reject; each reconnects and pins whatever that thread is next. The
   session's remaining threads are brought up when somebody opens one; see the
   pinning below.

Every thread is then put back into what it is meant to be: its mode, and then
the map of adapter config options its row records — a model, an effort level,
whatever else that adapter offers. Each is one `set_config_option`, sent only
where the adapter offers that option and its current value differs. The model
is the one entry with a fallback, because its ids move: a value the adapter no
longer lists resolves to a bracketed variant of itself, such as `opus[1m]`,
which is the same model with a different context window, and otherwise to the
harness's default model. Everything else is sent as it was recorded, and a
value the adapter rejects is logged rather than fatal — the adapter's own
answer is what corrects the dashboard.

**The mode is excluded from that map on every path**: never written to it,
never replayed from it. Both adapters also echo the mode as a config option
with `category: 'mode'`, and a thread put into its mode by two mechanisms is
how the two answers come apart. The mode travels through `session/set_mode` and
`threads.mode_id` alone, which is also why the dashboard hides that option from
the settings list.

A fresh thread starts in whatever the dialog chose, or in its harness's default
when it chose nothing, which is what an empty column already means. A fork is
the exception and records its mode: it starts in its harness's *fork* mode —
`plan` under Claude Code, `read-only` under Codex — because it shares the
thread it came from's checkout and the point of one is to ask about work the
original is still doing, so it starts in a mode that reads rather than writes.
That does not fix the shared workspace; it stops the common accident, and
flipping the fork back is one tap in the header. An adapter offering no such
mode leaves the thread wherever it starts, and a switch that fails is logged
rather than failing the spawn.

`threads.mode_id` and `threads.config` exist because the adapter forgets both.
They live in that process and nothing else, so without the row every respawn —
an idle stop and a return, a deploy, an adapter that died — would hand the
conversation back in whatever the adapter starts in, and a thread left in `auto`
would return on manual approvals half an hour later. `session/load` brings the
conversation back and nothing else, so both are read on every load rather than
only at the mint.

They are written wherever the answer changes. A `session/set_mode` or a
`session/set_config_option` the adapter accepts is recorded as it passes
through the gateway, because that is the request the user made and because both
adapters answer a change with their whole option list. `current_mode_update`
and `config_option_update` are recorded as they arrive, because an adapter also
changes things on its own — leaving `plan` when a plan is accepted, a slash
command switching a model, a fallback under load — and a thread should come
back where it ended up rather than where it was last sent. Which option is the
model is read from its `category`, never from the adapter's id for it.

**`_meta` comes from the registry.** `session/new`, `session/fork` and
`session/load` carry whatever the harness's `sessionMeta` says and nothing
otherwise. Only Claude Code asks for anything: `_meta.claudeCode.options.thinking`,
which is where its adapter reads options to lay over the ones it hands the
Claude Agent SDK. It asks for `display: 'summarized'`. Current models default
that to `omitted`, which streams thinking blocks carrying a signature and no
text, so the adapter has nothing to put in an `agent_thought_chunk` and the
reasoning disclosure in the thread never appears at all — the agent was
thinking and saying so, and the words were not on the wire. The budgeted
`enabled` form rather than `adaptive`: on a current model the two are the same
thing, and `adaptive` is a flag an older one can reject, while which model a
thread runs is chosen from the header's settings long after this is fixed.
Codex reads no `_meta`, and sending it something it does not know would be
noise on the wire.

**`initialize` is cached per connection**, because the two adapters advertise
different modes and different session capabilities and a browser has to be told
what the agent holding its conversation says. Which one it gets is settled
downstream, at the pin.

**`canFork` is a fact about a thread**, for the same reason. Both adapters
advertise `sessionCapabilities.fork`, but the answer comes from each
connection's own `initialize`, so `ThreadSummary.canFork` is what the fork
button reads and a harness whose adapter has not been reached reports false
rather than being assumed.

A spawn that fails is retried three times, waiting 1, 3 and 8 seconds. After
that the session's status becomes `error` — but only for a thread that needed
*that* connection: a connection failing while the other runs logs, clears its
own threads and is respawned by the next message on one of them.

**An adapter with no account is a configuration problem, not a spawn failure.**
Codex's adapter checks authorization on every session call and logs itself in
from the environment first, so a box holding a placeholder for a credential
nobody has stored answers `session/new` with JSON-RPC `-32000` and a message
beginning `Authentication required`. That is matched on both halves and treated
as what it is: no retry, the session's status left alone, the connection kept
up, the browser's request failed with the adapter's own message, and one line
in the log naming the credential that is missing. Claude Code's adapter offers
no auth method Boxes uses and fails inside the turn instead, with a 401 from
the API.

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

When an adapter exits on its own, its connection is torn down and nothing
reconnects immediately: its threads' turns are cleared, its tasks dropped and
its browsers told, and the other connection is not touched. The next forwarded
message for that harness calls `ensureStarted` again, which re-spawns and
re-issues `session/load`. A deliberate stop sets a flag that suppresses even
that.

**Routing.** A forwarded message goes to the connection holding the
conversation it names; failing that, to the connection for that conversation's
stored harness; failing that, to the one the sending browser's own thread is
on; and failing all of those — `authenticate`, `session/list`, a message about
nothing in particular — to the session's default harness, which is whatever its
current thread runs. A thread lookup takes the harness and the ACP id together,
as hygiene rather than because a collision is expected: both adapters mint
UUIDs, and the in-memory maps in `Broadcast`, `Activity` and `PendingStore`
stay keyed by the id alone.

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
exists: a connection is pinned for its whole life, so there is no later point
at which to find this out.

The upgrade is authenticated on the handshake. A browser cannot set an
`Authorization` header on a WebSocket, so a client offers the token as a
`bearer.<token>` subprotocol entry alongside `acp.v1`. The gateway compares it
in constant time against the token of the session the path names, and selects
`acp.v1` explicitly rather than relying on the client to list it first.

Each session has its own token, minted when it is created and carried in its
own summary, so a token that leaks reaches that one session rather than every
session in the deployment. Authentication comes before disclosure: a session
that does not exist is answered the same 401 as a wrong token, because `/ws`
is the one endpoint the operator's proxy does not sit in front of, and a 404
there would say which session ids are real to anyone who asked. The 404 above
is for a thread, and it is reached only once the session's token has proved
the caller may know.

Which thread the connection is on is settled once, at attach, and needs the
adapter first. Pinning is where a thread the spawn did not reach is brought
up: it resolves the thread's harness, starts that connection if nothing has
yet, and loads the thread there when the process is not already holding it —
on the same terms as at spawn, with that harness's `_meta` and the mode and
config the row records put back afterwards. A stored ACP id says a thread had
a conversation once, not that the process running now knows about it, so
handing one back
unchecked left the browser's own `session/load` to rebuild the thread instead,
and the adapter rebuilds one in the mode it starts in: a thread left in `auto`
came back on manual approvals, without this deployment's thinking options
either. A thread minted and never prompted has no conversation to load, and
gets a freshly minted one in the mode and config its row records. Concurrent
tabs opening the same thread share one bring-up. The handle counts as attached
from the moment the socket opens — that is what the reaper counts — and
nothing is routed to it until its thread is settled.

Three methods are answered or reshaped rather than forwarded:

- `initialize` returns the response cached by the adapter holding this
  connection's thread, so its `_meta` extensions reach the browser intact and a
  browser is told what the agent it is actually talking to advertises. The
  handler awaits the pin for that, which costs it nothing it was not already
  waiting for.
- `session/new` returns the ACP id of the thread this connection is pinned to.
  Which thread that is, is decided outside ACP, so a browser or an external
  ACP client speaks the same contract either way: a `session/new` that hands
  back an id the client did not choose.
- `$/ping`, which some ACP clients send every 25 seconds, is dropped before the
  SDK sees it. JSON-RPC forbids replying to a notification. The dashboard
  sends none.

Everything else in `FORWARDED_REQUESTS` and `FORWARDED_NOTIFICATIONS` goes
upstream untouched, `_meta` included, once the pin has settled. A request
naming a thread that is not this connection's pin is refused rather than
forwarded: a connection is pinned in both directions, so it can neither be
sent another thread's updates nor act on one. Detaching removes the handle
from the broadcast set and touches nothing else.

A browser that cannot keep up is disconnected rather than buffered without
limit. Once what is queued for its socket passes a ceiling the gateway closes
it, and the reconnect resumes from what it already had.

### Who each update goes to

`broadcast.ts` decides. Sending every update to every browser is almost
right, and wrong in two places that only appear with more than one attached —
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
  copy. A transcript being read into the log is exempt: there the adapter is
  reading back history the gateway never saw, and nobody is sent it anyway.
- **The adapter's replay reaches no browser; a browser opening a thread is
  sent the log.** A `session/load` the gateway itself issues fills the log of
  the one thread it names and is delivered to nobody — the tab already on
  that thread has the thread — and another thread's live updates go on as
  before, which is the bug two open tabs hit first. A browser's own
  `session/load` never reaches the adapter: it is answered from the log,
  whole or from the message the browser named. A fork's log starts as a copy
  of its source's, re-tagged as the fork's, because the browser reading it is
  pinned to the fork — see *Several threads per session*.

### Several threads per session

A workspace an agent has already prepared is worth keeping; the context it
built up on the way there is often not. So a Boxes session owns several
threads, and two things make new ones: **New thread** starts an empty one on
the same workspace, and **Fork** branches the one you are on so an
investigation can go two ways without disturbing the original. Everything else
about the session is shared, so an extra thread costs nothing but its own
transcript — and a new thread names the harness it runs, which is how one box
comes to hold a Claude Code conversation and a Codex one over the same
checkout.

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

Whether an adapter serves two prompts concurrently is not settled here. The
wire allows it — the ACP SDK keys pending responses by JSON-RPC id with no
write queue, so two `session/prompt` calls naming different threads can be in
flight on one connection — but each adapter holds every thread of its harness
in one process and may queue the second behind the first. Two threads on
*different* harnesses are two processes and do not queue behind each other at
all. Nothing in the UI claims either way: each thread's own bullet reports what
that thread is doing, which is true whatever the adapter does.

The adapter is not the source of truth for which threads exist. `session/list`
returns only threads that have a transcript on disk, and a thread minted but
never prompted has none, so Boxes keeps its own record in the `threads` table.
A thread goes by the title the agent generates — the adapter pushes it as a
`session_info_update` at the end of a turn, and it is written to the row the
update's own ACP id names. Until it has one, a thread goes by the first line
of the prompt last sent on it, which the gateway writes to the same column on
the way past. The agent's title cannot arrive before the turn ends, and a
first turn that runs for ten minutes would otherwise be ten minutes of a
thread called nothing but a number. The name is taken from every prompt until
a title lands, rather than from the first one only, so a thread the adapter
puts back on its ordinal — an explicit null clears the column — is named
again by whatever is asked next. The attachments envelope is passed over: it
is the dashboard's own words rather than the user's. A thread nobody has
prompted has neither name, and goes by its ordinal, which is per session and
never reused.

Forking is offered only when the adapter advertised
`sessionCapabilities.fork` in its `initialize` answer, which the orchestrator
already caches verbatim — per thread, since the answer is per adapter and a box
may be running two. The capability is marked unstable in the ACP schema, so an
adapter that drops it costs the dashboard a button rather than a build.

**A fork's log starts as a copy of its source's.** The adapter branches the
conversation in full — the fork knows everything the source said — but it
writes the fork no transcript until the fork is first prompted, so a fork has
nothing of its own to be read in and would open on a blank screen claiming to
know a conversation the reader cannot see. So when a fork is minted, the
source's log is copied into it, every update re-tagged as the fork's, and
from there the fork's log grows with what is said on the fork. A source no
browser has opened on this adapter is brought up first, so there is a log to
copy. Until the fork's first prompt the adapter cannot load it back, so
`threads.inherits_from` records the source: a fork that had not been prompted
before a respawn is branched again rather than started empty, because
carrying that context is the only reason it exists, and its log is copied
again from the source's. A fork of a fork follows the chain to the first
thread up it with a transcript of its own.

That first prompt is where the column is cleared: the adapter starts a
transcript for the fork at that moment, opening with everything the source
had said, so from then on a respawn loads the fork back like any other thread
and reads that transcript into its log.

A running turn and a waiting permission request belong to the thread, not the
session. `threads.turn_active` records the first, and the session's answer is
derived as any of its threads — two sources of truth for whether a turn is
running is the thing that goes stale. A permission request records
the thread that asked, goes to a browser watching *that* thread, and queues
when only another thread's browser is attached, exactly as it does with none.

**A thread can be marked done, and that is a note to the reader.** A box
gathers finished conversations, and the row that says which one you were last
in says nothing about which ones you are through with. So the thread view
carries a toggle, `threads.done` records it, and the list draws a marked
thread struck through. Nothing else reads the column: a thread marked done
keeps its adapter conversation, goes on running whatever it was running,
answers a prompt as it always did, and is marked undone with the same button.
It is not a delete and not an archive — both of those change what the thread
can do, and this changes what a row looks like.

Deleting a thread is not implemented, though the adapter supports
`session/delete`. The debug log and the terminal stay session-scoped: the
first taps one adapter connection and the second opens one shell, and both
belong to the box rather than to a conversation.

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
  against the thread's ACP id and a notification is pushed. The next browser
  to attach *to that thread* gets its queued requests delivered to it, and
  only those. Every browser on the thread holds its own copy of the question,
  and the first answer withdraws it from the rest, so a second device stops
  waiting for something already decided rather than being quietly ignored.
- After `PERMISSION_HOLD_MINUTES`, `PERMISSION_FALLBACK` decides. `hold` keeps
  waiting. `deny` answers with a reject option taken from the request's own
  options list, never an invented one, and cancels the request when none is
  offered. Nothing auto-approves.

### Work left running in the background

A turn that backgrounds something ends like any other. The agent says it will
report back, the thread goes quiet, and with the browser closed every test the
reaper makes says the session is idle — so half an hour later the container is
stopped, and the build, the crawl or the monitor inside it goes with it. The
failure is silent: the thread's last line is still the agent promising to
report, and the report never comes.

Two things already covered part of this and neither covered it all. A
background *subagent* holds its turn open — the adapter defers the prompt's
result until the subagents it spawned settle — so the session counts as running
a turn for as long as one is alive. And a task that keeps talking keeps its box
awake by talking, because every adapter update marks the session active. What
was left was the quiet task: a command compiling for two hours, or a monitor
watching a log that says nothing.

`gateway/background.ts` answers two questions that are not the same question.

**What a person sees comes from the adapters.** Both harnesses implement the
same async-task extension, at the versions the image pins: the same capability
name, the same three update names, the same stop request. So one translation
serves both. Boxes advertises `asyncTasks` at `initialize` — without it neither
adapter sends a task update at all — and from then on a backgrounded command is
a thing the agent announced rather than a line parsed out of a process table.
An `async_task_spawned` puts a `BackgroundProcess` on the thread its `sessionId`
names, carrying the adapter's own task id, the command or description it sent
as the name, what kind of task it is, and whether it can be stopped. An
`async_task_state_update` whose state is `completed`, `failed` or `stopped`
takes it off again; `running` and `paused` leave it where it is. Claude Code
also sends `async_task_progress`, which may rename a task and is required to
carry nothing. Codex sends no progress and, as its source has it, no `running`
either: a task is spawned and then terminal.

`TaskBoard` holds them, one board per adapter connection, keyed by thread.
Tasks go with the process that announced them: an adapter that exits drops
every task it announced and re-sends the thread states, and nothing
re-announces them on the respawn. Neither adapter can — Claude Code's replay
mentions tasks nowhere, and Codex's reconciles against a fresh app-server that
owns none of the old terminals — which is the case the floor below exists for.

The stop is `_session/async_task/stop` with the thread's ACP id and the task
id, sent on that thread's own connection.
`POST /api/sessions/:id/threads/:threadId/background/stop` keeps its shape and
`processId` in its body is now the task id; the adapter answers whether it
stopped anything, and the thread's state is re-sent either way so the bar
catches up on a task that had already finished.

**The SDK had to be stepped around for this.** The ACP client installs a
session-update router ahead of every handler an app registers, and that router
parses each `session/update` against the schema it was generated from — a
strict union of the update kinds that existed then. An update outside it throws
there, and a handler that throws takes the whole message with it: nothing else
sees the frame, however raw a parser the app asked for. The async-task
extension is by construction outside any generated schema, so every frame this
rests on was being logged as invalid params and dropped. So the connection
reads the bytes one step earlier, lifting those lines off the adapter's stdout
before the SDK parses them and delivering them by the path the SDK would have
used. Everything downstream is unchanged — the update is tapped, its thread is
touched, the browsers watching are sent it, the board reads it — and what it
costs is strict ordering against the frames still going through the SDK's own
parsing: a bar may appear a beat before the tool call it belongs to, which is a
level rather than a sequence and reads the same either way.

**Whether the box is busy comes from the box.** The reaper's question has to be
answerable when no adapter is running and when not every thread is loaded, and
no event can answer it: a respawned adapter knows nothing about the shells the
one before it left running, so after a restart the bars are empty and the build
is still compiling. So the process reading stays, reduced to one answer about
the whole box rather than one per conversation — `docker top` over the
container, and `readBox` over what it prints.

Resident is a short list, and everything not on it is work: PID 1 and the
`sleep infinity` the entrypoint holds the container open with; every adapter,
found by its harness's `processToken`; every adapter's direct children, which
are the agent processes, `claude` under `claude-agent-acp` and `codex
app-server` under `codex-acp`; anything matching a harness's
`residentProcesses`, which is where a long-lived helper of either agent goes;
and the `ps` that took the reading. Everything else — a shell under an agent, a
build orphaned to PID 1 by an adapter that died, the shell behind an open
terminal — is work and holds the box. Under Codex's sandboxed modes a
command sits three wrappers down, and every one of those wrappers is that
command's own and correctly reads as work. The rule has to know both harnesses'
tokens: left with one it silently reads the other harness's box as empty, and
an invisible build gets suspended half an hour later.

Finding the adapters is the one subtle part. The token is on the *agent's*
command line too — `claude-agent-acp` is a package name, and the CLI it spawns
lives inside that package's own `node_modules` — so a process carrying a token
counts as an adapter only when no harness's `residentProcesses` pattern matches
it and nothing above it carries a token either. Either test alone is enough,
and getting this wrong is expensive in one direction: an agent read as an
adapter makes the shells under it read as agents, which is work made invisible.

Whose work it is, is no longer asked. `codex app-server` runs every Codex
conversation of a box in one process and names none of them on its command
line, so the process table cannot answer it — and it no longer has to, because
the adapters name the work they know about and this answers the only question
left, which is the reaper's.

**The events decorate the reading. They never replace it.** A missed event
costs a name on a bar. A missed reading costs a build. The difference is an
edge against a level: a count of transitions is wrong forever after one is
missed, while a reading of what is running now cannot drift, cannot wedge, and
needs nothing reported at all. A container the daemon will not answer for is
the one silence there is — the last answer stands until a reading settles it,
because stopping a box late is recoverable and stopping one with a two-hour
build in it is not.

**An empty box is empty, whatever the reason.** A reading that finds nothing of
Boxes' own — no adapter, no agent — counts as empty rather than as a shape this
cannot understand. Boxes spawns adapters as execs and keeps none there between
connections, so a container that is up and has never been opened, or that has
outlived the orchestrator process that opened it, runs the entrypoint and
nothing else. Counting that as busy would put "still running" on its card with
no thread able to say what, *and* would keep the reaper off it forever, because
the reaper asks this same question. A stopped session is the same answer from
the other side: nothing to ask, read as nothing answering.

**A level has to be pushed as well as read.** Nothing reports a build
finishing, so a reading is the only news there is — and a reading only happens
when somebody asks. The reaper asks when it sweeps, which is what the lazy
refresh behind the probe is for. A person looking at a thread is the other
reader, so the probe polls every `BACKGROUND_POLL_SECONDS` while a browser is
attached, and pushes a fresh thread state to the conversations whose work
changed — only those, so a poll over a quiet box says nothing at all.

**The kill stays, for the work no task claims.** After a respawn the bars are
empty and the box is busy, and a signal is the only thing that can stop the
orphaned build. `POST /api/sessions/:id/background/stop` — session-level —
reads the box from inside, TERMs every pid the reading calls work, leaves
before the branches they hang off so nothing is orphaned into a reading that
can no longer see it, and KILLs whatever is still there two seconds later. The
escalation is not waited for: the answer says what was signalled, and the next
reading says what died.

The pids need care. `docker top` runs `ps` on the *host*, so its pids are the
host's numbering and mean nothing inside the container where the kill has to
happen — the box is read again from inside, through `ps` there, at the moment
the stop runs. The session image installs procps and asserts `ps` for this
reason as much as for a person's.

### Is the agent talking, or is it your turn

Boxes had one bit per thread — a `session/prompt` this gateway forwarded has
not come back — and read three separate things off it: the agent is producing
output, you may not type, nothing more will happen until you do. Background
work pulls those apart in both directions. A turn that spawns a background
subagent keeps its prompt open long after the agent has finished, so the
browser showed a stop button and no way to send while the thread sat waiting
for its reader; and a task reporting in wakes the agent with no prompt open at
all, so that turn's output arrived while the same bit said the thread was
idle.

ACP has no word for it: no "the agent is done for now" notification, no stop
reason on a prompt being deferred, and the moment worth reporting is by
construction the moment nothing arrives. This adapter does say it sideways,
though — `claude-agent-acp` emits a `usage_update` at the end of every
processing cycle, and that one carries a `cost` where the ones it sends while
a message streams do not. `gateway/activity.ts` reads it, so a held turn and a
cycle the harness woke on its own both end the instant they end.

That marker is one adapter's own rather than anything ACP promises, and it
appears only when the backend reported usage — and `codex-acp` sends no
`usage_update` with a cost at all, so for a Codex thread the fallback is the
whole answer. Silence is that fallback, and the same file infers it: an update
from the agent says it is working, and silence lasting `AGENT_QUIET_SECONDS`
says it has stopped. The one exception
is a tool call the agent is waiting on, which is evidence where silence is not
— a thread with one open stays speaking however quiet it goes. A call that
runs *in the background* is not counted, which is why this and `background.ts`
share the one predicate that decides which those are. It reads the marker both
adapters put on a backgrounded call's own update first, and falls back to the
tool's input and to the harness's `alwaysBackground` names — Codex has no
"run in background" flag and no tool name on its calls, so for its shell calls
the marker is the whole of the answer.

Which calls hold a prompt open is the adapter's rule, not a guess: it defers a
turn's settlement for the **subagents** it spawned and for nothing else — a
backgrounded command or a monitor never holds one. A prompt sent into a
deferred turn is accepted and hands the held turn off, so the composer is safe
to offer send there. Both were read out of the adapter's own
`dist/acp-agent.js` rather than inferred from behaviour.

Two thresholds, because the two readers want opposite things. The screen flips
at `AGENT_QUIET_SECONDS` and can afford to be wrong for a moment: an early
flip offers a send button while the model thinks between tool calls, and
sending was allowed anyway. The notification waits for `AGENT_SETTLE_SECONDS`,
because "your turn has finished" on a lock screen is a claim there is no
taking back.

So `_boxes/turn_state` carries three facts rather than one — a prompt is open,
the agent is speaking, and here is what is still running in the background —
and every browser is told all three after its replay and on every transition.
`TurnStateParams` is the shape. The dashboard shows `speaking` wherever a
reader is told whether the agent is working — the composer's send-or-stop, the
spinner, follow-output, the list badges — and the outstanding tasks in a bar
above the composer, which is a standing fact about the box rather than
something that happened, and so does not belong in the transcript. A tab title
has to pick
one word for all of it, and `lib/tab-title.ts` is where the four are named:
`⚠` and `?` for a thread that has stopped and needs an answer, `⟳` for one
that is talking, `◍` for one that is waiting for you with work still running,
`○` for one that is waiting with nothing running.

### Notifications

Two events are worth interrupting somebody for: a permission request has been
queued, and a turn has finished and is waiting for somebody. Both are
announced from the gateway through `notify.ts`, and both are gated on the same
condition — **no browser is watching that thread**. That is not a heuristic
about attention, it is the same test that decides whether a permission request
is queued in the first place, so the two agree about what "you are not here"
means. An approval also carries a floor of one announcement per thread per
hold window, so an agent asking in a loop cannot turn a lock screen into a
notification feed. A turn finishing
in front of you is the screen you are already looking at.

The finished turn is announced when the agent goes quiet, not when the prompt
comes back: a request coming back says the request is over, which for a turn
holding a background subagent open happens hours later, and a turn the harness
started on its own has no request to come back at all. See *Is the agent
talking* above.

The announcement names the conversation, not only the box, and says what is
still running in it. With two threads live, "your session needs you" is not
something you can act on from a lock screen, and "two tasks are still running"
is the difference between a thread you can come back to whenever and one that
is about to say something else on its own.

`Notifier` sends one event and the gateway's side awaits none of it. A turn
already waiting on a human must not also wait on a push service, so every
failure inside is logged and swallowed.

- **Web Push** (`push.ts`), to every browser that subscribed: RFC 8291
  `aes128gcm` payload encryption over RFC 8188, authenticated with an RFC 8292
  VAPID assertion. This is what survives the app being closed, which is the
  reason the feature exists — and it is the only channel, deliberately: a
  second one that reached a third party would be Boxes telling somebody else
  which of your boxes wants you and when.

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
that is the ordinary end of one, not an error. A subscription also records the
key it was made under, and one made under any other key is dropped at the next
fan-out rather than being retried for the life of the deployment: a rotated
key makes every older subscription unusable, and the failure it answers with
is neither of the two that mean "gone".

Delivery needs two things Boxes cannot provide for itself. The Push API does
not exist on a page served over plain HTTP (`http://localhost` excepted), so
push works on the loopback default and behind a TLS reverse proxy and nowhere
else. And iOS exposes it only to a page added to the Home Screen, which is why
the dashboard ships a manifest and why the toggle tells an uninstalled iPhone
to install rather than that it cannot.

### Being installable

Which makes the install a feature rather than a nicety, and it has one
requirement that is nowhere in the manifest. A manifest is fetched with
credentials omitted unless the link says otherwise, so behind the
authenticating proxy every deployment past loopback is supposed to have, the
single request that decides whether a browser offers the install is the single
request that arrives without the session cookie. The proxy answers it with a
redirect to a login page, the browser is left with no manifest, and nothing
else on the page is affected — the failure is a missing offer, not an error.
`index.html` asks with `crossorigin="use-credentials"`, and `e2e/pwa.test.ts`
puts the deployment behind a cookie check and asks Chrome itself,
over CDP, whether it would install what it found. That test needs a real
profile: Chrome refuses to install from an incognito context, which every
`newContext()` is, so `launchProfile` in `e2e/browser.ts` gives it one.

iOS is told twice. Safari offers Add to Home Screen whether or not a manifest
loaded, and an icon that opens a browser tab has a browser tab's Push API, so
`apple-mobile-web-app-capable` states standalone in the markup where nothing
can fail to fetch it, and `apple-mobile-web-app-title` names the app before
the document title starts tracking what a thread is doing.

The service worker is registered on load, by `installWorker`, and not by the
push toggle. Registering it from `refreshPush` would have skipped exactly the
browsers that need it: that function returns at the first blocker, and the
blockers are an iPhone that has not installed yet and a user who has declined
notifications once.

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
   configuration to `${DATA_DIR}/agents/<id>`, create the home directory
   `${DATA_DIR}/homes/<id>` and fill it from the image, create the container
   `session-<id>`, and start it.
6. Insert the box's first conversation as a row: which harness it runs, and
   what it is configured with. Nothing is minted with the adapter here — a
   thread with no adapter-side conversation is a state the gateway already
   handles, since it is what an adapter restart leaves behind, and the first
   browser to open the box brings it up. So creating a box costs no adapter
   spawn, and a box can be created for a harness whose credential has not been
   entered yet.

Any failed step tears the whole session down and marks it `error`. What the
first thread is to run is checked before step 2, so a request naming an agent
the registry does not have is a 400 rather than a box built on the way to
one.

The container's `HostConfig` is a fixed template that user input never reaches.
It runs as `SESSION_UID:SESSION_GID` — numbers rather than the image's `agent`,
so one setting decides who a session is. The default is 1020, deliberately off
the 1000 the `ubuntu` base account holds, as does a host's first login user.
The session image builds its `agent` user on the same numbers, because a
session's home is a named volume Docker ownership-initialises from the image
and nothing outside the container can chown it afterwards; `ensureSessionImage`
reads the image's own user back and warns when the two have drifted. Pointing
the orchestrator's own user at `SESSION_UID` is what lets it drop root, since
the workspace chown then has nothing to do. That is a deployment's own
arrangement — a `user:` on the orchestrator service and a data directory
owned by the same uid — rather than something the shipped compose does.

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
| `error` | Creation failed, the adapter would not start, or a directory the box is made of is gone |
| `deleted` | Removed. Nothing moves a row out of this state |

Deleting stops and removes the container, detaches the proxy, removes the
network, the workspace directory, the home directory and the materialized agent
configuration, and clears the session's pending requests and log rows. Nothing
refers to any of it once the session is gone, so it goes with the session rather
than being left orphaned. The tombstone is written first, under the session's
own slot in the operation queue, and the writers that could still be in flight —
the debug log, the exec log — refuse a row for a session that carries one, so a
delete cannot be undone a moment later by work that had not finished.

At boot, `reconcile` lists containers by the `boxes.session` label and aligns
the stored rows with them: live containers are adopted, missing ones are marked
stopped, and every running session's proxy attachment is re-checked. Turn flags
are cleared, because a turn cannot survive the restart that killed the
connection owning it.

**A container that is gone is made again.** Everything a session container is
comes from the row and the two directories it points at — image, network,
mounts, environment — so a container is reproducible and losing one costs
nothing durable. Without a rebuild, `start` would hand the missing id to the
daemon and take the 404, leaving the workspace and the home intact on the data
volume and unreachable through Boxes. `restoreMissingContainer` rebuilds it,
and makes the network too, since a prune that takes a stopped container takes
the network that then has nothing on it. This is not an exotic case: `docker
container prune` takes every stopped container, and an idle Boxes session *is*
a stopped container.

Only for a container the daemon says is **not there**. `unknown` — an inspect
that failed for any other reason — is left alone, because rebuilding on that
would replace a container that is running perfectly well behind a sick daemon.
And all three ways a box starts do it: `start`, a local command through
`execTarget`, and opening a thread, which starts a stopped box through the
gateway's own path rather than through `start`. That last one is why the
gateway's `beforeStart` seam is awaited and the row re-read after it — the
repair may have changed the container id the caller is about to use.

Every repair asks Docker a question and acts on the answer, which is only safe
while one of them runs at a time. Three of those ways in can arrive at once,
and the reaper is a fourth, so two starts could have one remove the container
the other was about to use. **Each session has an operation queue**, one slot at
a time, and every mutating operation takes it: create, start, stop, delete, the
repairs, a local command, and the gateway's own seam. Reads never queue.

Waiting is the answer for an ordinary request, because these are seconds rather
than minutes and the one slow case — a first pull — is a spinner either way.
Stop and delete are the exception: they mark whatever is in flight as
pre-empted and take the slot behind it, so the work gives up at its next step
rather than the stop waiting out a start it is about to undo. The reaper never
waits at all; a busy session is skipped and tried again next tick. Re-entering
is impossible by construction rather than by care: the queued method is a
wrapper whose only job is to take the slot, and the work lives in an unqueued
form that nothing inside a slot can call back into.

**Shutdown drains.** SIGTERM stops the background loops, stops listening, and
then gives running turns a bounded moment to reach a settle point before the
adapters are torn down. A turn still going when that runs out is cut and said
so in the log, but the common case — a deploy landing while somebody's agent is
mid-answer — no longer ends the turn the instant the signal arrives. The grace
is deliberately shorter than the container stop grace it sits inside, so the
process finishes on its own terms rather than being killed part-way.

## Where a session's files live

A session's workspace is a directory under the orchestrator's own data
directory — `${DATA_DIR}/workspaces/<id>` — bind-mounted at `/workspace` in
the session container. A named volume, mounted only into that container,
would leave the orchestrator with no filesystem path to the agent's work at
all, and reaching a file would mean a `docker exec`.

The directory is what lets the review read a session's files without an exec
round trip per read. That reading is the orchestrator's own, and it is why the
review layer keeps symlink containment as a maintained invariant, in one file
with a test: the process holds the Docker socket, and the content it is reading
belongs to the agent.

Git is the exception, and it runs nowhere near this process. A repository's own
configuration can name a program for git to run — a clean or smudge filter is
enough, and no git option turns that off — so asking git about a workspace
here would let the agent choose a command the orchestrator executes. Every git
invocation is a `docker exec` in the session's own container instead, as the
agent, which is the one place where running what the repository asks for is
already the agent's own privilege rather than a boundary being crossed. The
cost is that a review needs the box up, so opening one starts a stopped
session.

**The home followed it**, for a plainer reason: everything a session is should
be in one place, and the biggest thing a session owns was the one thing Boxes
could not see. `${DATA_DIR}/homes/<id>` is bind-mounted at `/home/agent`, 0700
rather than the workspace's 0755 — it holds thread transcripts, the tool caches
and installs an agent accumulates at runtime, and whatever credential a login
inside the box wrote. A named volume was never a boundary against this process
anyway, only a path it did not have: the volume sits on the same host under the
same root. Review still has no business there, and does not go there.

**A bind is not seeded, which a volume was.** Docker fills a new named volume
from the image's own `/home/agent`; a bind mount covers it instead. The image
keeps that directory near-empty on purpose, so it is easy to assume nothing is
lost — but `useradd -m` leaves a skeleton `.profile` there, and Debian's
`/etc/profile` *reassigns* `PATH` for a login shell, so that skeleton file is
what puts `~/.local/bin` back. Exec runs `bash -lc`. Without it, a tool the
agent installed with `npm install -g` would stop being found by the next
command, silently, in login shells only. So `seedHomeFromImage` copies the
image's home in through a one-shot root container — `cp -a`, preserving the
ownership the image gave it, and chowning the directory itself in the same
breath, which is what makes a home come out right even where the orchestrator
is not root and cannot chown.

**Sessions from before this** keep their `home_volume` and a null `home_dir`,
and go on mounting the volume for as long as they live. Unlike the workspace
there is no migration: `homeSource` is a directory for one and a volume name
for the other, Docker takes either, and the two arrangements coexist
until the last old session is deleted.

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
workspace is chowned to `SESSION_UID` — the session image's `agent` user,
1020 by default and named as a constant in `workspaces.ts`. That is what lets the agent write in its own
workspace, and lets it edit or delete the `REVIEW.md` the review surface
writes there. `workspaces/` itself is 0700: one session's files are not
another's, and the only thing that reads across all of them is this process.

**How big it has got** is measured by walking the directory, which is the one
thing on the list's path that could genuinely cost something: a checkout with
a `node_modules` in it is a hundred thousand files, and the dashboard polls
every five seconds. So no request ever waits for one. `diskusage.ts` answers
with what it last measured — null before the first walk, which the card shows
as nothing rather than as a zero — and walks again only when there is reason
to think the answer has moved.

Two rules make that rare. A measurement of a running box stands for a quarter
of an hour, because the number is shown rounded to two significant figures and
an agent has to write a hundred megabytes to shift one. And **a box that is
down is measured once and then left alone**: nothing is running in it, so
nothing in it is changing, and re-walking it for the weeks it sits there would
be the whole cost of the feature spent on an answer known in advance. The one
walk after it stops is worth taking — what was measured while it ran was a
workspace being written to — and `bytes()` takes it because the measurement it
holds was recorded as having been taken live. A container in state `unknown`
counts as live: a Docker read that failed says nothing about whether the agent
is working, and a size frozen on that would be frozen on a guess.

Which leaves the orchestrator's own writes as the way a stopped workspace
grows, and the attachment route says so (`workspaceChanged`) rather than
leaving an upload invisible until the box next runs. The review surface writes
there too and deliberately says nothing: a `REVIEW.md` is kilobytes, invisible
in a figure rounded to two significant figures, and re-walking a checkout
whenever somebody types a comment is the cost this avoids.

Walks are queued one behind another, since they are all going to the same disk
and nobody is waiting for them, and lazy rather than on a loop: a deployment
nobody is looking at should not be walking disk on a timer. Sizes are apparent
rather than allocated — `du --apparent-size` — and symlinks count as nothing
and are never followed, the same containment the review surface and workspace
removal keep. Both directories are walked and summed, and the home is usually
the larger: a workspace holds a checkout, a home holds every toolchain cache
and globally installed tool the agent ever reached for. A session still backed
by a named home volume contributes only its workspace, there being no path to
the other half.

**Sessions from before the change** keep their `ws_volume` and a null
`workspace_dir`, and migrate at their next start, which is the only moment a
container can be recreated with a different mount. The order loses nothing at
any step: create the directory, copy the volume into it through a one-shot
helper container that can see both (`cp -a`, which preserves the agent's
ownership), recreate the session container with the bind, start it, and only
then delete the volume. A crash before the row is updated leaves a
volume-backed session that migrates again on the next attempt. A *running*
legacy session is left alone and comes through at its next stop/start cycle.

## Reclaiming what a session leaves

Two kinds of garbage accumulate on a Boxes host, and each has a collector.

**Superseded session images.** A pull that moves `:latest` leaves the image it
replaced on disk, untagged — a gigabyte or two of Node, browsers and language
toolchains, once per release, that nothing is ever going to look for again.
`refreshSessionImage` knows exactly which id it replaced, because it read the
id before the pull and after it, and removes that one. Alongside it, a sweep
catches the copies an *earlier* orchestrator process replaced and did not live
to clean up: the session image carries `boxes.image=session`
(`session-image/Dockerfile`), which survives the tag it lost, so an untagged
image can still be recognised as one Boxes fetched.

That label is the whole reason this is not `docker image prune`. The
orchestrator holds the host's Docker socket, and an unused image somebody else
put there is not its to delete. Nothing is forced either: an image a container
was created from is refused by the daemon with a 409, and that refusal is a
safety property rather than an error — a box that has not started since the
tag moved is still on the old image, start recreates it onto the new one, and
the image goes on a later sweep. `SESSION_IMAGE_PRUNE=false` turns the whole
of it off for a deployment that keeps old images to roll back to.

**Objects whose session is gone.** Everything Boxes creates carries
`boxes.session=<id>`. `reconcile()` reads that in one direction — for each
row, what Docker has — so anything left by a crash between `docker create` and
the row's own update, or by a teardown that failed halfway and only logged it,
was invisible: no card lists it, and no teardown will ever be run for it
again. A stranded home is the expensive one, since with a read-only
rootfs it is where everything the agent installed at runtime went.

`sweepOrphans` reads it the other way, on the reaper's minute. What makes the
rule exact rather than a heuristic is the order `create()` works in: the row
is inserted **before** any Docker object exists, so an object labelled with a
session that has no live row cannot be one on its way up. A deleted session's
tombstone counts as no row, which is what makes a failed teardown recoverable.
Containers go first, because a network with a container on it and a volume
mounted into one are both refused; a removal that fails is a log line and the
next sweep tries again. The workspace directory goes with them, being the size
of all of it put together.

One guard: when the sessions the host carries outnumber the rows the database
knows by a wide margin — an empty table beside a full host being the extreme of
it — the sweep refuses and says so. That shape is likelier to be a data volume
mounted from the wrong place than a genuine pile of orphans, and it is the one
mistake here that nothing could recover. A deployment whose sessions have all
been deleted still has its tombstones, so its failed teardowns are still swept.

The same sweep removes login containers nothing is waiting on. A login runs a
harness's CLI in a container of its own and removes it when the flow ends, but
that takes the process that started it still being alive — so a restart
mid-login would leave one holding a tmpfs home with a half-finished login in
it. Age is the whole rule there, because such a container has no other owner to
ask about.

The materialized agent configuration under `${DATA_DIR}/agents/<id>` is not in
the sweep. It is kilobytes of markdown, rewritten from the database at every
start, and worth neither the code nor the risk.

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
`${DATA_DIR}/agents/<id>` and bind-mounted **read-only** at `/boxes/agent`.
Every path in it is already home-relative and already the one it takes inside
the box, so the entrypoint copies and interprets nothing.

**A set is written once per harness, in each one's own layout.** A box may hold
threads of either and nothing here knows which — the merged set is a property
of the box, and where it lands is a property of the agent reading it — so both
layouts are installed, always, driven by each registry entry's `layout`:
`.claude/CLAUDE.md`, `.claude/skills/<name>/SKILL.md` and
`.claude/commands/<name>.md` for Claude Code, and `.codex/AGENTS.md`,
`.agents/skills/<name>/SKILL.md` and `.codex/prompts/<name>.md` for Codex.
Neither agent reads the other's directories — Claude Code loads skills from
`~/.claude/skills` only, and Codex from `~/.agents/skills` — so both copies are
needed, and a few kilobytes written twice is cheaper than a decision.

**Why the copy exists at all.** Those directories are in the session's home,
which the orchestrator now has a path to but still has no business writing into
while the box is running — that would race with the agent living in it.
Mounting over one read-only would break the box; mounting it writable would let
the agent edit what the dashboard says is configured. So the configuration
arrives beside them and the entrypoint installs it.

**The manifest is what makes the install reversible.** The materialized
directory carries a `manifest` naming every path in it. The entrypoint removes
exactly what the *previous* start recorded in `~/.boxes/managed`, installs the
current manifest, and leaves a copy of it behind. So a skill deleted in the
dashboard disappears from the box, while anything the agent itself put in its
home is never touched.

Manifest lines are checked, not trusted: they decide what gets deleted, and
their root is now the whole home rather than one configuration directory. So
`safe_rel` in the entrypoint takes a line only if it has at least two
components and starts with one of the six layout prefixes, a list written into
the entrypoint rather than read from the manifest — which would be the same
thing as trusting it. A manifest naming `.claude` or `.ssh` is refused rather
than quietly turned into a recursive delete.

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
takes a comment on a line, and writes all of it to `/workspace/REVIEW.md`. The
format is the desktop [`review`](https://github.com/splitbrain/review) tool's —
`orchestrator/src/review/fixtures/` holds files that tool wrote, and the tests
assert the bytes. The paths in it are workspace-relative, and the file sits
above any repository rather than inside one.

What it buys over running that tool separately is that the review lives where
the agent works. `REVIEW.md` is a file of the workspace under review, so
"address the comments in REVIEW.md" is a one-line prompt, and the review view
and the thread close a loop rather than being two applications.

**REVIEW.md is the single source of truth.** There is no annotation table.
Every mutation is read → parse → apply → serialize → write-tmp-then-rename,
under a per-session lock, with the file's hash checked between the read and the
write. A moved hash means the agent edited the file mid-mutation, and the whole
thing is re-read and re-applied once. A lost race costs one visible refresh
rather than data, because every write re-serializes the whole parsed file. What
is written is chowned to `SESSION_UID`, so the agent can edit or delete it.

**The workspace is the review.** A session's workspace is not one repository:
the agent clones what it was pointed at, forks and clones a second thing to
compare against, checks a dependency out beside it, and sometimes ends up with
a repository inside a repository. So the root is always `/workspace`, there is
nothing to pick and nothing to switch between, and every file under it is
browsable in one tree. A repository is an attribute of a *path* rather than the
unit of the thing being reviewed: each file is shown with the status and diff
of the closest enclosing one.

That whole mechanism is a longest-prefix lookup over the discovered
repositories (`review/repos.ts`):

    repoFor('repo-a/src/x.ts')    -> repo-a
    repoFor('repo-a/inner/b.txt') -> repo-a/inner   (nested wins)
    repoFor('notes/todo.md')      -> null           (no repository)

A nested repository needs no special case — it is a longer prefix that wins —
and a file no repository claims is shown without git, which is the old
no-git-for-the-whole-session behaviour narrowed to the one file.

**Discovery** walks the workspace pruning a list of its own — the dependency
and build directories a repository is not expected to be found in — never
following a symlink, bounded by a depth limit and a cap on directories
scanned. A directory holding a `.git` entry — file *or* directory, so
submodules and linked worktrees count — is a candidate, confirmed by comparing
`rev-parse --show-toplevel` **realpath to realpath**: git resolves symlinks, so
comparing its answer against a raw path silently loses git for every session of
any deployment whose workspace path has a linked component. Pruning that list
means a repository deliberately cloned into `vendor/` is not found, which is
the right trade against an agent's `npm install`; the files in it are still
listed, by whichever repository encloses them. The map is part of the git
snapshot below, retaken when a reader arrives.

**The tree arrives a folder at a time.** Opening one is a single request that
answers with its children: each file with its git status and how many comments
it holds, each folder with whether its subtree holds a changed file and whether
it holds a commented one. The folder marks are what make a collapsed branch
usable as a list of where to look, and they are a prefix check over a map the
server already has rather than anything the browser has to be given the whole
of. A directory the change emptied still lists the files it removed, merged in
from that same map, because a deleted file has no entry on disk to be found
under.

One read of the workspace is one `readdirSync` of one directory. Every file a
person could read is listed wherever it sits: binaries are left out, and so is
a version control system's own metadata and the review's own file at the root,
and nothing else. A directory carries its own cap, so no single answer can be
large, and says when it hit it.

**Git's answer is taken once and shared.** The repositories, what they are
compared against and the status of every path are one snapshot per review,
retaken when the reader arrives rather than when a folder is opened. Git is a
`docker exec` into the session's container, so a status per folder click would
be a round trip per click; a snapshot makes opening a folder cost one directory
read and nothing else. Writing a file or moving the base takes a fresh one,
because both change what git would say.

**One base expression, resolved per repository.** `main` means main-in-each,
through the merge base with that repository's own HEAD. A repository the
revision names nothing in falls back to its own working tree rather than
failing the request; a 400 comes back only when it resolves nowhere. Only the
expression is stored — what it resolves to is a different commit in each
repository and in some of them none, so it is derived.

**`REVIEW.md` is at `/workspace`**, outside every repository, so it cannot be
accidentally committed or show up in a repository's own status, and "address
the comments in REVIEW.md" stays one line however many repositories there are.
Its paths are workspace-relative (`repo-a/src/x.ts`).

**A file can be edited as well as commented on.** `PUT /review/file` takes the
whole file and the hash it was read at, and answers with what the file endpoint
would — so one round trip repaints the code, the diff, the status and the
comments, which drift has already moved. Four files are refused rather than
written: a deleted one, a binary one, a truncated one, because saving back
a read that stopped at the 2 MiB cap would delete everything past it, and one
past the line limit, because it has no rows to edit. A file
that has moved past the hash is refused with **412**, which is the one refusal
the reviewer can overrule — both versions still exist at that moment, theirs on
disk and the reviewer's in the pane, so the choice is offered rather than
taken. Writes go through the same `writeFileAtomic` as `REVIEW.md`, which now
keeps an existing file's permissions so that saving a script does not take its
executable bit off.

That the agent may be writing the same file is expected rather than guarded
against: the box runs while the review is open, and 412 plus "save anyway" is
the whole mechanism. Editing needs no new containment — the path goes through
the same rule about what may be listed and the same `resolveInRoot` as a read,
asked of the one path rather than looked up in a listing, so `REVIEW.md`
itself, a binary and a symlink out are all the same 404 they were.

**A review needs the box.** File content is read here, but git runs inside the
session's own container, so any endpoint that asks git something starts a
stopped session and marks it active. Reviewing is use of the box, and the
reaper stopping one under its reader would take the next request's answer with
it. What this costs is the old property that reviewing an idled-out session was
free; what it buys is that a repository can only ever run its own code in its
own box.

**Freshness is the fetch.** There is no poll and no fingerprint endpoint. Every
review fetch reads the filesystem on the spot, and an arrival says so, which is
what retakes git's snapshot and reruns drift — so what matters is being fresh
*on arrival*, and arrival is three moments: the view mounting, a file closing
back to the tree, and the tab becoming visible again. The last of those is
skipped while a composer is open, a write is in flight, or the pane holds
unsaved edits, which is the one piece of the poll's logic worth keeping. Edit mode is the case that
matters most: switching apps and coming back is how a phone returns to a
review, and a buffer is a whole file of work to lose to a refetch.

A poll would cost three git processes a round, roughly `1 + 2N` for N
repositories every five seconds per open review. It would also keep a view
fresh *while the reviewer sits on it*, which is the desktop tool's situation:
Boxes is driven from a phone, where the reviewer is in the thread or in the
review and not both. Fetching on arrival makes the idle cost zero.

The residual is that a background task can be working while the review is open.
Drift already covers the consequence: a comment whose code moved follows it, and
one whose code is gone is marked `(outdated)`. If that ever proves insufficient
the answer is a refresh button, not a watcher — Node's recursive `fs.watch` on
Linux is one inotify watch per directory, `fs.inotify.max_user_watches` is a
host sysctl a container cannot raise, and an agent running `npm install` makes
tens of thousands of directories.

**Drift** ports from the desktop tool as-is: each annotation stores three lines
of context above and below the annotated line, and a check compares the stored
context against the current source, relocating on an exact match elsewhere and
marking `(outdated)` when it is gone. It runs on a file fetch, and across every
annotated file when a reader arrives and after a comment is written. Opening a
folder runs neither it nor git.

**Two invariants, one file each**, because the orchestrator now reads a tree
the agent controls:

- Symlink containment lives in `review/fs.ts`. Every client path resolves
  through `realpath` and must land under the workspace's own realpath; a symlink
  final component is refused outright, since what it points at can change after
  the tree was listed. The rule is unchanged by the review spanning a whole
  workspace — what changes is that a contained path may now be in any
  repository, or in none. The residual `realpath`/open race is documented where
  the check is, along with what closing it would cost.
- Where git runs lives in `review/git.ts`, which is the one place a git command
  line is built and the one place it is handed somewhere to run. It goes to the
  session's container over `docker exec`, as the agent, against the workspace
  path inside it. The flags that remain are there for the parsers rather than
  for safety — unquoted paths, literal pathspecs, and the diff flags that keep
  hunk output byte-compatible with the desktop tool — because a repository
  that can run code in its own box has gained nothing. A test scans the
  orchestrator and asserts no source file outside the tests can spawn a
  process at all.

### The review view

`/sessions/:id/review`, with the open file in the search string
(`?path=src/app.ts`) so a file is linkable — and on a phone it is a step of the
navigation stack too: sessions → thread → file list → file, out of each by the
header's own control or by the phone's back gesture, which do the same thing
rather than each adding to what the other has to walk back through (see *Going
back*). From `md` up the list and the file are one view, so the file is not a
step there and back leaves the review. Entry points: a
Review action in the thread header next to Fork, and one on the session card,
where it works whether or not the box is running. The view owns the whole
viewport the way the thread view does.

Boxes is driven from a phone, so the desktop tool's three panels and hover
interactions do not survive. The feature set does; the layout does not. What
replaces it is one set of components in two arrangements rather than two
parallel UIs:

- **The tree** is a column from `md` up and the screen before the file below
  it. Same component, same status colours and comment badges. It is one tree
  over the whole workspace with the repository roots marked, so the boundaries
  are visible while scrolling across them; the header says which repository the
  open file belongs to. Below `md` it is a step of the stack rather than a
  drawer over the file: a drawer would be a second door to the screen back
  already reaches, and the two disagree about where you are.
- **Comments are inline**, GitHub-style, on every screen size. There is no
  right-hand sidebar to reflow away.
- **Tap replaces hover**, and the row is split between the two things a reader
  does to a line. The code is the comment: tapping it opens the composer, and
  it is the larger target by far because commenting is the frequent act. The
  gutter is the change: tapping it opens the hunk around that line as a sheet,
  which is also the only place deleted lines exist. A line with no hunk behind
  it — every line of a file git does not track yet — is not a target at all,
  rather than one that lights up under the thumb and does nothing. The code
  cell is a `role="button"`, not a `<button>`: WebKit and Firefox make text
  inside one unselectable, and a line of a review is a line somebody copies
  out, so a click that ended a drag or took a word is told from a tap and
  ignored.
- **Prev/next replaces the scrollbar minimap.** Annotation markers on a
  scrollbar are unusable on touch, and "the next thing that needs me" is what
  the minimap was for — so the toolbar says it directly, with counts and paired
  step buttons for changes and comments.
- **The code pane** is a CSS grid per line: a sticky line-number gutter, the
  code cell scrolling horizontally as one block, and a wrap toggle that starts
  on, because a phone is narrower than most source files. Every line being its
  own element is what makes it addressable at all.
- **Editing is a mode of the same pane**, for the corrections that are quicker
  to make than to describe. A transparent textarea floats over the code column
  and the rows behind it do the highlighting, so the font, the gutter, the
  colours and the line heights are the same ones in both modes.

Edit mode is the pane's own rows rather than an editor component because of
what switching has to cost: nothing. CodeMirror or Monaco would bring a second
highlighter, a second gutter and its own line metrics, so the code would move
under the reader on the way in — which is the opposite of what somebody
switching modes wants, since the line they are looking at is the line they went
in to fix. Five things follow from carrying the overlay:

- **The gutter is one width for every row**, `calc(Nch + 2.75rem)` as a custom
  property the rows and the overlay both read. Sizing each row to its own
  content puts the rows past line 99 a few pixels wider, and the overlay has to
  agree with the code cells to the pixel.
- **The code cell is `min-w-0`** while wrapping, so it wraps at the pane's
  width. A grid item is at least as wide as its longest unbreakable run unless
  it is told otherwise, and `overflow-wrap: break-word` does not count as
  breakable for that measurement — so one long URL made the cell wider than the
  pane and that line wrapped later than the textarea over it did. Every line
  that wraps differently pushes the ones below it another row out of step, so
  the error grows down the file: near the top of a README the caret is right,
  and by line 150 it is rows away from what is typed. The rows and the textarea
  being the same height is the invariant, and a browser test asserts it against
  a file of long links, deep indentation and unbreakable runs.
- **The pane is 16px below `md`** and 13px from `md` up. Safari zooms the page
  when a control smaller than 16px takes focus, and a zoom on the way into edit
  mode is exactly the jump this is avoiding. The same size in both modes, so
  switching moves nothing.
- **Editing always wraps.** A textarea that scrolls sideways scrolls
  independently of the rows behind it, and the two part company on the first
  long line.
- **The reader's line is held across the switch** (`lib/anchor.ts`). The
  comment cards, the composer and the deletion markers fold away in edit mode,
  because a textarea is one run of text and nothing can sit between its lines —
  so the position is remembered as a line and an offset into it, taken before
  the switch and put back after. A pixel offset means nothing once the rows
  above it have changed height.

Typing re-renders the whole file, so the rows are memoized and unchanged lines
cost a comparison rather than a render. Re-tokenizing waits for a pause in the
typing; until it lands, a line the tokens no longer describe is rendered plain
rather than painted with the colours of what used to be there. The header stays
put while editing, since the toolbar under it carries Save and a phone with its
keyboard up has no room to go looking for a control that scrolled away.

Every way out of an open file — the mode toggle, another file from the tree,
the step back to the list, the way out of the review — asks first when there
are unsaved edits, and what was agreed to then waits for the dialog's own
history entry to be popped before it runs. A dialog is a step the back button
can take back (see *Going back*), so a navigation made while it is still on top
is spent on the dialog rather than on the file.

Highlighting is client-side, with Shiki: the API ships plain text and the
browser tokenizes it. Both themes are tokenized at once and travel as
`--shiki-light`/`--shiki-dark` custom properties on each span, so a light/dark
switch costs no re-tokenize. The engine is Shiki's JavaScript regex engine, so
there is no wasm fetch, and grammars load per file type on demand. The
highlighter's line limit of 8,000 is the pane's too: past it a file is shown
as one block of plain text under a notice, with no rows, so no gutter, no line
comments, no stepping and no edit mode. Tens of thousands of rows are more
than a phone lays out in time, and a file that long is not reviewed a line at
a time anyway. The whole
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
| upstream tunnel | loopback, ephemeral | The one place a connection leaves, so both routes out are vetted identically |

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
off: any public host, private ranges still denied. A stored credential's hosts
are implied members, so a narrow list cannot sever the traffic the proxy exists
to authenticate, and so are the hosts its tools merely need — each credential's
`alsoAllow`, which is what keeps a login, a token refresh or a tarball download
working under a list that names none of them. The grammar lives in `policy.ts`
as pure functions.

### Token translation

A session holds placeholders. Real credentials exist only in the credential
store on the orchestrator's data volume and in the proxy's memory.

**Every box holds a placeholder for every credential, always**, and is given
the deployment CA on the same terms. A container's environment is fixed when it
is created, so anything conditional on a credential existing would leave a box
built today unable to use a token entered tomorrow — and a box created before
the first credential would fail TLS against every intercepted host for the rest
of its life. `resolveEgressMaterial` is therefore passed the whole credential
set rather than the configured part of it, `placeholderFor` never returns a
real value, and the policy carries the CA unconditionally.

A placeholder for a credential nobody has stored leaves the box as a bearer to
a host nobody intercepts, and the service refuses it. That is the intended
failure: the dialogs do not offer a harness that cannot run, so the only way to
reach it is to have removed the credential after the thread was made.

A host becomes a *translated host* when its credential is stored. Reaching
one, the front door hands the CONNECT to the interception engine instead of
tunnelling it — by replaying the CONNECT on loopback, so the engine picks the
certificate for the host the client asked for. The engine terminates
TLS under the deployment CA and `decideCredentials` rules on the request:

| The request carries | What happens |
|---|---|
| the placeholder, in a credential header | rewritten to carry the real credential |
| any other value in a credential header | 403 from the proxy; nothing reaches the host |
| nothing in a credential header | forwarded as it stands |

A *credential header* is one the credential set names: `Authorization` for
both of them, and `X-Api-Key` for Anthropic as well. Nothing else is read as a
credential. A request that authenticates some other way — a session cookie is
the case worth naming — is forwarded as it stands, which is what keeps logging
in to a translated host from inside a session working. The refusal above is
about the deployment's own credentials, not about every way to reach an
account at that host.

The swap is value-level: the placeholder is replaced wherever it appears in the
credential header, which covers `Bearer <p>`, `token <p>`, a bare value, and
the HTTP Basic pair git's credential helper produces — one mechanism instead of
a rule per tool.

Everything else stays an opaque tunnel that never reaches the engine, so
interception is bounded by policy rather than by trust in the engine. And every
request the engine forwards leaves through the upstream tunnel, so the vetting
above governs the connection that leaves: decrypting a host buys no way
around the checks.

`api.anthropic.com`, `api.openai.com`, `github.com`, `api.github.com` and
`*.githubusercontent.com` are the translated hosts, fixed in `config.ts` as
`CREDENTIAL_SET` alongside the headers each credential travels in and the hosts
it merely needs reachable. They are facts about the services rather than
preferences, so they are not configurable; only whether a credential for one is
stored is.

`chatgpt.com` is in that set as a host to allow and never to intercept. It
carries the other kind of OpenAI credential — a subscription — and the two
kinds reject each other's material, so leaving it alone is what lets a
deployment's API key and a person's subscription live in one box. It is also
why an `oauth` credential — a ChatGPT subscription, obtained by logging in — is
not delivered to a box at all: it is a document rather than a header value, and
the traffic it authenticates goes to that unintercepted host. Such a credential
is stored, refreshed and reported, and the harness that needs it says it cannot
run until a key is pasted. A Claude login is not that case: it ends in a token,
which is delivered exactly as a pasted one is.

The policy is composed from the store on every sync rather than once at boot,
and the store calls `sync()` on every write — so a credential entered on the
settings page is live within the second, and the reconciler's minute tick is
only the retry for a proxy that was not listening.

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

The channel's port is named on both sides: `EGRESS_CONTROL_PORT` for the
orchestrator and `CONTROL_PORT` for the proxy, 3129 by default in each. They
are one port, so moving it means setting both.

## State, and where truth lives

Docker is the runtime truth. SQLite holds metadata, and the two are reconciled
at boot and on every read that reports container state.

`orchestrator/src/db.ts` opens the database in WAL mode under `DATA_DIR` and
applies migrations tracked by `user_version`.

| Table | Holds |
|---|---|
| `sessions` | One row per session: names, Docker object names, where its workspace and home are, status, which thread is the default, timestamps |
| `threads` | One row per conversation: which session owns it, which harness runs it, the adapter's id for it, the mode and the config map it is meant to be in, the agent's title, its ordinal, whether a turn is running on it, whether the reader has marked it done |
| `pending_requests` | Permission requests waiting for a browser, each recording the thread that asked |
| `push_subscriptions` | One row per browser registered for Web Push, keyed by the push service's endpoint |
| `agent_sets` | One row per named set of agent configuration, plus its `AGENTS.md`. The row `global` is seeded and applied to every session |
| `agent_items` | The skills and slash commands of a set, keyed by set, kind and name |
| `credentials` | One row per credential the deployment holds: the secret as the harness needs it, the account it is shown as, when it expires, when it was last refreshed, and whether it is believed to work |
| `settings` | Plain configuration a person sets on the settings page: the git identity, and each thread dialog's last choice |
| `harness_catalog` | What each adapter last advertised — its modes and config options — so a dialog with no adapter to ask has something to offer |
| `counters` | The subnet allocation counter |

Secrets are the one kind of state that moved *into* the database. They are
stored as-is, with no encryption layer: the orchestrator has to hand them to
the proxy on every boot, so there is nobody to ask for a passphrase. That puts
live logins on the data volume and therefore in any backup of it, which is why
the reverse proxy in front of the dashboard is a requirement rather than a
suggestion. `log.ts` redacts anything credential-shaped before it reaches
stderr, and no API route ever answers with a secret — only with an account, a
status and a time.

Two kinds of state deliberately stay out. Thread transcripts live in the
session's home directory and are read back by the adapter, so Boxes stores no
transcript of its own. And the tap of forwarded ACP messages is a log rather
than a table: at `LOG_LEVEL=debug` each one is a line on stderr, where
`docker logs` has it alongside everything else, with an image or audio block's
base64 payload replaced by its size and the line truncated. At any other level
the tap does not even serialize the message. A log nobody can read without the
process's own output is a log in the wrong place, and writing one to disk on
the hot path cost every session a synchronous write per message.

Pending requests are the one place where the database and memory both matter.
The row lets the dashboard show that something is waiting and survives a
restart; the resolver that answers the request is in memory only, so
`clearStale` drops rows left behind by a previous process.

## Background loops

| Loop | Interval | Does |
|---|---|---|
| Reaper (`reaper.ts`) | 60s | Stops sessions that are idle on all five counts: no running turn on any thread, no waiting permission request, no attached browser, no background task still believed to be running, and no activity for `IDLE_STOP_MINUTES`. It never deletes, and it never waits: a session with an operation already in flight is skipped and tried again next tick. The turn count is derived from the threads; the rest stay session-scoped, because they are about the box rather than the conversation |
| Proxy reconciler (`reaper.ts`) | 60s | Re-asserts both halves of the proxy's state: its attachment to every running session's network, which `compose up` can drop by recreating the container, and the policy it holds, which a restart erases entirely. Both show up in `/healthz` |
| Maintenance | 60s, with the reaper | Prunes each session's debug log to its ring size, and forgets the upstream of a box that is down and holding nothing |
| Orphan sweep (`sessions.ts`) | 60s, with the reaper | Removes the containers, networks, volumes and workspace directories labelled with sessions that no longer exist. See below |
| Credential refresh (`reaper.ts`) | 60s | The one thing Boxes holds that goes stale on its own. A subscription login whose access token is within the hour of expiring, or which has simply sat for eight days, is refreshed against the provider's token endpoint and written back through the store, which pushes the new material to the proxy. A credential that cannot be renewed and has run out is marked expired instead, so the settings page says so rather than a turn failing with a 401 nobody sees |

The list screen polls `GET /api/sessions` every 5 seconds while it is up and
its tab is visible. A view watching one box — its thread, its review, its info
— polls that session alone at the same cadence, so a browser reading one
conversation is not asking for every session in the deployment.

## Configuration and secrets

`config.ts` parses the environment once at boot with zod — the same library
the REST bodies are checked with — so a misconfigured deployment fails at
startup rather than at first use. Every setting has a
working default, which is why the stack runs with no `.env` at all.

That file is the only place a default is written down, and the only place
that knows which settings exist. `compose.yaml` hands the orchestrator an env
file wholesale (`BOXES_ENV`, defaulting to `.env` and optional), so adding a
setting means editing the schema and nothing else. It names no variable at all
and sets no value: nothing about a credential is configuration any more, so
there is nothing compose has to pass through from a shell.

`BIND_ADDR` and `HOST_PORT` are the two names compose reads for itself, each
with its default written into the published port line. They are variable
substitutions rather than settings of the orchestrator's, and compose
resolves a substitution from `./.env` or the shell, never from a `BOXES_ENV`
file. Setting either one there changes nothing. Where compose has to agree with a default
— `/data`
for the volume mount, `boxes-egress-proxy` for the container the orchestrator
attaches to session networks — it agrees by using the same value, not by
restating it as configuration, and the comment at each site says which
default it is matching.

`DATA_DIR` and the rest stay configurable because the orchestrator also runs
outside a container, under `npm run dev` and in its own tests. Inside the
image every default is already the right answer, which is why compose passes
an env file and otherwise stays out of it.

An empty value counts as unset. `SESSION_MEM_LIMIT=` in an env file arrives
as an empty string, and failing the boot on a setting nobody set would be a
poor way to read it.

Secrets are the exception, because a shipped default for one would be a
published password. A session's gateway token is not configured at all: it is
minted with the session and stored in its row.

The same reasoning covers the egress material. `egress.ts` generates the CA,
the placeholders and the control-channel bearer on first boot and stores them
in `DATA_DIR/egress-secrets.json` at mode 0600. They are generated rather than
configured, and they persist rather than being regenerated, because running
sessions hold them.

**The credentials themselves are rows, not settings.** `credentials.ts` owns
the table and `settings.ts` the plain configuration beside it — the git
identity, which only ever lived in the environment because the credentials
did, and each thread dialog's last choice. Both are managed from the settings
page, because a credential has to be enterable without a restart and a
subscription login has no static form to write down at all. Every write calls
the store's `onChange`, which recomposes the egress policy and pushes it.

What reaches a session container is a placeholder for each of them, built by
`credentialEnv` from every harness's `env()` plus `GH_TOKEN`, `GIT_NAME` and
`GIT_EMAIL`, and fixed into the container at create time. The real value never
enters a box and never reaches a filesystem outside the orchestrator's own data
volume. The CA certificate travels the same path, as `BOXES_PROXY_CA`, which
the entrypoint writes to `~/.boxes/proxy-ca.crt` for the CA-trust variables to
point at — `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO`,
`CURL_CA_BUNDLE`, and `CODEX_CA_CERTIFICATE`, which Codex reads before it falls
back to `SSL_CERT_FILE`.

`GH_TOKEN` is now always set, so `gh auth setup-git` in the entrypoint always
runs. A push from a box with no GitHub credential stored gets a 401 from
GitHub rather than a prompt, which in a headless box is the same outcome said
sooner.

## Build-time pins

The agents, the ACP adapters and the browser CLI are pinned in
`session-image/Dockerfile` rather than in configuration, so what runs in a
session is what this commit names and no `.env` entry can change it. Claude
Code, its adapter and the browser CLI are pinned to a major line rather than
to an exact release, so a rebuild takes fixes on that line and a new major is
an edit to that file; below 1.0 a caret pins the minor, which is where a
package that young puts its breaking changes.

Codex is pinned as a pair, and exactly. `@openai/codex` on npm is a 13 KB
launcher whose platform binary arrives as an optional dependency of 339 MB, so
the global install is the one copy of it; `@agentclientprotocol/codex-acp` is
installed with `--omit=optional`, which leaves the copy npm nests under the
adapter as a launcher with no binary behind it, and `CODEX_PATH` in the image's
environment points the adapter at the global one. One binary, both commands on
`PATH`, both packages at the release the pair was verified on — and the
`codex` a person runs in a box is the build the adapter drives. The image
asserts that, and that `codex --version` prints the pinned number, at build
time.

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
  app.ts                REST routes and the static bundle
  bodies.ts             A schema per route that takes a JSON body, and the 400 a body that fails one gets
  http-error.ts         The one error that carries an HTTP status, thrown wherever a request is refused
  attachments.ts        Files a prompt carries, written into the session's own workspace
  config.ts             Environment parsing, and the translatable credential set
  harness.ts            The registry: one record per harness, and every value that varies between them
  credentials.ts        The credential store, and the refresh that keeps a login true
  settings.ts           Git identity and each dialog's last choice, over the settings table
  login.ts              Logging in to an account: a CLI in a throwaway container, and the state a page polls
  secret.ts             WS auth token: configured, stored, or generated
  notify.ts             "A thread wants you", pushed to every subscribed browser
  push.ts               VAPID and RFC 8291 payload encryption, on node:crypto
  egress.ts             CA and placeholders, the policy, and the push to the proxy
  db.ts                 SQLite, schema migrations, the debug log
  sessions.ts           Session lifecycle, the owner of every UpstreamSession
  workspaces.ts         Workspace and home directories on the data volume: paths, ownership
  diskusage.ts          How big each workspace has got, measured off the request path
  agents.ts             Agent sets: AGENTS.md, skills, commands; the merge and the materialized bundle
  docker.ts             Containers, networks, volumes, the adapter exec
  images.ts             Which build of the three images is running, cached off the health probe
  review/
    service.ts          Per-session façade: the repo map, the REVIEW.md read-modify-write, the routing
    repos.ts            Which repositories the workspace holds, and which owns a path
    store.ts            REVIEW.md: parse, serialize, mutate, drift (pure)
    gitstatus.ts        Porcelain and name-status parsing, base resolution, the merged workspace layer
    difflines.ts        Unified diff to line markers, hunks and deletion markers (pure)
    tree.ts             One directory read, with git status and comment counts merged into it
    fs.ts               Contained reads and writes under the workspace: the symlink invariant
    git.ts              The one place a git process is spawned: fixed argv, scrubbed env
  subnet.ts             Per-session /24 allocation
  reaper.ts             The idle reaper and the proxy reconciler
  log.ts                Structured stderr logging with secret redaction
  gateway/
    activity.ts         Whether the agent is talking on a thread, which silence is the only evidence of
    background.ts       What a session left running in the background, so the reaper waits for it
    upstream.ts         What belongs to a session: browsers, threads, the box, and the connections it owns
    adapter.ts          One adapter process: spawn, initialize, load, mint, config replay, tasks, teardown
    downstream.ts       One ACP agent connection per browser, pinned to one thread
    broadcast.ts        Which browsers each adapter update goes to, routed by thread
    pending.ts          Permission requests waiting for an answer
    terminal.ts         One pty per terminal connection, and how long it holds the box

proxy/src/
  main.ts               The three listeners, the in-memory policy, the denial tally
  forward.ts            Absolute-URI HTTP and CONNECT: allowlist, vetting, pinning
  policy.ts             Allowlist grammar and the credential decision, as pure functions
  inject.ts             TLS interception and the swap, on mockttp
  control.ts            The authenticated policy push, and where it may be reached
  cidr.ts               Resolved-IP vetting, the security boundary

dashboard/
  index.html            Vite entry; the dark class before first paint, and what makes the app installable
  public/               Served from the bundle root: the service worker, the manifest, the icons
  vite.config.ts        React, Tailwind, the dev proxy, both test projects
  components.json       Where the shadcn and assistant-ui CLIs install to
  e2e/                  Browser tests over the real orchestrator, and the stub ACP gateway
  src/
    main.tsx            React mount and the routes
    globals.css         The whole design system: tokens and the @theme bridge
    api.ts              Typed fetch client
    stores/
      sessions.ts       Polled session list and health, read by useSyncExternalStore
      harnesses.ts      Which agents this deployment can run, what each last advertised, and the dialog's last choice
      push.ts           Web Push registration: the service worker, the subscription, the toggle's state
      review.ts         The review view's whole state: the tree and the open file, fetched on arrival
      thread/
        acp-types.ts    The slice of the ACP schema the browser speaks
        acp-client.ts   JSON-RPC over the WebSocket, and the handshake
        translate.ts    session/update notifications → a message model (pure)
        thread-store.ts The live thread: messages, modes, models, approvals
        convert.ts      That model in the shape the runtime reads
    hooks/              What the views share: the header stepping aside, a thread following its own output
      use-up.ts         Leaving a view by popping what it pushed, never by pushing its parent
      use-history-overlay.ts  A dialog as a history entry, so back closes it and not the screen behind it
    lib/
      history.ts        Where in the stack the browser is, which both of the above read
      staged-prompt.ts  A prompt handed from one view to another, consumed once, out of history's reach
      harness.ts        What only a reader needs about a harness: why one cannot run, and the caveat on a mode
      terminal-socket.ts  The browser's end of a terminal: bytes out, bytes in, a size
    views/              SessionList, SessionCreate, SessionThread, SessionInfo,
                        SessionReview, SessionTerminal, AgentSets, AgentSetEditor,
                        Settings, Playground, Shell
    components/
      ThreadOptions.tsx The agent, mode, model and effort block both dialogs ask with
      NewThreadDialog.tsx  That block, as what a card's "New thread" opens
      AgentSettings.tsx The controls a thread's settings are drawn with, shared by the header and the dialogs
      Spinner.tsx       The one thing that says "working": blocks-wave, in every running state
      assistant-ui/     Installed registry sources, ours to edit
      ui/               Installed shadcn primitives

shared/
  types.ts              REST shapes and the control-channel contract
  acp.ts                The ACP subprotocol, method names and update kinds, spelled once
  terminal.ts           The terminal subprotocol and its one control message
  task-notifications.ts How a background task reports in, read by both sides
session-image/          The per-session container image, in four files
  Dockerfile            What a session has installed, and the uid it runs as
  entrypoint.sh         Identity, the CA and the agent configuration install; then it holds the container open
  playwright-cli.config.json  Browser defaults for a container with no Chrome and no sandbox
  profile-image-path.sh Puts the image's PATH back after /etc/profile has replaced it
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
with nobody watching. Both scripts now seed the credential store over the API
rather than reading the orchestrator's environment, since that is where a
credential lives; give the live test an OpenAI key as well and it runs a Codex
thread beside the Claude one in the same box, which is the whole of what a
per-thread harness claims.

The review surface is tested at three levels, because it has three kinds of
thing to get wrong. The format is asserted byte-for-byte against REVIEW.md
files the desktop tool's own Go code wrote (`orchestrator/src/review/fixtures/`,
with its own README on provenance), the same reviews being rebuilt from the same
inputs and each file round-tripped. The invariants have tests that are the
attacks: a symlink out of the workspace, a symlink through a directory, and a
traversal all coming back as the same 404, and a scan of the orchestrator's own
sources asserting that none of them can spawn a process, which is what keeps
git in the box it belongs to. The seven routes are driven over their real
handlers, a real database and a real git repository in a temp directory, with
git itself supplied through the one seam it is started from, so the suite needs
no Docker; every invocation is checked to be addressed to a session's container
and a path inside its workspace. They cover root resolution, drift, concurrent
writes, and that reading a review marks the session active, since git now runs
in the box.

The second harness added suites of its own, each about one of the things it
moved. `harness.test.ts` holds the registry to its own shape — every harness
supplying every field, each `env()` naming its placeholder, no two layouts
sharing a path — because the registry is a table other code trusts.
`credentials.test.ts` covers the store, that a summary is never the secret, and
that every write fires the hook the egress push hangs off; `settings.test.ts`
the patch semantics, including a field cleared back to its default;
`login.test.ts` both flows over a fake exec, their timeouts and their
cancellation. `db.test.ts` runs the migration over a thread row that predates
it and asserts it comes out on harness `claude` with its model in the config
map. `config.test.ts` and `egress.test.ts` assert the store as the source of
secrets, a placeholder for every entry whether or not it is configured, the CA
present unconditionally, a recompose on change, and the OpenAI credential's
hosts and headers; `docker.test.ts` that a box's environment carries both
harnesses' variables and the CA. `upstream.test.ts` puts two connections in one
session: a thread routed to its own, a failure in one leaving the other up,
`initialize` answered per harness, an `auth_required` not retried, and the
config map replayed with the mode category excluded. `background.test.ts`
covers the task translation and the stop, and the box reading with two adapters
present, with a shell under each, with an orphan under PID 1, and with only
resident processes.

Unit tests cover the pure logic that is easiest to get quietly wrong: the
proxy's range checks, subnet allocation, the WebSocket upgrade check, update
routing with two browsers attached — including two on *two* threads, where an
update for one must not reach the other, reading one in must not silence the
other's live updates, and an update nobody is watching is dropped — the
per-thread log a browser opens a thread from, and what it drops past its cap,
the exec
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
serves it from the real orchestrator: the real routes, a real database in a
temporary directory, a Docker that answers from memory, and workspaces with
real git repositories in them. What the suite proves is therefore the same
code a deployment runs, and a change to the API cannot pass here by being
matched in a second implementation. Only the agent is stubbed, because there
is no agent to talk to: a stub ACP gateway speaks that side from canned
scripts, including its own several threads per session with each socket
pinned to one by its upgrade path, so a fresh thread starting empty, a fork
carrying the source's messages,
a switch bringing the first thread's transcript back, and two tabs on two
threads each keeping to their own conversation are asserted against a gateway
that behaves like the real one.
The dialogs and the settings page are in that suite: both ways of starting a
conversation, an agent greyed out with its reason, a deployment with no
catalogue offering the agent choice alone, a thread showing which agent runs
it, the per-harness warning on the list, a credential entered and shown as an
account and removed again, and a login driven end to end — against a stub
orchestrator that answers the harness, credential, settings and login routes
the real one does.
The review pages are in that suite too, on a phone viewport and a desktop one,
because the two arrangements are different enough that one passing says little
about the other: browse the tree, open a file, tap the gutter for the hunk and
the code for the composer — including the line whose gutter is not a button
because nothing changed there — comment on a line and see the write reach the
API, edit and delete it, set a base revision, and hand the review to the agent
with the prompt staged unsent.
The degraded shapes are there as well — no git, an empty workspace, and a
session whose workspace is still a volume.
The back button has a file of its own (`e2e/back.test.ts`), because it is the
navigation control on the platform this is driven from. Every assertion there
is a `page.goBack()` or a control the app calls back, checked against where it
landed *and* against the depth of the stack it left behind — a pop that lands
on the right screen by pushing a copy of it looks identical on screen, and
only the count gives it away.
That is what asserts the UX properties this frontend exists for, and it is
where a component upgrade is reviewed: `/playground` renders every part kind over a
canned store, so a registry re-run shows up on one page.

One runner throughout: `npm test` in each package is `vitest run`.
