# Plan: a second harness

Boxes drives Claude Code over ACP. This plan adds OpenAI Codex as a second
harness, and makes the changes that choice forces: credentials move out of the
environment into the database, a session holds one adapter per harness in use,
and background work comes from the adapters instead of from the process table.

Read `ARCHITECTURE.md` first. This plan names the places it changes and
assumes you know what they do.

## 1. Scope

**In scope.** A harness registry. A per-thread harness. A credential store with
a settings page, including logging in to an account rather than pasting a
token. One session image carrying both agents. Several adapters per session.
Per-thread agent settings that survive a respawn. Background work over the
adapters' async-task extension. The dialogs that start a box and a thread.

**Out of scope.** Handing one conversation from one harness to another.
Per-thread agent sets. Named credential profiles. A third harness, though
nothing here should make one hard.

**No compatibility.** Existing deployments may break. There is no import from
`.env`, and no migration of anything that was configured there. Say so in the
release notes.

## 2. Decisions already taken

Do not reopen these without a reason that is new.

| Decision | Why |
|---|---|
| The harness is a property of a thread, not a session | One box, one checkout, two agents on the same work is the point |
| One session image carries both agents | Splitting costs more disk for a two-harness deployment, and both CLIs in one box is useful |
| Codex threads default to `agent-full-access` | The container is the boundary already; `workspace-write` breaks the image's writable home |
| Codex forks start in `read-only` | Same intent as a Claude fork starting in `plan` |
| Credentials live in the database, managed from a settings page | No static form of a ChatGPT credential exists, so the orchestrator has to own and refresh it |
| Background work comes from the async-task extension, for both harnesses | Both adapters implement it identically |
| The process reading stays, reduced to one boolean | The reaper must answer when no adapter is running and not every thread is loaded |
| The session dialog absorbs the thread options; the thread dialog stays separate | A box has a name and an agent set; a thread has neither |

## 3. Verify first

Each of these is written against an assumption. Check them in a real box
before building on them. Steps 1 and 2 block the work; the rest shape it.

1. **Async tasks on both adapters.** Advertise the capability, run a
   backgrounded command in each harness, and confirm the spawn, the state
   update and the stop all arrive and work. Everything a person sees rests on
   this.
2. **The process table.** Run `ps -eo pid,ppid,etimes,args` inside a box with
   both adapters busy. Record the shape. The boolean floor is written against
   it.
3. **Codex's sandbox in the container.** Put a thread in `agent` mode and run a
   command. If landlock or seccomp fails under `ReadonlyRootfs` and
   `no-new-privileges`, then `agent` and `read-only` are broken entries in the
   mode picker rather than choices, and the settings UI has to say so.
4. **Replay.** Create a Codex thread, prompt it, stop the container, start it
   again, and confirm `session/load` brings the conversation back. Boxes
   depends on replay.
5. **Titles.** Watch for `session_info_update` from `codex-acp`. If it never
   sends one, Codex threads are named from their first prompt only, which is
   acceptable but should be known.
6. **Interception of `chatgpt.com`.** Only needed at milestone 5. Put the
   proxy in front of a ChatGPT-authenticated Codex and see whether Cloudflare
   accepts the handshake. It decides how a subscription credential reaches a
   box.

## 4. The harness model

### 4.1 The registry

New module `orchestrator/src/harness.ts`. One record per harness, and every
Claude-specific constant in the orchestrator moves into it:

```ts
interface Harness {
  id: 'claude' | 'codex';
  /** What the dashboard calls it. */
  label: string;
  /** argv for the adapter, spawned as a docker exec in the box. */
  cmd: readonly string[];
  /** Mode a fresh thread is put in, when the adapter offers it. */
  defaultModeId: string;
  /** Mode a fork starts in instead. */
  forkModeId: string;
  /** Config option values a fresh thread starts with, by option id. */
  defaultOptions: Readonly<Record<string, string>>;
  /** `_meta` sent with session/new, session/load and session/fork. */
  sessionMeta: unknown;
  /** Container environment this harness needs, by credential. */
  env: (credentials: CredentialView) => Record<string, string>;
  /** Which credential must be present before a thread can run. */
  credentialId: string;
  /** Where an agent set is installed, home-relative. */
  layout: AgentLayout;
  /** Tools that background their work whatever their input says. */
  alwaysBackground: ReadonlySet<string>;
}
```

Values for both harnesses are in Appendix A. Keep the registry a plain table
with no behaviour in it; behaviour that varies belongs behind a field.

### 4.2 Database

One migration, appended to `MIGRATIONS` in `orchestrator/src/db.ts`:

- `ALTER TABLE threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude'`
- `ALTER TABLE sessions DROP COLUMN agent_cmd` — the argv comes from the
  registry now.
- Replace `threads.mode_id` and `threads.model_id` with `threads.mode_id` and
  `threads.config` — see section 6.
- The credential tables — see section 5.

`ThreadRow` grows `harness` and `config`. `SessionRow` loses `agent_cmd`.

## 5. Credentials

### 5.1 What a credential is

A row, not a string. The store holds, per credential:

- `id` — `claude`, `openai`, `github`
- `method` — `token`, `api_key`, `oauth`
- `secret` — the material, as the harness needs it
- `expires_at`, `refreshed_at` — null for a static secret
- `account` — what to show in the UI, such as an email or a key's last four
  characters
- `status` — `ok`, `expired`, `failing`, and the last error

Git name and email sit beside them as plain settings. They are not secrets and
they only lived in `.env` because the credentials did.

Stored as-is in SQLite. This puts live logins on the data volume and therefore
in any backup of it. Say so in the README, and make the reverse proxy in front
of the dashboard a requirement rather than a suggestion.

`orchestrator/src/config.ts` keeps deployment settings only: ports, limits, the
allowlist, the data directory. Every `PROFILE_DEFAULT_*` entry goes, and so
does the `profiles` map. `CREDENTIAL_SET` stays — it describes which hosts and
headers a credential travels in, which is a fact about the service rather than
a preference — but its secrets now come from the store.

### 5.2 Delivery to a box

Unchanged in principle. The box gets a placeholder, the proxy swaps the real
value onto the wire, and the placeholder is per deployment so a credential can
change while boxes run without recreating a container. This already works and
nothing has used it yet.

Every box gets both harnesses' environment, each with its own placeholder,
because any thread in it may be either harness.

### 5.3 Logging in

For a pasted secret the settings page is a form. For an account it is a flow,
and the orchestrator does not speak OAuth. It runs the harness's own CLI in a
throwaway container from the session image:

1. Start a container with no workspace and no credentials.
2. Run `codex login --device-auth` or `claude setup-token` as an exec.
3. Stream the URL and the one-time code to the settings page.
4. On success, read the credential the CLI wrote — `~/.codex/auth.json` or the
   token on stdout — into the store.
5. Remove the container.

The hosts this needs are already `alsoAllow` entries in `CREDENTIAL_SET` and
are not intercepted.

An account credential needs a refresh loop beside the ones in
`orchestrator/src/index.ts`: refresh before expiry, write the result to the
store, push the new secret to the proxy. The orchestrator is the only holder
and the only refresher, which is what keeps rotation from invalidating anybody.

### 5.4 What gates what

`/healthz` stops reporting `claudeTokenConfigured` and reports which harnesses
can run. The thread dialog offers only those. A harness whose credential has
expired is offered and says why, rather than disappearing.

## 6. Per-thread settings

### 6.1 The problem being fixed

Threads store `mode_id` and `model_id`, and the model is found among the
adapter's config options by `category === 'model'`. Everything else the adapter
offers is forwarded and forgotten — so a thread's effort already resets at every
respawn.

### 6.2 The change

Replace `threads.model_id` with `threads.config`, a JSON map of config option
id to value. `threads.mode_id` stays, because ACP treats a mode as its own
concept.

- Write an entry whenever the answer changes: a `session/set_config_option`
  passing through the gateway, and a `config_option_update` arriving from the
  adapter.
- Replay the whole map after `session/new`, `session/load` and `session/fork`,
  exactly as mode and model are replayed now.
- A value the adapter rejects is logged, not fatal. The adapter's own update
  corrects the dashboard.

### 6.3 The catalogue

A dialog cannot ask the adapter what it offers, because no thread exists yet.
Cache it: whenever an adapter answers with `modes` or `configOptions`, store
that list against its harness. The dialog reads the cache.

The first thread of a harness on a fresh deployment has no cache. It shows the
agent choice alone and starts on the registry defaults. Do not start an adapter
to fill the cache.

Codex advertises reasoning efforts per model, so a model choice narrows the
effort list. Offer what was last seen and let the adapter correct it.

## 7. The gateway

`orchestrator/src/gateway/upstream.ts` is the bulk of this work. Today
`UpstreamSession` owns one connection. It becomes an owner of one connection
per harness, each spawned when a thread of that harness first needs it. A box
with only Claude threads never starts `codex-acp`.

Move onto the per-harness connection: the exec and its streams, the retry and
backoff, the cached `initialize` response, the live thread set, the replay on
respawn, and the teardown when an adapter exits. A failure in one connection
must not tear down the other.

Specific points:

- **Thread lookup keys on harness and id together.** Two adapters mint ids in
  one box. `threadByAcpId` takes the harness.
- **`initialize` is per connection.** It is passed through to browsers, and the
  two adapters advertise different things. Resolve it after the browser's
  thread is pinned, in `downstream.ts`, rather than at the session level.
- **`_meta` comes from the registry.** Only Claude gets
  `_meta.claudeCode.options.thinking`. Send it on `session/new`,
  `session/load` and `session/fork`, as now.
- **Client capabilities are no longer empty.** Advertise the async-task
  capability — see section 8. Nothing else.
- **Authentication.** If `session/new` fails with `auth_required`, surface a
  readable message rather than retrying the spawn three times.
- **Forks stay on their source's harness.** A transcript is only loadable by the
  adapter that wrote it.
- **Status.** A session is in error when the connection a thread needs cannot
  start, not when any connection fails.

Check `SESSION_PIDS_LIMIT` and `SESSION_MEM_LIMIT` against two adapters with
agents under each. They were sized for one.

## 8. Background work

### 8.1 What a person sees comes from the adapters

Both adapters implement the AIR async-task extension, identically, at the
versions pinned here. Use it for both.

- Advertise `asyncTasks` in `_meta.jetbrains.air.capabilities` at `initialize`.
- Translate `async_task_spawned` and `async_task_state_update` into the
  existing `BackgroundProcess` shape. Claude also sends `async_task_progress`;
  ignore it or use it, but do not require it.
- The stop button sends `_session/async_task/stop` with `{ sessionId,
  asyncTaskId }` instead of signalling a pid.
- Tasks are re-announced on `session/load`, so a respawn restores the bar for
  threads that are loaded.

This replaces the `--session-id=` parse and the `eval '…'` unwrapping in
`background.ts`, and with them a dependency on a command-line shape that can
change in any release.

### 8.2 The floor stays

The reaper's question is "is this box busy", and it must be answerable when no
adapter is running and when not every thread is loaded — Boxes only replays the
current thread and the ones browsers are watching. Events cannot answer it.

So `background.ts` keeps a reading of the box, reduced to one boolean: is
anything running under either adapter. It must know both adapter tokens;
left alone it silently mis-reads a Codex box, and an invisible build gets
suspended.

**The events decorate the reading. They never replace it.** A missed event
costs a name on a bar. A missed reading costs a build.

`startsBackgroundWork` in `background.ts` and the `_meta.claudeCode.toolName`
reads in `activity.ts` keep working for Codex through their `name` fallback.
Move the `ALWAYS_BACKGROUND` tool names into the registry.

## 9. Agent sets

A box may hold threads of both harnesses, so there is no per-box answer about
where an `AGENTS.md` goes. Install both layouts, always. The content is
kilobytes.

| Piece | Claude | Codex |
|---|---|---|
| `AGENTS.md` | `.claude/CLAUDE.md` | `.codex/AGENTS.md` |
| Skill | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| Command | `.claude/commands/<name>.md` | `.codex/prompts/<name>.md` |

Claude Code does not read `.agents/skills`, and Codex does not read
`.claude/skills`, so both copies are needed.

Changes:

- `agents.ts` writes both layouts into the materialized directory and lists
  every path in the manifest.
- **Manifest paths become home-relative**, because skills now land outside a
  single configuration directory. `entrypoint.sh` installs relative to `$HOME`
  rather than to `$CLAUDE_CONFIG_DIR`, and the record of what it installed
  moves from `~/.claude/.boxes-managed` to `~/.boxes/managed`. Keep the
  `safe_rel` check: it decides what gets deleted.
- The `playwright-cli` skill the entrypoint installs needs a copy in
  `~/.agents/skills` too. It installs into `~/.claude/skills` with
  `--global`; copy it across afterwards.
- Codex's custom prompts are deprecated upstream but still load. Write them
  while that is true.

## 10. The session image

- Install `@agentclientprotocol/codex-acp` pinned, beside the Claude pair.
- **Do not also install `@openai/codex` globally.** The adapter depends on it
  and npm nests a copy, which is 339 MB. Link the nested `codex` binary into
  `/usr/local/bin` and point `CODEX_PATH` at that link. One copy, both commands
  on `PATH`, and the CLI a person logs in with is the build the adapter drives.
- Extend the identity check that asserts `claude-agent-acp` resolves to
  `/usr/local/bin` to cover `codex-acp` and `codex`.
- The pins stay in the Dockerfile, for the reason the existing one does.

## 11. The dashboard

**New thread dialog.** Agent, mode, model, effort. Opens prefilled with the
last choice for that agent, stored in the database so it is the same on every
device. Offers only harnesses whose credential works.

**New session dialog.** Name and agent set, then the same block. A box is a
deliberate act, so the name stays required and no rename is needed.

**Fork** stays its own action, with no dialog. Same harness, same box.

**Settings page for credentials.** One entry per credential: its status, its
account, when it was last refreshed. Add by pasting, or by logging in — which
opens the device-code flow and shows the URL and the code. Secrets are
write-only: show the last four characters, never the value.

**Elsewhere.** A thread's harness shows on its row and in the thread header,
because it decides what the settings mean. `TokenWarning` becomes a per-harness
message driven by the store. `claudeTokenConfigured` goes from
`HealthResponse`.

## 12. Documentation

- `README.md`: setup without credentials in `.env`, the settings page, the
  harness choice, what a box can reach, and the warning that the data volume
  now holds credentials.
- `ARCHITECTURE.md`: a "Harnesses" section, and edits to "The ACP gateway",
  "What the agent is configured with", "Work left running in the background",
  "Network isolation", "Configuration and secrets" and "Build-time pins".
- `.env.example`: remove every credential; keep deployment settings.

## 13. Tests

- `harness.ts`: the registry, and that every harness supplies every field.
- `db.test.ts`: the migration, including a thread row that predates it.
- `agents.test.ts`: both layouts, the manifest, and that a removed item
  disappears from both.
- `config.test.ts` and `egress.test.ts`: the store as the source of secrets,
  and the OpenAI credential's hosts and headers.
- `upstream.test.ts`: two connections in one session, a thread routed to its
  own, a failure in one leaving the other up, and replay of the config map.
- `background.test.ts`: the async-task translation, the stop, and the reduced
  reading with two adapters present.
- `dashboard/e2e`: both dialogs, the settings page, and a thread showing its
  harness.
- `scripts/smoke-test.sh` and `scripts/live-test.sh`: a Codex thread beside a
  Claude one in the same box.

## 14. Milestones

Each one is shippable on its own.

1. **Credential store and settings page.** Claude and GitHub only, pasted
   secrets, no behaviour change beyond where the values come from. Worth doing
   even if Codex never ships.
2. **The harness model.** Registry, `threads.harness`, several adapters per
   session, the per-thread config map, the dialogs. Claude only, so the
   machinery is exercised before a second harness is added.
3. **Codex.** The image, the environment, the OpenAI credential, the defaults.
   A Codex thread runs on an API key entered in the settings page.
4. **Background work.** Async tasks for both harnesses, the reduced reading.
   Do not leave a long gap after milestone 3: until this lands, a Codex thread
   shows no background bar and cannot stop what it started.
5. **Subscription credentials.** Logging in from the settings page, the refresh
   loop, and whichever delivery the spike chose — the proxy swapping the token
   on `chatgpt.com`, or the orchestrator minting a short-lived `auth.json` into
   each box.

## 15. Carried assumptions

Confirm before building on them:

- Secrets are stored as-is in SQLite, with no encryption layer.
- One global set of credentials, not named profiles. `sessions.profile` exists
  and every session is `DEFAULT`; this plan leaves it alone.
- Logins run the harness's own CLI in a throwaway container rather than Boxes
  speaking OAuth.

## Appendix A: reference

Verified on 2026-09-12. Versions move; check before pinning.

**Packages**

| Package | Version | Notes |
|---|---|---|
| `@agentclientprotocol/codex-acp` | 1.11.0 | bin `codex-acp`, depends on `@openai/codex` |
| `@openai/codex` linux-x64 | 0.154.0 | 339 MB unpacked |
| `@agentclientprotocol/claude-agent-acp` | 0.75.1 pinned, 0.76.0 current | async tasks present at 0.75.1 |
| `@anthropic-ai/claude-code` linux-x64 | 2.1.269 | 220 MB unpacked |

**Codex environment**

`CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_PATH`,
`CODEX_HOME`, `CODEX_CONFIG`, `MODEL_PROVIDER`, `DEFAULT_AUTH_REQUEST`,
`INITIAL_AGENT_MODE`, `NO_BROWSER`, `APP_SERVER_LOGS`.

Set in a box: `CODEX_HOME=/home/agent/.codex`, `NO_BROWSER=1`,
`INITIAL_AGENT_MODE=agent-full-access`, and the credential. With an API key,
`DEFAULT_AUTH_REQUEST={"methodId":"api-key"}` lets the adapter authenticate
itself on the first `session/new`.

**Codex modes**

`read-only`, `agent`, `agent-full-access`. Also offered as a config option with
id `mode` and category `mode`.

**Codex config options**

| id | category |
|---|---|
| `model` | `model` |
| `reasoning_effort` | `thought_level` |
| `mode` | `mode` |

**Codex auth methods**

`api-key` (reads `CODEX_API_KEY` then `OPENAI_API_KEY`), `chat-gpt` (browser,
hidden by `NO_BROWSER`), `chat-gpt-device-code` (needs client URL elicitation),
`gateway` (needs the client to opt in).

**Codex paths**

`~/.codex/config.toml`, `~/.codex/AGENTS.md`, `~/.codex/prompts/*.md`,
`~/.codex/auth.json`, `~/.agents/skills/<name>/SKILL.md`, `/etc/codex/skills`.

**Endpoints**

| Host | Used for | Intercept |
|---|---|---|
| `api.openai.com` | API key traffic | yes, when an OpenAI key is configured |
| `chatgpt.com` | ChatGPT subscription traffic | no — see the spike |
| `auth.openai.com` | login and refresh | no |

The two endpoints take different credentials and reject each other's. Leaving
`chatgpt.com` unintercepted is what lets a deployment key and a box's own
ChatGPT login coexist.

**Async task extension**

Capability `asyncTasks` under `_meta.jetbrains.air.capabilities`, version 1.
Updates `async_task_spawned`, `async_task_state_update`, and from Claude also
`async_task_progress`. Stop request `_session/async_task/stop` with
`{ sessionId, asyncTaskId }`, answered with `{ stopped }`.

**`codex-acp` capabilities**: `loadSession: true`, `fork: {}`. It marks the
session's cwd as a trusted Codex project itself, so `/workspace` needs no
setup.

## Appendix B: touchpoints

| File | What changes |
|---|---|
| `orchestrator/src/harness.ts` | New. The registry |
| `orchestrator/src/credentials.ts` | New. The store and the refresh loop |
| `orchestrator/src/config.ts` | Credentials out; `CREDENTIAL_SET` reads the store |
| `orchestrator/src/db.ts` | Migration, `ThreadRow`, credential tables, config map helpers |
| `orchestrator/src/sessions.ts` | `AGENT_CMD` goes; `containerSpec` takes both harnesses' environment |
| `orchestrator/src/docker.ts` | `sessionEnv` per harness; check the pid and memory limits |
| `orchestrator/src/egress.ts` | Secrets from the store; push on change |
| `orchestrator/src/agents.ts` | Both layouts, home-relative manifest |
| `orchestrator/src/gateway/upstream.ts` | One connection per harness; the config map; capabilities |
| `orchestrator/src/gateway/downstream.ts` | `initialize` resolved after the pin |
| `orchestrator/src/gateway/background.ts` | Async tasks in; the reading reduced to a boolean |
| `orchestrator/src/gateway/activity.ts` | Tool names from the registry |
| `orchestrator/src/app.ts` | Credential routes, harness in create bodies, health |
| `shared/types.ts` | `harness` on threads, credential types, health |
| `session-image/Dockerfile` | `codex-acp`, the `codex` link, identity checks |
| `session-image/entrypoint.sh` | Install relative to `$HOME`; the skill copy |
| `dashboard/src/views/` | Both dialogs, the settings page |
| `proxy/src/policy.ts` | Nothing structural; the OpenAI credential is data |
