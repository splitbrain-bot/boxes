# Boxes

A box is an isolated Docker container. It encapsulates a workspace, a home directory, a Nix store, and a
private network. The [glossary](glossary.md) defines these terms.

## Creating a box

Select **New** on the box list. The form asks for:

- a name (100 characters or fewer),
- an optional agent set, merged over the global set (see [agent sets](agent-sets.md)),
- the agent and settings of the first thread.

The orchestrator then:

1. Pulls the box image when it is not on the host.
2. Allocates a `/24` subnet from `BOX_SUBNET_POOL` and creates the box's private network.
3. Creates the workspace, home, and Nix store directories in the data volume.
4. Writes the merged agent set to a directory the container mounts read-only.
5. Creates and starts the container.

The container runs as the unprivileged `agent` account. Its root filesystem is read-only. The orchestrator
puts a credential placeholder for each known service into the environment; the [egress proxy](egress.md)
replaces a placeholder with the real secret on the wire. No real credential enters a box.

The first thread is created in the same request. Creating a box does not require a working credential: the
thread is a database row until a browser opens it.

## The box list

The box list is the dashboard home page. It polls every five seconds while visible. Each box shows as a card
with:

- the box name and id,
- status badges (see [box status](status.md)),
- disk use, when measured,
- one row per thread,
- buttons for **New thread**, **Review**, **Terminal**, and, when orphaned background work is detected,
  **Stop everything**.

The info icon on a card opens the box's details page.

## Box details

The details page shows the box's identity and runtime state: container id, network name and subnet, agent
set, last activity, disk use, and the ACP session id of the most recently active thread. It lists the dev
tunnels the box hosts and the processes the orchestrator last read in the box.

The page has three controls:

- **Start** — starts a stopped box's container and re-attaches the egress proxy.
- **Stop** — stops the container and drops the ACP connection. The workspace, home, and Nix store stay.
- **Delete** — removes the container, the network, the workspace, the home directory, the Nix store, and
  the agent set directory. The database keeps the box row as a tombstone. This cannot be undone.

A box has no page of its own other than the details page.

## Starting and stopping

A box starts when:

- a user selects **Start** on the details page,
- a browser opens a thread of a stopped box,
- a terminal opens on a stopped box,
- a review asks for a Git command in a stopped box.

Before the container starts, the orchestrator repairs what drifted: it rewrites the agent set, recreates a
container that Docker lost, recreates the network when it is gone, and replaces the container when the box
image tag has moved. A repair that would replace the container is deferred while the container runs, so a
turn is never cut off.

A box stops when:

- a user selects **Stop** on the details page,
- the idle reaper finds no turn, no waiting approval, no attached browser, no open terminal, no background
  task, and no activity for `IDLE_STOP_MINUTES` (default 30 minutes).

A stopped box keeps its workspace, home, and Nix store. Opening a thread starts it again.

## The box image

Every box is created from the image `BOX_IMAGE` names (default `ghcr.io/splitbrain/boxes/box:latest`). The
orchestrator pulls it when it is missing, and again every `BOX_IMAGE_PULL_MINUTES` (default 60). A box moves
onto the new image at its next start; a running box is left alone. Superseded image copies are removed when
`BOX_IMAGE_PRUNE` is on.

## Resource limits

Each box container has the limits the deployment configures: `BOX_MEM_LIMIT` (default 4 GiB), `BOX_CPUS`
(default 2), and `BOX_PIDS_LIMIT` (default 512). The limits cover every process in the box, including all
adapters and their agents.

## Box Layout

| Path | Source | Access |
| --- | --- | --- |
| `/workspace` | the box's workspace directory | read and write |
| `/home/agent` | the box's home directory | read and write |
| `/nix` | the box's Nix store directory | read and write |
| `/boxes/agent` | the merged agent set | read only |
| `/tmp` | memory | read and write, empty at each start |

The three persistent directories stay when a box stops and survive a box image change. They are removed only
when the box is deleted. See [storage](storage.md).

## Networking

Each box has its own internal Docker network with no route to the outside. The egress proxy is attached to
it and is the only way out. Tools in the box use `HTTP_PROXY` and `HTTPS_PROXY` to reach it. See
[egress proxy](egress.md).

A process in a box can share a web app through a dev tunnel, using the `share-app` skill. The tunnels a box
hosts are listed on its details page. See [skills](skills.md).

## What happens at orchestrator boot

At boot the orchestrator aligns its database with what Docker runs. It adopts live containers, marks boxes
whose containers are missing as stopped, and marks a create that was interrupted as an error. Gateway
connections are re-established on first use.

A periodic sweep removes Docker objects and directories that belong to no known box: what a crash during a
create or a failed delete left behind.
