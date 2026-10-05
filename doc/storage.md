# Storage

A deployment has one Docker volume, `boxes-data`. Compose mounts it at `/data`
in the orchestrator, which is the default of `DATA_DIR`. Everything that must
survive a restart is in this volume. The egress proxy has no volume at all,
and keeps its rules and credentials in memory only.

```
/data
├── boxes.db              the database: boxes, threads, settings, credentials
├── vapid-keys.json       the keys for push notifications
├── egress-secrets.json   the certificate authority and the placeholders
├── orchestrator.lock     the claim of the running orchestrator
├── workspaces/<box id>   the files an agent works on
├── homes/<box id>        the home directory of the agent account
├── nix/<box id>          the Nix store of the box
└── agents/<box id>       the agent set that the box was started with
```

The three box directories and the agent set directory are bind-mounted into
the box container. The orchestrator therefore has a file path to the work of
each box, and does not need a running container to read it.

## What a box container sees

| Path | Source | Access |
| --- | --- | --- |
| `/workspace` | `workspaces/<box id>` | read and write |
| `/home/agent` | `homes/<box id>` | read and write |
| `/nix` | `nix/<box id>` | read and write |
| `/boxes/agent` | `agents/<box id>` | read only |
| `/tmp` | memory | read and write, 512 MB, empty at each start |
| all other paths | the box image | read only |

The root filesystem of the container is read only, so an agent can install
software only with `nix`, or in its home directory. `TMPDIR` is a directory in
the home, and the entrypoint empties it at each start.

A box container has the bind mounts of its own box only. It has no path to the
files of another box, and no path to the database.

## Who accesses what

The orchestrator creates, reads, writes and deletes all of `/data`. It writes
an uploaded attachment to `.boxes/attachments` in the workspace, and the code
review writes `REVIEW.md` there.

The agent and the terminal in a box read and write the three box directories.
They run as the unprivileged `agent` account, which owns the files in them.

The orchestrator runs every Git command as a `docker exec` in the box, and not
in its own process. A repository can name a program for Git to run, and that
program must be an agent process in a box.

The egress proxy accesses no volume and no file.

## Lifetime

The three box directories stay when a box container stops, and the next start
uses them again. They also stay when the box image changes. Only `/tmp` and
the memory of the container are lost at a stop.

When a user deletes a box, the orchestrator deletes the container, the
workspace, the home, the Nix store and the agent set directory together. This
cannot be undone.

The box list shows the size of each box. It is the sum of the three
directories. The orchestrator measures a running box every 15 minutes, and
measures a stopped box once.

## Backups

Back up the `boxes-data` volume. It holds the full state of the deployment.
Stop the stack before you copy the volume, because the orchestrator keeps the
database open while it runs.

The volume also holds the saved credentials and the key of the certificate
authority. The credentials are not encrypted, because the orchestrator must
send them to the proxy. Protect a backup in the same way as the tokens in it.

## Settings

`DATA_DIR` and `HOST_DATA_DIR` control where the data directory is.
[Environment variables](environment.md) describes both. [Docker Compose
setup](compose.md) describes the volume in the shipped Compose file.
