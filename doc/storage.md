# Storage

A deployment has one Docker volume, `boxes-data`. Compose mounts it at `/data` in the orchestrator, which is the default
of `DATA_DIR`. Everything that must survive a restart is in this volume. The egress proxy has no volume at all, and
keeps its rules and credentials in memory only.

| In the volume | Contents | In a box container |
| --- | --- | --- |
| `boxes.db` | the boxes, threads, settings, credentials and the generated keys | not mounted |
| `orchestrator.lock` | the claim of the running orchestrator | not mounted |
| `workspaces/<box id>` | the files an agent works on | `/workspace`, read and write |
| `homes/<box id>` | the home directory of the agent account | `/home/agent`, read and write |
| `nix/<box id>` | the Nix store of the box | `/nix`, read and write |
| `skill-repos/<repo id>` | the checkout of a skill repository of an [agent set](agent-sets.md) | not mounted |

`/tmp` is the one path in the container with no source in the volume. It is memory, 512 MB large, and empty at each
start. Every other path comes from the box image, and the root filesystem is read only, so an agent writes only in the
mounted directories and in `/tmp`.

`TMPDIR` names `/home/agent/.cache/tmp` and not `/tmp`, because the tmpfs counts against the memory limit of the
container, while the home is on disk. The [box setup](boxes.md#the-setup) empties that directory at each start.

The three directories with a box id in the name are bind mounts. Each box container gets the mounts of its own box, and
nothing else of the volume. The orchestrator reads and writes the files in the workspace, the home and the Nix store
only through the [file service](files.md) in the box.

## Access to the data

The orchestrator creates and deletes all of `/data`. It reads and writes all of it, except the files in the workspace,
the home and the Nix store of a box. It reads and writes those through the file service in the box, which runs as the
agent.

The agent and the [terminal](terminal.md) in a box read and write the workspace, the home and the Nix store. They run as
the unprivileged `agent` account, which owns the files in them.

## Lifetime

The workspace, the home and the Nix store stay when a box container stops, and the next start uses them again. They also
stay when the box image changes. Only `/tmp` and the memory of the container are lost at a stop. The agent set directory
also stays, and the orchestrator writes its contents again at each start. [Agent sets](agent-sets.md) describes that.

When a user deletes a box, the orchestrator deletes the container, the workspace, the home, the Nix store and the agent
set directory together. This cannot be undone.

## Disk usage

The box list shows the size of each box. It is the sum of the apparent file sizes in the workspace, the home and the
Nix store. The [file service](files.md) in the box measures it. Symlinks count as nothing.

The orchestrator measures a box before each stop. When the measurement takes longer than 60 seconds, the box stops and
keeps its old value. The orchestrator measures a running box again at most every 15 minutes, when the box list asks for
it. A stopped box keeps the value of its last measurement, and the details page shows when it was measured.

## Backups

Back up the `boxes-data` volume. It holds the full state of the deployment. Stop the stack before you copy the volume,
because the orchestrator keeps the database open while it runs.

The volume also holds the saved [credentials](credentials.md) and the key of the certificate authority. The credentials
are not encrypted, because the orchestrator must send them to the proxy. Protect a backup in the same way as the tokens
in it.

## Settings

`DATA_DIR` and `HOST_DATA_DIR` control where the data directory is. [Environment variables](environment.md) describes
both. [Docker Compose setup](compose.md) describes the volume in the shipped Compose file.

## Technical internals

### The lock file

`orchestrator.lock` claims the data directory for the running orchestrator, so two orchestrator processes never share
one directory — they would share the database, the subnet pool and the containers, and the second boot would clear the
first one's pending permission requests. The holder re-stamps the file on a short interval, and a new process takes over
a claim that stops being stamped. The process id inside cannot decide: in a container, every orchestrator is PID 1.

### Host-side paths

The Docker daemon, not the orchestrator process, resolves bind-mount sources, so the orchestrator must name paths as the
daemon sees them. At boot it inspects its own container and takes the host source of the mount whose destination is
`DATA_DIR`; the container id comes from `/proc/self/mountinfo`, `/proc/self/cgroup` or `/etc/hostname`. Outside a
container the two paths are the same. When neither source works — with a nested or rootless daemon — `HOST_DATA_DIR`
names the path. A failure to resolve is fatal at boot: without it, the daemon would create and mount an empty directory
at the unresolved path without a warning.

### Ownership and modes

Docker does not initialize ownership on a bind mount, so the orchestrator chowns every path it creates in a box's
directories to `BOX_UID`. The parent roots and each home directory are mode 0700 — a home holds the transcripts and
whatever a login wrote — while a workspace and a Nix store are 0755. The orchestrator writes the generated secret files
with mode 0600, atomically.

### The database

`boxes.db` is a SQLite database in WAL mode, with migrations tracked by `user_version`. A deleted box keeps its row as a
tombstone. The periodic sweep removes every labelled container, network and directory that has no live row, and a
tombstone counts as no live row, so a teardown that failed halfway is cleaned up at the next sweep. [Boxes](boxes.md)
describes the sweep. The database stores no directory paths: every file a box owns lives in the directories named by its
id.
