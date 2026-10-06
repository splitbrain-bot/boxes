# Agent communication

The dashboard and the agents speak the Agent Client Protocol (ACP), which is
built on JSON-RPC. The orchestrator is between the two. It answers a browser
as an ACP agent, and it drives the adapter in a box as an ACP client.

```mermaid
flowchart TB
    b1["browser<br>phone"]
    b2["browser<br>desktop"]
    b3["browser<br>second tab"]

    subgraph orch["orchestrator"]
        t1["thread 1<br>Claude Code"]
        t2["thread 2<br>Codex"]
        t3["thread 3<br>Claude Code"]
    end

    e1(["docker exec"])
    e2(["docker exec"])

    subgraph boxc["box container"]
        subgraph ad1["adapter claude-agent-acp"]
            s1["session of thread 1"]
            s3["session of thread 3"]
        end
        subgraph ad2["adapter codex-acp"]
            s2["session of thread 2"]
        end
    end

    b1 <-- "WebSocket" --> t1
    b2 <-- "WebSocket" --> t1
    b3 <-- "WebSocket" --> t2

    t1 <--> e1
    t3 <--> e1
    t2 <--> e2
    e1 <--> s1
    e1 <--> s3
    e2 <--> s2
```

## Threads and sessions

Boxes calls one conversation a thread. The protocol calls it a session, and so
does the adapter that holds it. One thread is therefore one session, and the
orchestrator holds the two ends together.

## From a browser to the orchestrator

The dashboard runs in the browser. To show a thread, it opens a WebSocket to the
orchestrator and speaks ACP over it. Two browsers on one thread are two connections,
as the phone and the desktop are in the diagram above.
So for each thread, the browser opens one connection to the orchestrator.

The websocket connection is authenticated with a token, that the dashboard
code obtains via the REST API before it opens the connection. The token belongs
to the box: it is valid for all threads of that box and for its terminal.

## From the orchestrator to the adapter

An adapter is the process that makes one harness available over ACP. It starts
the agent, and it translates between the protocol and that agent. It runs inside
the box container.

The orchestrator starts an adapter with `docker exec` when a thread needs it
for the first time. The adapter reads and writes JSON-RPC messages on standard
input/output of that exec. Its standard error carries log messages.

One exec and one adapter process serve one harness. So all threads of the same
harness are sessions in that process.
In the diagram, thread 1 and thread 3 both run in `claude-agent-acp` while
thread 2 runs in `codex-acp`. A box with Claude and Codex threads
therefore runs two adapter processes on one workspace.

## The message log

The orchestrator keeps the messages of each thread in its memory. A browser
that opens an existing thread for the first time receives this log from the
orchestrator. On later reconnections, it receives only the messages that it
does not yet hold.

The orchestrator log is limited to 4MiB per thread. Above this size, it drops
the oldest messages of the thread. In that case a use can request the full
transcript using the **Load full history** button: the orchestrator then
read the full transcript from the adapter and passes it through to
the dashboard. A thread whose log is complete shows no such button.

A full transcript can only be requested while the thread is idle.

The orchestrator sends the updates of a thread to every browser that has a
connection open to that thread. In the diagram's example,
the orchestrator sends updates of thread 1 to the phone and desktop
- they show the same messages.

## Permission requests

Some tool calls need the permission of the user. The agent asks for it, and
the turn stops until an answer comes back.

The orchestrator sends the question to the browser that was active last on the
thread. If nobody watches the thread, the orchestrator keeps the question and
sends a push notification. The next browser that opens the thread receives it.
If several browsers are on the thread, all of them show the question, and the
first answer removes it from the others.

`PERMISSION_HOLD_MINUTES` sets how long a question waits. `PERMISSION_FALLBACK`
decides what happens then: `hold` keeps it waiting, and `deny` refuses the
tool call with a refusal that the agent offered, or cancels the tool call when
the agent offered none. Boxes approves no tool call automatically.

## Mode and settings

A mode controls how much an agent does without a question, such as the plan
mode of Claude Code or the read-only mode of Codex. The settings are the other
choices that an agent offers, such as the model or thinking effort level.
A user selects both in the new thread dialog and in the thread header.

An adapter forgets the mode and the settings of a session when it stops. The
orchestrator therefore records both in its database, each time the adapter
accepts a change and each time the agent changes something itself. It then
restores them when a thread is opened again.

## Adapter restarts

An adapter process ends when its box container is stopped or when it crashes.

The next message for one of its threads starts it again: a user that opens a
thread, or a prompt sent on one. The orchestrator then restores the session of
the last opened and all currently connected threads and applies the recorded
mode and settings.

The other threads of the box resume their session when a user opens them.

If an adapter does not start, the orchestrator repeats the attempt three
times. After that, the status of the box becomes **Error**. Threads of the
other harness in the same box continue to run.
