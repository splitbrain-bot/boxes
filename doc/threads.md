# Threads

A thread is one conversation with an agent in a box. All threads of a box share
the same container, workspace, and network. Two threads of one box can use
different agents, so Claude and Codex can work on the same checkout.

A thread does nothing by itself. The agent's harness runs the turns of the
thread, and the adapter of the harness holds the transcript.

## Opening a thread

Select a thread on a box card. Each browser tab connects to one thread, so two
tabs can follow two threads of the same box.

Opening a thread of a stopped box starts the container and the adapter of the
thread's agent. The connection dot in the header shows the state: connecting,
connected, reconnecting, or disconnected.

Closing the tab does not stop the agent's turn. The orchestrator holds the
connection to the adapter, so a turn runs to its end with nobody watching.
Opening the thread again shows everything that was said since.

## Starting a new thread

Select **New thread** on a box card. The dialog asks for the agent, its mode,
and its other settings, because the agent is fixed for the life of the thread.
The dialog shows the settings that the agent's adapter last advertised, and the
last choice made for that agent.

A new thread starts empty, on the same workspace as the other threads of the
box.

## Thread names

An agent can give its thread a title at the end of a turn. Until it does, the
first line of a prompt sent on the thread names it. A thread that was never
prompted shows as "Thread" and its number, for example "Thread 2".

## Sending prompts

Type the prompt in the text area at the bottom and send it with Ctrl+Enter
(Cmd+Enter on a Mac) or the **Send message** button. Enter adds a line, because
a prompt is often several lines of prose.

To attach a file, select the **Add Attachment** button beside the text area, or
drop the file onto it. Attached files are uploaded to the box's workspace when
the prompt is sent; the agent receives their paths with the prompt.

While the agent works, a stop button replaces the send button. It cancels the
turn. A command the turn left running in the background is not cancelled by
this; see "Background work" below.

### Slash commands

Type `/` at the start of the text area to list the slash commands the agent's
adapter accepts. The list filters as you type. Picking a command writes it into
the text area without sending, because a command can take arguments.

Skills and commands are configured in [agent sets](agent-sets.md), not per thread.

### Modes and settings

The **Agent settings** button in the thread header opens the settings the
adapter offers: the agent mode, the model, and whatever else it advertises,
such as a thinking effort.

The mode controls how much the agent does without asking, for example the plan
mode of Claude Code or the read-only mode of Codex. Changes apply to the open
thread at once. The orchestrator records the mode and settings, so a restarted
adapter puts the thread back the way it was.

## Permission requests

Some tool calls need a decision. The question renders on the tool call that
caused it, and the turn waits for an answer. All browsers on the thread show
the question; the first answer removes it from the others. When nobody watches
the thread, the orchestrator can send a push notification. See
[notifications](notifications.md).

## Marking a thread done

Select the **Mark this thread done** button in the thread header to mark the
thread done. The box list strikes the thread's name through. The mark is a note
for the reader only: the thread keeps its conversation, its background work
keeps running, and it still answers prompts. Select the button again to remove
the mark.

## Forking a thread

Select the **Fork this thread** button in the thread header to branch the
conversation into a second thread. The fork opens on everything said in the
source thread so far and continues on its own from there. The source thread is
not changed.

A fork keeps the agent and the settings of its source, because only the adapter
that wrote a transcript can load it. It starts in its agent's fork mode — plan
for Claude Code, read-only for Codex — because it shares the source's
workspace while the source can still be working in it.

The fork button shows only when the adapter has advertised the fork capability.
A thread that was never prompted has nothing to fork yet.

After forking, the page shows a link to the new thread. Open it in a new tab to
keep both conversations on screen.

## Background work

An agent can leave work running in the box after its turn: a dev server, a
build, a monitor. While something runs, a bar above the text area lists the
tasks of this thread with their ages. Expand it to see each task. Select a
stop button to kill one task, or **Stop all** to kill all of them. Killing
stops the process and everything it started; half-done work stays half-done.

Work that no adapter claims any more — for example after an adapter restart —
shows as a badge on the box card instead. **Stop everything** on the card kills
every process in the box that Boxes did not start itself.

## Reading state at a glance

The row of a thread on the box card shows a status dot: approval waiting, the
agent thinking, background work running, or idle. The browser tab title carries
the same state as a symbol, so a thread that needs a person is visible in the
tab bar. In the thread header, the box name comes first and the thread name
after it, as in the tab title.

## History

The orchestrator keeps each thread's messages in memory, up to 4 MiB per
thread. Above that, it drops the oldest messages, and the top of the thread
shows **Load full history**. The button asks the adapter to replay the full
transcript. It is refused while the agent is working on the thread.
