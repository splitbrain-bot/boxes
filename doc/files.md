# File service

The file service `boxes-files` is a process in a [box](boxes.md). The orchestrator reads and writes all files of a box
through it. The orchestrator starts the process and talks to it over its standard input and output. The file service
runs as the `agent` account.

## Users

| Feature | Operations |
| --- | --- |
| [Code review](review.md) | list a directory, find the repositories, read, download and save a file, read and write `REVIEW.md`, delete the review |
| Attachments of a [thread](threads.md) | create the attachment directory, store an attachment, download it again |
| [Disk usage](storage.md#disk-usage) | measure the size of the workspace, the home and the Nix store |
| [Box setup](boxes.md#the-setup) | write the CA and the git configuration into the home |
| [Agent sets](agent-sets.md) | install the merged set into the home |

## Lifetime

A file operation starts a stopped box, and starts the file service when it does not run. The file service then runs
until the box stops. A file operation counts as activity, so the idle reaper waits `IDLE_STOP_MINUTES` from then.

A disk measurement is the exception. It runs only on a running box, and it does not count as activity.

## Box image version

A running box keeps its image until it stops, so its file service can be older than the orchestrator. The orchestrator
refuses a file service of another protocol version. The error gives the version found and the version needed. For an
image without the file service, the version found is "none". The box then needs an image with the current file service.

## Technical internals

The source is in `files/`, the protocol in `shared/files.ts`, and the client in `orchestrator/src/files.ts`. The box
image installs the bundle as `/usr/local/bin/boxes-files`.

### Protocol

The orchestrator starts the process with `docker exec`, as it starts an adapter. The two sides speak HTTP/2 over the
standard input and output of the process. Each operation is one request. The method and the path name the operation,
the `path` query names a file relative to `/workspace`, and the body holds the bytes. Each request is its own HTTP/2
stream, so several requests run at the same time on one connection. A download is streamed to the browser.

| Request | Operation |
| --- | --- |
| `GET /list` | the plain files and directories of one directory, at most 2,000 |
| `POST /find-repos` | the directories that hold a `.git`, breadth first, with the limits in the body |
| `GET /stat` | the type and the size of one path |
| `GET /read` | the start of one file, up to the `cap` in the query, with its hash in the `ETag` header |
| `GET /raw` | the whole file, as a stream |
| `PUT /file` | replace one file with the body |
| `DELETE /file` | remove one file |
| `POST /mkdir` | create one directory |
| `POST /create` | write the body under the first free name in a directory |
| `GET /size` | the apparent size of the workspace, the home and the Nix store |
| `POST /setup-files` | write the files of the orchestrator in the body into the home |
| `POST /agent-set` | install the agent set in the body |

Each reply has the header `boxes-files-version`.

### Paths and writes

The file service refuses a path outside `/workspace` and a symlink as the last path component. `list` leaves out
symlinks.

A `PUT /file` needs `If-Match` with the hash of the last read, or `If-None-Match: *` for a new file. When the file does
not match, the file service refuses the write with 412. The bytes go to a temp file that then replaces the target, so a
reader never sees a half-written file.

### Client

The agent can replace the file service. Thus the orchestrator checks the shape and the size of each reply, and each
request has a timeout. After a lost connection, the orchestrator tries a read once more. A write fails at once, because
a second attempt would report a false conflict.

The process probe of the [background work](threads.md#background-work-1) counts `node …/boxes-files` as part of the
box, like an adapter.
