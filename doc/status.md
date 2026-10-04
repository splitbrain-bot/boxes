# Box status

The box list and box details show one primary status badge plus any relevant
activity badges. More than one badge can appear at the same time.

## Primary status

**Up**

The box container is running. If no thread is open and the box is idle, the
orchestrator stops it after the configured idle period.

**Creating**

Boxes is creating the container, workspace, and private network. This label is
shown until Docker reports that the container is up.

**Stopped**

The box container is not running. Its workspace and home directory remain.
Opening a thread starts the box again.

**Error**

The orchestrator could not create, start, or otherwise manage the box.

## Activity badges

A badge that has a number to show carries it, such as "1 approval" or "3 jobs".

**Approvals**

An agent is waiting for your decision. The badge shows the number of approvals
waiting.

**Thinking**

An agent is actively producing a response in one of the box's threads.

**Jobs**

The box has work still running in the background, such as a command or monitor
an agent started. The badge shows the number of jobs. The box stays running
while this work continues.

**Tunnels**

The box shares a web app through a tunnel. The badge shows the number of
tunnels.

**Viewers**

The badge shows the number of browsers displaying a thread in the box. The box
stays running while a browser displays one of its threads.
