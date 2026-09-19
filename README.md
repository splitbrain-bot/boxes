# Boxes

Boxes is a web-based orchestrator for AI coding agents, similar to Claude Code
on the web.

It currently uses Claude Code and supports Claude subscriptions. Other agents
are planned. Boxes drives agents over the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP).

Each session runs in its own Docker container. A proxy wraps the credentials and
can restrict network access.

Compared to Claude Code on the web, Boxes can run several threads on the same
checked-out code base, which improves context management. It has a built-in
line-based review tool, similar to
[splitbrain/review](https://github.com/splitbrain/review) and allows direct editing of files. It is hackable, and
you can adjust it to your preferences. Support for other agent harnesses will
make it independent from Anthropic.

## Setup

Boxes needs Docker with Compose v2. The images are published on GHCR. Create a
`compose.yaml`:

```yaml
name: boxes

services:
  orchestrator:
    image: ghcr.io/splitbrain/boxes/orchestrator:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - boxes-data:/data
    depends_on:
      - egress-proxy

  egress-proxy:
    image: ghcr.io/splitbrain/boxes/egress-proxy:latest
    container_name: boxes-egress-proxy
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true

volumes:
  boxes-data:
```

Put a `.env` next to it. `claude setup-token` prints the token:

```ini
PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

Then start it:

```sh
docker compose up -d
```

Boxes is now available at <http://localhost:3000>. For a live deployment, put
a reverse proxy in front of it and let the proxy handle authentication.

`.env.example` in the repository documents the remaining settings.

## Usage

### Session list

The start page lists every session. A session is one container with a home
directory and a workspace directory bind-mounted into it. It contains one or
more threads, and a thread is one instance of the agent harness. Idle sessions are suspended, which stops their
container.

A session shows its name, its id, its disk usage and one or more status badges:

| Badge | The session |
|---|---|
| `up`, green | is running |
| `stopped`, grey | is suspended |
| `error`, red | failed |
| `waiting for approval`, amber | needs a permission decision |
| `running turn`, blue | is processing a prompt |
| `still running`, dim blue | has a command or a subagent running |
| `2 viewers`, grey | is open in that many browsers |

Below them is the list of threads. Each row has a coloured dot, the thread's
name and the time since it was last active.

| Dot | The thread |
|---|---|
| Amber, pulsing | needs a permission decision |
| Blue, pulsing | is processing a prompt |
| Blue, dim | has a command or a subagent running |
| Grey | is idle |

The last used thread is bold, and clicking the session opens it. Clicking any
other thread opens that one. A thread marked as done is struck through.

### Agents and skills

The agent configuration icon on the session list opens the agent sets. A set is
an `AGENTS.md`, a number of skills and a number of slash commands. The global set
applies to every session. A session can use one more set, chosen when the
session is created and merged with the global one. A session picks up an edited
set at its next start.

### Managing sessions and threads

`New thread` adds a thread to a session. `Fork` starts a new thread from the
current one's history. Both threads use the same workspace.

The session details, available from the info icon on the session list let's you start, suspend and delete a session. Deleting it removes the
container, the network, the workspace and the home.

### Thread view

A thread is an individual conversation with an agent inside a session. A session has at least one thread, but you can open as many as you want. 

A running turn continues when the browser disconnects, so you do not have to
watch the agent work. Close the tab and come back when it is done.

Under the session's name, a dot reports the state of the connection to the agent
(connecting, connected, reconnecting, disconnected). The header has these
controls:

- The agent settings icon opens a dialog to set its mode, model, and effort level
- The check mark marks the thread as done - this is just a visual marker (strike through in the session list), it has no other consequences
- The branch icon [forks](#managing-sessions-and-threads) the thread.
- The magnifier opens the [review tool](#review-tool).
- The terminal icon opens a [terminal](#terminal) in the box.

Everything you type into the input field goes to the agent. A line starting with
`/` completes the agent's own slash commands.

The `+` button uploads a file to `.boxes/attachments/` in the workspace and
passes the path to the agent. Commands and subagents that keep running are
listed above the input field.

All threads of a session share one workspace. Two agents that edit the same
files at the same time might conflict, so instruct them to avoid it, for example by
working in separate git worktrees.

### Terminal

The terminal icon in the thread header opens a shell in the session's
container, as the same non-root user the agent runs as. It is the box seen
directly rather than through the agent, so it costs no tokens and nothing you
type is read as an instruction.

The shell runs under tmux, and every terminal opened on a box attaches to the
same session. Reload the page, or open it in a second tab, and you are back in
the same shell with the same scrollback — and a build keeps running while
nobody is watching.

The box stays running for as long as a terminal is open on it, and goes back
to the usual idle timeout once you close the tab. A box that has been stopped
is started again when you open a terminal on it, which takes a few seconds.
Stopping a box ends the shell: tmux runs inside the container.

### Review tool

The review tool allows you to view, comment and edit the files in the agent's
workspace. It is available from the session list and from the thread view's
toolbar.

The review tool provides a file browser for the workspace with git based change markers:

| Mark | The file |
|---|---|
| `M`, amber | is modified |
| `S`, blue | is staged |
| `A`, green | is added |
| `?`, green | is untracked |
| `D`, red | is deleted |
| `!`, red | is in conflict |

Opening a file shows its syntax highlighted contents. git change info is marked in the line number gutter. Clicking the gutter shows the git diff
hunk around that line.

By default, the tool opens in review mode. Clicking a code line opens the comment field, and the
comment appears as a card under its line, where it can be edited and deleted.

The toolbar steps from change to change and from comment to comment, and it
switches line wrapping on and off.

The pen icon allows switching to edit mode, where the file can be edited directly. 

The base picker decides what counts as a change. By default that is the working
tree, so the marks cover uncommitted work. A revision such as `main` or `HEAD~3`
is resolved in every repository of the workspace, and each comparison runs
against the merge base of that revision and HEAD, which makes a whole branch one
review.

Review comments are stored in a `REVIEW.md` at the top of the workspace.

`Hand to agent` opens the thread with a prefilled prompt instructing the agent to address the review. The `Start a new review` button deletes the review file and all its comments.
