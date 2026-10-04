# Terminal

The terminal gives you an interactive shell in a box. It runs in the box's
workspace, with the same files, tools, and agent account that the agent uses.

## Opening a terminal

Select **Terminal** on a box card, or select the terminal button in a thread
header. Opening a terminal starts the box when it is stopped. The terminal page
shows a connection message while the box and shell are opening.

The terminal fills the browser window and resizes when the window or phone
orientation changes. It supports full-screen terminal programs such as editors,
pagers, and interactive command-line tools.

## Shared shell

Boxes uses [tmux](https://github.com/tmux/tmux/wiki) for the shared terminal
workspace. All tmux features are available, including windows, panes, sessions,
and detached commands.

Terminals for the same box share that tmux workspace. A second terminal can see
the same shell windows and running commands as the first. This lets you reopen
a terminal and continue work already running in the box.

Closing a terminal tab ends that terminal connection, but the shared tmux
workspace remains. Commands started there can continue running. The next
terminal for the box reconnects to the same workspace.

## Box lifetime

An open terminal keeps its box running. After every terminal is closed, the box
can stop automatically once it is otherwise idle for the configured idle
period.

Each box allows up to four simultaneous terminal connections at the same time.

## Reconnecting

If the terminal connection closes, the page shows its reason and offers
**Reconnect**. Reconnecting opens another terminal connection to the box's
shared tmux workspace.

## Working with the agent

Terminal commands and the agent both change the same workspace. Check for
agent activity before editing the same files, and use version control to review
or recover changes.
