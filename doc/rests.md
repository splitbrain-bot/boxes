# REST API

The [orchestrator](orchestrator.md) serves a REST API under `/api`. The dashboard is its only client. The API is
unauthenticated: put [authentication in front of the orchestrator](compose.md) when the deployment is reachable.

Requests and responses are JSON unless stated otherwise. A refusal answers with a 4xx or 5xx status and a body of `{
"error": "…" }`.

## Health

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/healthz` | `HealthResponse` |
| GET | `/readyz` | `ReadyResponse`, status 200 or 503 |

Liveness answers 200 always and describes what is wrong in the body. Readiness answers 200 only when the database, the
egress proxy, and the Docker daemon are all reachable.

## Harnesses

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/harnesses` | `HarnessInfo[]` |

Lists every [harness](glossary.md) this deployment can run. For each one it carries the registry's defaults, the
adapter's last advertised modes and config options (when one has answered), and the state of its credential.

## Boxes

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/boxes` | `BoxSummary[]` |
| POST | `/api/boxes` | 201, `BoxDetail` |
| GET | `/api/boxes/:id` | `BoxDetail` |
| POST | `/api/boxes/:id/start` | `BoxDetail` |
| POST | `/api/boxes/:id/stop` | `BoxDetail` |
| DELETE | `/api/boxes/:id` | 204 |

`POST /api/boxes` accepts a `CreateBoxBody`:

```json
{
  "name": "my-box",
  "agentSet": "set-id-or-null",
  "thread": { "harness": "claude", "modeId": "…", "config": { } }
}
```

Every [box](boxes.md) is created with one thread. `thread` selects its harness and its initial mode and config; absent,
it is Claude on its defaults. `profile` is accepted but ignored.

## Threads

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/boxes/:id/threads` | `ThreadSummary[]` |
| POST | `/api/boxes/:id/threads` | 201, `ThreadSummary` |
| POST | `/api/boxes/:id/threads/:threadId/done` | `ThreadSummary` |
| POST | `/api/boxes/:id/threads/:threadId/background/stop` | `{ "stopped": n }` |
| POST | `/api/boxes/:id/background/stop` | `{ "stopped": n }` |

`POST /api/boxes/:id/threads` accepts a `CreateThreadBody`. `from` names a [thread to fork](threads.md); absent, the new
thread starts empty. `options` selects the harness; it is ignored on a fork, which stays on its source's harness.

`POST …/done` accepts `{ "done": true|false }`. The mark only changes how the thread is drawn in a list; the thread
still runs and answers.

`POST …/background/stop` accepts `{ "processId": "…" }` to stop one task the adapter announced, or no body to stop every
task of that thread.

`POST /api/boxes/:id/background/stop` signals every process in the box's container that the orchestrator did not start
itself. It reaches work no adapter names any more, such as what a crashed adapter left running.

## Attachments

| Method | Path | Answer |
| --- | --- | --- |
| POST | `/api/boxes/:id/attachments?name=<file>` | `StoredAttachment` |
| GET | `/api/boxes/:id/attachments/:name` | file bytes |

The POST body is the file's raw bytes with content type `application/octet-stream`. The limit is `MAX_ATTACHMENT_MB`
(default 25). The file lands in the box's [workspace](storage.md) under `.boxes/attachments/`, and the answer carries
the workspace-relative path for the prompt that mentions it.

The GET serves a stored attachment back, which is how the thread shows a picture the user attached.

## Code review

The [review](review.md) reads the box's workspace directory. Routes that ask git start a stopped box's container first.

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/boxes/:id/review/dir?path=<p>&fresh=1` | `ReviewDirResponse` |
| GET | `/api/boxes/:id/review/file?path=<p>` | `ReviewFileResponse` |
| GET | `/api/boxes/:id/review/raw?path=<p>` | file bytes |
| PUT | `/api/boxes/:id/review/file` | `ReviewFileResponse` |
| PUT | `/api/boxes/:id/review/annotations` | `ReviewAnnotationsResponse` |
| DELETE | `/api/boxes/:id/review/annotations?path=<p>&line=<n>` | `ReviewAnnotationsResponse` |
| PUT | `/api/boxes/:id/review/base` | `ReviewBaseResponse` |
| DELETE | `/api/boxes/:id/review` | 204 |

`path` is always workspace-relative and slash-separated. On `dir`, an empty `path` lists the workspace root, and
`fresh=1` makes the orchestrator ask git again rather than answer from its cache.

`PUT …/review/file` accepts a `ReviewFileBody` with `path`, `content`, and the `hash` the file was read at. A save over
an edit the agent made in the meantime is refused with a 412; the reviewer can then save anyway or drop the changes.

`PUT …/review/annotations` accepts a `ReviewAnnotationBody` with `path`, `line`, and `comment`, and creates or replaces
the comment on that line. `REVIEW.md` holds at most one comment per line. DELETE removes it.

`PUT …/review/base` accepts `{ "rev": "…" }` and compares the whole review against that revision. `null` or absent
clears the base back to each repository's own HEAD. The answer says where the expression resolved in each repository.

`DELETE …/review` deletes `REVIEW.md`, which is the review.

## Agent sets

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/agent-sets` | `AgentSetSummary[]` |
| POST | `/api/agent-sets` | 201, `AgentSetDetail` |
| GET | `/api/agent-sets/:setId` | `AgentSetDetail` |
| PATCH | `/api/agent-sets/:setId` | `AgentSetDetail` |
| DELETE | `/api/agent-sets/:setId` | 204 |
| PUT | `/api/agent-sets/:setId/items` | `AgentSetDetail` |
| DELETE | `/api/agent-sets/:setId/items?kind=<k>&name=<n>` | `AgentSetDetail` |
| GET | `/api/agent-sets/:setId/preview` | `AgentBundlePreview` |

`POST` accepts `{ "name": "…" }`. `PATCH` accepts `{ "name"?, "agentsMd"? }` and leaves absent fields alone. Every
mutation answers with the whole set.

`PUT …/items` accepts an `AgentItemBody` with `kind` (`skill` or `command`), `name`, and `content`, and creates or
replaces the item under that name. DELETE removes it.

The preview answers what a box that selects this [agent set](agent-sets.md) receives: the global set, with this set laid
over it.

## Credentials

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/credentials` | `CredentialSummary[]` |
| PUT | `/api/credentials/:id` | `CredentialSummary` |
| DELETE | `/api/credentials/:id` | 204 |

`:id` is one of `claude`, `openai`, `github`, `gitlab`, `devtunnels`. A PUT accepts a `PutCredentialBody` with `method`
(`token`, `api_key`, or `oauth`; default `token`) and the `secret`. The secret goes in and never comes back out: every
answer carries only an account and a status.

## Logins

A login obtains a [credential](credentials.md) that cannot be pasted. The orchestrator runs the harness's own CLI in a
throwaway container and drives it.

| Method | Path | Answer |
| --- | --- | --- |
| POST | `/api/credentials/:id/login` | `StartLoginResponse` |
| GET | `/api/credentials/:id/login/:loginId` | `LoginState` |
| POST | `/api/credentials/:id/login/:loginId/code` | 204 |
| DELETE | `/api/credentials/:id/login/:loginId` | 204 |

POST starts a login and answers with the id the other calls take. The page polls the GET for the state, which is
`starting`, `awaiting_browser` (with a URL, and a one-time code where the flow has one), `awaiting_code`, `done`, or
`failed`. The POST to `…/code` hands the CLI the code the login page gave the user; only Claude's CLI asks for one.
DELETE cancels the login and removes its container. `github` and `gitlab` have no flow and answer a 400.

## Settings

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/settings` | `Settings` |
| PATCH | `/api/settings` | `Settings` |

Settings are the deployment's plain configuration, not secrets: the [git identity](credentials.md) the agent in a box
commits as, and what each thread dialog last chose. PATCH writes the fields it names and answers with all of them.

## Web Push

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/push/key` | `PushKeyResponse` |
| POST | `/api/push/subscribe` | 204 |
| DELETE | `/api/push/subscribe` | 204 |

The key is the deployment's VAPID public key. A browser reads it before it [subscribes](notifications.md). POST accepts
a `PushSubscribeBody` shaped like the browser's own `PushSubscription.toJSON()`, with the endpoint, the encryption keys,
and an optional label. DELETE accepts `{ "endpoint": "…" }` and forgets that subscription.

Boxes has no accounts: a subscription belongs to the deployment, and whatever authenticates `/api` decides who may add
one.

## Static files

Every GET outside `/api` and `/ws` serves the dashboard bundle. A path that names a file in the bundle gets that file;
every other path gets `index.html`, so client-side routes survive a reload. Content-hashed assets under `/assets/` carry
an immutable year-long cache header; everything else is revalidated on every load.
