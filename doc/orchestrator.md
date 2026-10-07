# Orchestrator

The orchestrator is the service a user talks to. It serves the dashboard, answers the API, keeps the state of the
deployment, and drives the Docker daemon. The [egress proxy](egress.md) is the only other service.

The orchestrator has no authentication of its own, and it holds the Docker socket of the host. Put an authenticated
reverse proxy in front of it; see [Docker Compose setup](compose.md).

## What it serves

One port, `PORT`, carries all of it:

| Path | Contents |
| --- | --- |
| `/` | the dashboard bundle |
| `/api` | the [REST API](rests.md) |
| `/ws/boxes/:id/…/acp` | the [ACP gateway](acp.md) |
| `/ws/boxes/:id/terminal` | the [terminal](terminal.md) |
| `/healthz`, `/readyz` | liveness and readiness |

A WebSocket upgrade must present the token of the box that its path names. The dashboard reads that token from the REST
API first.

## What it manages

| Subject | What the orchestrator does |
| --- | --- |
| [Boxes](boxes.md) | Creates, starts, stops, repairs and deletes the containers, networks and directories. |
| [Threads](threads.md) | Starts the adapters, routes the ACP messages, and records the mode and settings. |
| [Agent sets](agent-sets.md) | Stores them, and writes the merged set into a box at each start. |
| [Credentials](credentials.md) | Stores and refreshes the secrets, and runs the login flows. |
| [Egress](egress.md) | Pushes the policy to the egress proxy, and attaches the proxy to each box network. |
| [Review](review.md) | Reads the workspace, and runs git in the box. |
| [Notifications](notifications.md) | Sends a Web Push message when a thread needs a person. |
| Tunnels | Remembers which box hosts which dev tunnel, and deletes the tunnels that nothing hosts. |

The orchestrator does no agent work itself. An agent runs in a box, and an adapter makes it available over ACP.

## State

All state is in `DATA_DIR`:

- `boxes.db`, an SQLite database in WAL mode. It holds metadata only: the boxes, threads, credentials, settings, agent
  sets, push subscriptions and tunnels. The transcripts stay in the adapters, and the runtime state stays in Docker.
- The files of each box, and the generated keys. See [storage](storage.md).

Everything else is in memory, among it the ACP message log and the unanswered permission requests. A restart loses it.

One orchestrator can use one data directory. The boot claims `orchestrator.lock`, and a second orchestrator on the same
directory logs the conflict and stops.

## Background loops

Five loops run beside the requests. Each tick asserts a state again, so a failed tick is logged and the next tick does
its work. A tick that is slower than the interval skips the next tick.

| Loop | Interval | Each tick |
| --- | --- | --- |
| Idle reaper | 1 minute | Stops the idle boxes, drops unused gateway state, and removes stray Docker objects. |
| Proxy reconcile | 1 minute | Attaches the egress proxy to each box network again, and pushes the policy. |
| Credential refresh | 1 minute | Renews the stored access tokens before they expire. |
| Tunnel reconcile | 1 minute | Reads the dev tunnels that the boxes host, and deletes the unused ones. |
| Image refresh | `BOX_IMAGE_PULL_MINUTES` | Pulls `BOX_IMAGE` again. |

## Boot

The boot has a fixed order:

1. Read and validate the environment.
2. Claim the data directory.
3. Open the database and apply the pending migrations.
4. Prepare the egress policy and push it. The placeholders must exist before the first box is created.
5. Resolve the host-side path of `DATA_DIR`, because a bind mount names a path that the Docker daemon resolves.
6. Pull the box image.
7. Reconcile the database rows against Docker (see [boxes](boxes.md)).
8. Start the loops, and listen.

An invalid configuration, a claimed data directory or a database from a newer build stops the boot. Steps 4 and 6 are
best effort: the loops try them again, and a box that is created meanwhile reports the real error.

## Shutdown

On `SIGTERM` or `SIGINT` the orchestrator stops the loops first, and stops listening while it answers the requests that
it already has. It then waits up to eight seconds for the running turns. Turns that are still running after that are
cut, and the orchestrator logs which boxes they were in. Last, it closes the adapters, removes the login containers, and
closes the database.

The box containers are not stopped. The reconcile at the next boot adopts them again.

## Logging

The orchestrator writes one JSON object per line to standard error. `LOG_LEVEL` sets the lowest severity that is
written. `debug` logs every forwarded ACP message.

## Technical internals

### The data directory claim

`orchestrator/src/lock.ts` writes a lock file that the holder stamps every five seconds. A claim that is not stamped for
twenty seconds is taken over, because the process id in the file proves nothing: in a container every orchestrator is
PID 1, so the id of a killed one is alive in its replacement. Two orchestrators on one directory would share a database,
a subnet pool and the containers, and the second boot would also clear the permission requests that the first one waits
on.

### Configuration

`config.ts` parses the [environment](environment.md) with zod. Every setting has a working default, so the orchestrator
starts with no configuration at all. An unaccepted value fails the boot together with the rest of the configuration,
rather than at the first use.

### Schema migrations

`db.ts` holds the migrations in an array, and applies those that `user_version` does not count yet, each one in its own
transaction. A database whose `user_version` is higher than the array fails the boot, because there is no migration
back.

### Log redaction

`log.ts` redacts the fields of each line: a field whose name reads like a secret loses its value, and a value that reads
like an API token is replaced wherever it is. The message text itself is not redacted, so a message must not carry a
secret.

### The dashboard document

`app.ts` serves the bundle under a content security policy that pins every fetch of the page to the orchestrator's own
origin. A thread shows markdown that an agent wrote, and a remote image in it would carry data out through the reader's
browser and past the egress proxy. The page has one inline script, the theme switch that runs before the first paint;
the policy names it by its hash, so every other script is refused.
