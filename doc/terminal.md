# Terminal

The terminal gives you an interactive shell in a [box](boxes.md). It runs in the box's [workspace](storage.md), with the
same files, tools, and agent account that the agent uses.

## Opening a terminal

Select **Terminal** on a box card, or select the terminal button in a [thread](threads.md) header. Opening a terminal
starts the box when it is stopped. The terminal page shows a connection message while the box and shell are opening.

The terminal fills the browser window and resizes when the window or phone orientation changes. It supports full-screen
terminal programs such as editors, pagers, and interactive command-line tools.

## Shared shell

Boxes uses [tmux](https://github.com/tmux/tmux/wiki) for the shared terminal workspace. All tmux features are available,
including windows, panes, sessions, and detached commands.

Terminals for the same box share that tmux workspace. A second terminal can see the same shell windows and running
commands as the first. This lets you reopen a terminal and continue work already running in the box.

Closing a terminal tab ends that terminal connection, but the shared tmux workspace remains. Commands started there can
continue running. The next terminal for the box reconnects to the same workspace.

## Box lifetime

An open terminal keeps its box running. After every terminal is closed, the box can stop automatically once it is
otherwise idle for the configured idle period.

The orchestrator accepts at most four simultaneous terminal connections per box.

## Reconnecting

If the terminal connection closes, the page shows its reason and offers **Reconnect**. Reconnecting opens another
terminal connection to the box's shared tmux workspace.

## Working with the agent

Terminal commands and the agent both change the same workspace. Check for agent activity before editing the same files,
and use version control to review or recover changes.

## Technical internals

The terminal is a WebSocket at `/ws/boxes/:id/terminal`, authenticated with the same per-box token as the [ACP
gateway](acp.md), offered as a `bearer.<token>` subprotocol entry. Binary frames are the pty's bytes in both directions;
text frames are JSON control messages, and only one type exists: `resize`. The implementation is
`orchestrator/src/gateway/terminal.ts`; the frame vocabulary is `shared/terminal.ts`.

`openTerminalExec` in `orchestrator/src/docker.ts` starts the shell as a `docker exec` with `Tty` enabled, so the daemon
does no stream framing. The shell runs as the numeric box user, in the container's existing isolation — no new privilege
is introduced, because anyone holding the box's token can already ask the agent to run anything.

The tmux mechanics: the orchestrator creates a detached shared session on first use, and each connection opens its own
session grouped with the shared one. This grouping makes a connection closable on its own: Docker offers no way to
signal a running exec, so a closing terminal kills only its own session while the shared one keeps the windows. The tmux
server socket sits in `/tmp`, which is a tmpfs, so stopping the box also stops the shell.

An open terminal prevents the idle reaper from stopping the box, so the orchestrator must find a dead browser sooner
than TCP would find it: the server pings and drops a socket that stops answering. The orchestrator applies back pressure
to the pty rather than to the browser — past a fixed ceiling of unsent bytes it pauses the stream until the socket
drains. Typing marks the box active, throttled. The server queues input typed before the pty is open — the box is still
starting — and replays it after the attach.
