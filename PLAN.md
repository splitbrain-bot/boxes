# Plan: a second harness

Boxes drives Claude Code over ACP. This plan adds OpenAI Codex as a second
harness, and makes the changes that choice forces: credentials move out of the
environment into the database, a session holds one adapter per harness in use,
and background work comes from the adapters instead of from the process table.

Read `ARCHITECTURE.md` first. This plan names the places it changes and
assumes you know what they do.

This revision was checked against the codebase at `78ccc1a` and against the
published sources of both adapters and the Codex CLI on 2026-09-12. Where a
fact in the first draft turned out wrong, the section says what was found and
the correction is in place; Appendix C lists every change to the draft.
Anything still marked **unverified** has to be settled in a real box before the
step that rests on it is built.

## 1. Scope

**In scope.** A harness registry. A per-thread harness. A credential store with
a settings page, including logging in to an account rather than pasting a
token. One session image carrying both agents. Several adapters per session.
Per-thread agent settings that survive a respawn. Background work over the
adapters' async-task extension, with the process reading kept as a floor. The
dialogs that start a box and a thread.

**Out of scope.** Handing one conversation from one harness to another.
Per-thread agent sets. Named credential profiles. A third harness, though
nothing here should make one hard. Task notifications for Codex threads: the
`<task-notification>` rows a Claude thread shows are parsed out of Claude
Code's own prompt text (`shared/task-notifications.ts`), and Codex writes no
such block. A Codex thread shows none, and that is acceptable.

**No compatibility.** Existing deployments may break. There is no import from
`.env`, and no migration of anything that was configured there. Say so in the
release notes. Existing thread rows keep working: the migration carries a
stored model into the new config map, and a thread with nothing stored comes
back on the registry defaults exactly as it does today.

## 2. Decisions already taken

Do not reopen these without a reason that is new.

| Decision | Why |
|---|---|
| The harness is a property of a thread, not a session | One box, one checkout, two agents on the same work is the point |
| One session image carries both agents | Splitting costs more disk for a two-harness deployment, and both CLIs in one box is useful |
| Codex threads default to `agent-full-access` | The container is the boundary already. Verified: the two sandboxed modes run every command under bubblewrap, which needs unprivileged user namespaces that a container with `CapDrop: ALL` and Docker's default seccomp profile very likely refuses; and even where it works, `workspaceWrite` leaves `$HOME` read-only, which breaks the image's `~/.local` tool directory and every cache under it |
| Codex forks start in `read-only` | Same intent as a Claude fork starting in `plan`. Verified: `read-only` is not a read-only sandbox — it is Codex's `on-request` approval with a human reviewer, on the same `workspaceWrite` sandbox as `agent`. Every write still asks, which is what a fork wants |
| Credentials live in the database, managed from a settings page | No static form of a ChatGPT credential exists, so the orchestrator has to own and refresh it |
| Every box gets every harness's placeholder, always | A container's environment is fixed when it is created, and a credential entered after that has to reach it. Today a box created with no token gets no `CLAUDE_CODE_OAUTH_TOKEN` at all and never will — the "already works" in the draft only held for a box created after the credential was set |
| Logging in *inside* a box is no longer a supported path | Follows from the row above: with a placeholder in the environment, the CLI never falls back to its own login. The settings page is the way in, and `README.md` stops describing the other one |
| Background work comes from the async-task extension, for both harnesses | Both adapters implement it, with the same three update names and the same stop request |
| The process reading stays, reduced to one box-wide answer, and keeps a kill | The reaper must answer when no adapter is running and not every thread is loaded. Verified: neither adapter can name the work of a process that has died — Claude's replays nothing about tasks on `session/load`, and Codex's reconciles against a fresh app-server that owns none of the old terminals — so after any respawn the only thing that can find or stop an orphaned build is the process table |
| The session dialog absorbs the thread options; the thread dialog stays separate | A box has a name and an agent set; a thread has neither |
| The two adapters' session ids are UUIDs, and in-memory maps stay keyed by id alone | Verified for Claude (`randomUUID()` handed to the CLI as its transcript id) and true of Codex thread ids. The database lookup takes the harness as well, as hygiene, not because a collision is expected |

## 3. Verify first

Each of these is written against an assumption. Check them in a real box
before building on them. What the sources already settle is marked; what is
left is what only a running container can answer.

1. **Async tasks on both adapters.** Settled from source: both advertise
   `asyncTasks` under `_meta.jetbrains.air.capabilities` at `initialize`, both
   send `async_task_spawned` and `async_task_state_update`, both answer
   `_session/async_task/stop`. Still to run: advertise the capability, run a
   backgrounded command in each harness, and confirm the spawn, the terminal
   state and the stop all arrive and work end to end. Milestone 4 rests on it.
2. **The process table.** Run `ps -eo pid,ppid,etimes,args` inside a box with
   both adapters busy, with a command backgrounded under each, and again after
   the orchestrator has been restarted so both adapter execs are dead. Record
   the shape: what sits under `codex app-server` besides the shells it runs
   (a sandbox helper, an MCP server, anything long-lived), and where the
   orphaned shells end up. The floor in section 8.2 is written against it, and
   the per-harness `residentProcesses` list in the registry is filled from it.
3. **Codex's sandbox in the container.** Put a thread in `agent` mode and run
   a command that writes into `/workspace`. Settled from source: on Linux the
   `agent` and `read-only` modes run each command as `codex-linux-sandbox` →
   `bwrap --unshare-user --unshare-pid …` → `bash -lc`, and bubblewrap needs
   unprivileged user namespaces, which Docker's default seccomp profile and
   `CapDrop: ALL` are likely to refuse; Codex's own docs say to fall back to
   `danger-full-access` and treat the container as the boundary when that
   happens. Expect both modes to fail. If they do, they are shown in the mode
   picker as unavailable in this deployment, with that sentence, rather than
   offered. Blocks nothing; shapes the mode picker and the fork default: a
   fork whose `read-only` cannot run starts in `agent-full-access` instead,
   and the header says so.
4. **Codex traffic through the egress proxy.** **Blocks milestone 3.**
   Settled from source with one gap: the Codex binary uses reqwest's default
   proxy handling, so `HTTPS_PROXY` is honoured; it takes a custom CA from
   `CODEX_CA_CERTIFICATE`, falling back to `SSL_CERT_FILE`, both of which the
   box already points at the deployment CA (`docker.ts` sets `SSL_CERT_FILE`;
   add `CODEX_CA_CERTIFICATE` beside it). The gap is that the source builds
   with `native-tls` and `rustls` both, and whether the published Linux musl
   binary links the OpenSSL path that reads those variables could not be read
   from the package. Run one Codex turn through the proxy with the key
   configured and watch the proxy's log for the swap. If TLS fails, the
   fallback is `CODEX_CA_CERTIFICATE` not being read by that build, and the
   answer is an issue upstream rather than anything Boxes can do: the CA is
   per deployment and cannot go into the image.
5. **A placeholder as an API key.** Settled from source that the Codex
   app-server does *not* read `CODEX_API_KEY` from its environment for model
   calls — only `codex exec` and `codex mcp` do. What makes the key reach it
   is the adapter: with `DEFAULT_AUTH_REQUEST` naming `api-key`, `codex-acp`
   reads `CODEX_API_KEY` and calls `account/login {type: "apiKey"}`, which
   Codex persists to `$CODEX_HOME/auth.json` and uses from there. Confirm in
   the box that the login accepts the placeholder without validating it
   against OpenAI first, that the first turn carries it in `Authorization`
   where the proxy swaps it, and that the copy in `auth.json` — on the
   persistent home, and so surviving a stop — is the same placeholder on the
   next start. The placeholder is per deployment and never changes, so a
   stale copy is the right copy.
6. **Replay.** Create a Codex thread, prompt it, stop the container, start it
   again, and confirm `session/load` brings the conversation back. Settled from
   source that `codex-acp` streams every stored turn as `session/update`
   notifications on load; the box run confirms the rollout survives a stop.
7. **Titles.** Settled from source: `codex-acp` sends `session_info_update`
   with a title generated after the first turn (an ephemeral thread on
   `gpt-5.6-luna`), on `/rename`, and on load from the stored thread name or
   the first user message. Nothing to run.
8. **`claude setup-token` under a pseudo-terminal.** Needed at milestone 5.
   The command is an interactive Ink UI: it prints a URL, prompts `Paste code
   here if prompted >`, and prints the token after the code is entered. Run it
   as a `docker exec` with `Tty: true` in a throwaway container and confirm the
   URL, the prompt and the token can be read off the stream and the code
   written to it. There is no device-code flow and no non-interactive mode.
9. **`codex login --device-auth`.** Needed at milestone 5. Settled from
   source: it reads nothing from stdin, prints the URL
   `https://auth.openai.com/codex/device` and a one-time code to stdout with
   ANSI colour codes around them, polls for up to fifteen minutes, writes
   `auth.json`, prints `Successfully logged in` to stderr and exits 0; any
   failure exits 1 with the error on stderr. Device-code login has to be
   enabled in the ChatGPT account's security settings. What the box run
   confirms is the exact lines to parse, since the wording is not an API.
10. **Interception of `chatgpt.com`.** Only needed at milestone 5. Put the
    proxy in front of a ChatGPT-authenticated Codex and see whether Cloudflare
    accepts the handshake. Codex has open issues where its own Linux TLS
    fingerprint is challenged by Cloudflare on `chatgpt.com/backend-api`; a
    proxy re-originating TLS with Node's stack may fare better or worse. It
    decides how a subscription credential reaches a box.
11. **How long Codex lets a command run in the background.** Codex's
    `exec_command` tool yields after a timeout and leaves the process running
    as a session the model can poll, and the source carries a default
    background timeout of 300 seconds. If Codex kills a process at that mark,
    a two-hour build under Codex does not exist unless the agent detaches it
    itself, and the background bar on a Codex thread is a five-minute affair.
    Nothing in Boxes changes either way; the README should say what to expect.

## 4. The harness model

### 4.1 The registry

New module `orchestrator/src/harness.ts`. One record per harness, and every
Claude-specific constant in the orchestrator moves into it:

```ts
export type HarnessId = 'claude' | 'codex';

export interface Harness {
  id: HarnessId;
  /** What the dashboard calls it. */
  label: string;
  /** argv for the adapter, spawned as a docker exec in the box. */
  cmd: readonly string[];
  /**
   * The token the adapter's own process is recognised by in the box's
   * process table. `cmd[0]` for both, kept as its own field because the
   * reading and the spawn are different questions.
   */
  processToken: string;
  /**
   * Processes that sit under the adapter and are the harness itself rather
   * than work it is doing: the agent process and any long-lived helper.
   * Matched against the command line. Filled from verify step 2.
   */
  residentProcesses: readonly RegExp[];
  /** Mode a fresh thread is put in, when the adapter offers it. */
  defaultModeId: string;
  /** Mode a fork starts in instead. */
  forkModeId: string;
  /** Config option values a fresh thread starts with, by option id. */
  defaultConfig: Readonly<Record<string, string>>;
  /** `_meta` sent with session/new, session/load and session/fork, or undefined. */
  sessionMeta: Readonly<Record<string, unknown>> | undefined;
  /** Which credential must be present before a thread can run. */
  credentialId: CredentialId;
  /**
   * Container environment this harness needs. `placeholder` is what the box
   * holds in place of the credential; see section 5.2.
   */
  env: (placeholder: string) => Record<string, string>;
  /** Where an agent set is installed, home-relative. */
  layout: AgentLayout;
  /** Tools that background their work whatever their input says. */
  alwaysBackground: ReadonlySet<string>;
}

export interface AgentLayout {
  /** Home-relative path of the instructions file. */
  agentsMd: string;
  /** Home-relative directory a skill's `<name>/SKILL.md` goes under. */
  skills: string;
  /** Home-relative directory a command's `<name>.md` goes in. */
  commands: string;
}

export const HARNESSES: Readonly<Record<HarnessId, Harness>>;
export const HARNESS_IDS: readonly HarnessId[];
export function harness(id: string): Harness; // throws on an unknown id
```

Values for both harnesses are in Appendix A. Keep the registry a plain table
with no behaviour in it; behaviour that varies belongs behind a field.

What moves into it, and from where:

| Today | Where | Becomes |
|---|---|---|
| `AGENT_CMD` | `sessions.ts` | `cmd` |
| `DEFAULT_MODE_ID`, `FORK_MODE_ID`, `DEFAULT_MODEL_ID`, `THINKING_META` | `gateway/upstream.ts` | `defaultModeId`, `forkModeId`, `defaultConfig.model`, `sessionMeta` |
| `adapterToken()` reading `agent_cmd` | `gateway/upstream.ts` | `processToken` |
| `ALWAYS_BACKGROUND` | `gateway/background.ts` | `alwaysBackground` |
| `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` in `sessionEnv` | `docker.ts` | `env()` |
| `CLAUDE.md`, `skills/`, `commands/` in `materialize` | `agents.ts` | `layout` |

`pickModel` in `upstream.ts` — the `opus` → `opus[1m]` fallback — stays, applied
to the option whose `category` is `model` whatever its id. It is not
Claude-specific in shape, only in the value it is given.

### 4.2 Database

One migration, appended to `MIGRATIONS` in `orchestrator/src/db.ts`. SQLite
`DROP COLUMN` is already used by earlier migrations, so it is safe here.

```sql
-- Which agent a thread runs, and what it is configured with beyond its mode.
ALTER TABLE threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE threads ADD COLUMN config  TEXT NOT NULL DEFAULT '{}';
-- Both adapters call their model option `model`, so a stored model keeps
-- meaning what it meant.
UPDATE threads SET config = json_object('model', model_id) WHERE model_id IS NOT NULL;
ALTER TABLE threads DROP COLUMN model_id;

-- The argv comes from the registry now.
ALTER TABLE sessions DROP COLUMN agent_cmd;

-- Credentials, managed from the settings page. See section 5.1.
CREATE TABLE credentials (
  id           TEXT PRIMARY KEY,          -- 'claude' | 'openai' | 'github'
  method       TEXT NOT NULL,             -- 'token' | 'api_key' | 'oauth'
  secret       TEXT NOT NULL,             -- the material, as the harness needs it
  account      TEXT,                      -- what the UI shows: an email, a key's last four
  expires_at   INTEGER,                   -- null for a static secret
  refreshed_at INTEGER,                   -- null until refreshed
  status       TEXT NOT NULL DEFAULT 'ok',-- 'ok' | 'expired' | 'failing'
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Plain settings: git identity, and each dialog's last choice.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- What each adapter last advertised, for a dialog with no adapter to ask.
-- See section 6.3.
CREATE TABLE harness_catalog (
  harness        TEXT PRIMARY KEY,
  modes          TEXT NOT NULL,           -- JSON: the `modes` of the last answer
  config_options TEXT NOT NULL,           -- JSON: the `configOptions` of the last answer
  seen_at        INTEGER NOT NULL
);
```

`ThreadRow` grows `harness: HarnessId` and `config: string` (JSON) and loses
`model_id`. `SessionRow` loses `agent_cmd`. `insertThread` takes the harness
and the initial mode and config. `setThreadModel` becomes `setThreadConfig(db,
threadId, config: Record<string, string>)`, which replaces the whole map;
callers read, merge and write.

Settings keys: `git.name`, `git.email`, and `dialog.<harness>` holding the
JSON `{ modeId, config }` of the last thread dialog for that harness. Anything
else added later goes in the same table.

`sessions.profile` and `SessionSummary.profile` stay as they are, every row
`DEFAULT`. `create()` stops validating `body.profile` against a map that no
longer exists and stores `DEFAULT` whatever was sent.

## 5. Credentials

### 5.1 What a credential is

A row, not a string. New module `orchestrator/src/credentials.ts` owns the
table:

```ts
export type CredentialId = 'claude' | 'openai' | 'github';
export type CredentialMethod = 'token' | 'api_key' | 'oauth';
export type CredentialStatus = 'ok' | 'expired' | 'failing';

export class CredentialStore {
  constructor(db: Db, onChange: () => void);
  get(id: CredentialId): CredentialRow | undefined;
  list(): CredentialRow[];
  /** A pasted secret. Method and account are derived: see below. */
  put(id: CredentialId, method: CredentialMethod, secret: string, extra?: Partial<CredentialRow>): CredentialRow;
  remove(id: CredentialId): void;
  markStatus(id: CredentialId, status: CredentialStatus, error: string | null): void;
  /** Never the secret. What the API and the health probe report. */
  summarize(row: CredentialRow): CredentialSummary;
}
```

`onChange` is how the egress policy is recomposed and re-pushed the moment a
credential is written (section 5.2). The secret is stored as-is, and for an
`oauth` credential it is the whole JSON document the harness's CLI wrote, so
the refresh loop has the refresh token beside the access token.

The account shown for a pasted secret is its last four characters; a login
records the account name the CLI reports where it reports one.

Git name and email sit beside them in `settings`, with the defaults
`boxes-bot` and `boxes-bot@users.noreply.github.com` the environment gave them
until now. They are not secrets and they only lived in `.env` because the
credentials did.

Stored as-is in SQLite. This puts live logins on the data volume and therefore
in any backup of it. Say so in the README, and make the reverse proxy in front
of the dashboard a requirement rather than a suggestion.

`orchestrator/src/config.ts` keeps deployment settings only: ports, limits, the
allowlist, the data directory. Every `PROFILE_DEFAULT_*` entry goes, and so do
the `profiles` map, `SessionProfile`, `Config.egressCredentials` and
`ConfiguredCredential`. `compose.yaml` drops the two `environment`
pass-throughs and the comment explaining them. `CREDENTIAL_SET` stays — it
describes which hosts and headers a credential travels in, which is a fact
about the service rather than a preference — and gains the OpenAI entry
(Appendix A). Its secrets now come from the store.

### 5.2 Delivery to a box

Unchanged in mechanism: the box gets a placeholder, the proxy swaps the real
value onto the wire, and the placeholder is per deployment. Three changes make
it hold for a credential that arrives after the box was created:

- **Placeholders exist for every entry of `CREDENTIAL_SET`, always.**
  `resolveEgressMaterial` is passed the whole set rather than the configured
  subset, so a placeholder exists before its credential does. Every box gets
  every harness's environment with its placeholder in it, because any thread
  in it may be either harness. `EgressManager.sessionValue` becomes
  `placeholderFor(id)` and never returns a real value.
- **The CA is always pushed and always given to a box.** `composePolicy`
  today sends `ca: null` when no credential is configured, and `caCertificate()`
  then hands the box nothing to trust — so a box created before the first
  credential would fail TLS on every intercepted host afterwards. The policy
  carries the CA unconditionally; a host is still only intercepted while its
  credential is configured (`isInjectionHost` in the proxy is unchanged).
- **The policy is composed from the store, on every sync.** `composePolicy`
  takes the store's current rows rather than `cfg.egressCredentials`.
  `EgressManager.sync()` recomposes before it pushes, and the store's
  `onChange` calls `sync()` so a pasted credential is live within a second
  rather than at the next minute tick. The reconciler's tick stays as the
  retry.

A placeholder for a credential that is *not* configured leaves the box as a
bearer to an unintercepted host and is refused by the service. That is the
intended failure: the thread dialog does not offer the harness (section 5.4),
so a person only reaches it by talking to a thread whose credential was
removed after the fact.

`GH_TOKEN` is now always set, so `gh auth setup-git` in the entrypoint always
runs. A push with no GitHub credential configured gets a 401 from GitHub
rather than a prompt, which in a headless box is the same outcome said sooner.

### 5.3 Logging in

For a pasted secret the settings page is a form. For an account it is a flow,
and the orchestrator does not speak OAuth. It runs the harness's own CLI in a
throwaway container from the session image. New module
`orchestrator/src/login.ts`:

1. Create a container from `SESSION_IMAGE`, labelled `boxes.login=<id>`, with
   a tmpfs at `/home/agent` (the rootfs is read-only and the CLI has to write
   its state somewhere), no workspace bind, no `HTTP_PROXY`, no placeholder,
   on Docker's default bridge network. Its egress is not policed: it holds no
   deployment secret, lives for minutes, and the hosts it needs
   (`auth.openai.com`, `platform.claude.com`, `claude.ai`, `console.anthropic.com`)
   are the login's own.
2. Run the CLI as an exec and drive it:
   - **Codex:** `codex login --device-auth` with `CODEX_HOME` pointing into
     the tmpfs. Strip ANSI escapes from stdout, read the URL and the one-time
     code (verify step 9 for the exact lines). Wait for exit 0, then
     `cat $CODEX_HOME/auth.json` and store the whole document as method
     `oauth`, with `expires_at` read from the access token's `exp` claim and
     `account` from the id token's email claim.
   - **Claude:** `claude setup-token` under `Tty: true`. Read the URL after
     `Visit:`, wait for `Paste code here if prompted >`, write the code the
     settings page sends, read the `sk-ant-oat01-…` token off the stream.
     Store as method `token` with `expires_at` one year out. This token has
     no refresh token and cannot be refreshed: at expiry the credential goes
     `expired` and the page asks for a new login.
3. Remove the container. Every login container is labelled, and
   `sweepOrphans` removes any `boxes.login` container older than fifteen
   minutes, so a crash mid-flow leaves nothing behind.

The flow is a state machine the page polls:

```ts
type LoginState =
  | { state: 'starting' }
  | { state: 'awaiting_browser'; url: string; code: string | null }  // Codex shows the code here
  | { state: 'awaiting_code'; url: string }                          // Claude wants it pasted back
  | { state: 'done' }
  | { state: 'failed'; error: string };
```

One login at a time per credential; starting a second cancels the first. A
login that has not finished in ten minutes fails and the container goes.

**Refresh.** Only an `oauth` credential refreshes. A loop beside the ones in
`orchestrator/src/index.ts` runs every minute: a Codex `oauth` row whose
access token expires within the hour, or whose `last_refresh` is older than
eight days, is refreshed the way the Codex CLI does it — one POST to
`https://auth.openai.com/oauth/token` with `{ client_id, grant_type:
"refresh_token", refresh_token }`, the client id being Codex's public one
(Appendix A). The answer's tokens and a new `last_refresh` are written into
the stored document, which pushes it to the proxy. A refresh that fails marks
the row `failing` with the error, and the page shows it. The orchestrator is
the only holder and the only refresher, which is what keeps rotation from
invalidating anybody: a copy of the document handed to a box is never
refreshed there, so the box never rotates the token under the orchestrator.
The access token's lifetime is whatever its `exp` says; the source fixes no
number.

### 5.4 What gates what

`/healthz` stops reporting `claudeTokenConfigured` and reports which harnesses
can run:

```ts
export interface CredentialSummary {
  id: CredentialId;
  method: CredentialMethod;
  account: string | null;
  status: CredentialStatus;
  lastError: string | null;
  expiresAt: number | null;
  refreshedAt: number | null;
  updatedAt: number;
}

export interface HarnessHealth {
  id: HarnessId;
  label: string;
  /** Null when no credential is stored for this harness. */
  credential: CredentialSummary | null;
  /** True when a thread of this harness can run a turn right now. */
  runnable: boolean;
}

// on HealthResponse, replacing claudeTokenConfigured:
harnesses: HarnessHealth[];
credentials: CredentialSummary[];   // every stored credential, GitHub included
```

The thread dialog offers only runnable harnesses. A harness whose credential
has expired or is failing is offered greyed out and says why, rather than
disappearing. Nothing here is a hard gate on the API: `POST /threads` for a
harness with no credential still creates the thread, and its first turn fails
with a readable error (section 7). The dialog is what keeps a person from
getting there.

## 6. Per-thread settings

### 6.1 The problem being fixed

Threads store `mode_id` and `model_id`, and the model is found among the
adapter's config options by `category === 'model'`. Everything else the adapter
offers is forwarded and forgotten — so a thread's effort already resets at every
respawn.

### 6.2 The change

Replace `threads.model_id` with `threads.config`, a JSON map of config option
id to value. `threads.mode_id` stays, because ACP treats a mode as its own
concept — and because both adapters *also* echo the mode as a config option
with `category: 'mode'`. That option is excluded from the map on every path:
never written to `config`, never replayed from it. The mode travels through
`session/set_mode` and `mode_id` alone, as it does today. The dashboard already
hides it from the options list for the same reason.

- Write an entry whenever the answer changes: a `session/set_config_option`
  passing through the gateway, and a `config_option_update` arriving from the
  adapter. Both adapters answer `set_config_option` with the full
  `configOptions` list, and `codex-acp` sends `config_option_update` only
  after a slash command or an accepted plan changed something and never sends
  `current_mode_update` at all — so the answer to the request is the record
  that matters, and the notification is a bonus.
- Replay the whole map after `session/new`, `session/load` and `session/fork`,
  exactly as mode and model are replayed now: for each entry whose option the
  adapter offers and whose current value differs, one `set_config_option`.
  For the `model` category, a value the adapter no longer offers falls back to
  the registry default through `pickModel`, as today.
- A value the adapter rejects is logged, not fatal. The adapter's own answer
  corrects the dashboard.

### 6.3 The catalogue

A dialog cannot ask the adapter what it offers, because no thread exists yet.
Cache it: whenever an adapter answers `session/new`, `session/load` or
`session/fork` with `modes` or `configOptions`, store both against its harness
in `harness_catalog`. The dialog reads the cache through
`GET /api/harnesses`, which returns every registry entry with its catalogue
and its health.

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

Split the class in two. `UpstreamSession` keeps what is about the *session*:
the `Broadcast` of browsers, the `Activity` reading, the `BackgroundProbe`,
the pending permission store, thread resolution (`pin`, `resolveThread`,
`bringUp`, `mintInto`), the container start (`beforeStart`, `startContainer`,
`ensureProxyAttached`, done once and shared by every connection through one
`starting` promise), the tap into `acp_log`, and `stop`/`close`. New class
`AdapterConnection` in `orchestrator/src/gateway/adapter.ts`, one per harness
per session, holds what is about the *adapter process*:

- the exec and its streams, `makeStream`, the stderr logging;
- the spawn with its three attempts and backoff, and the cached `initialize`
  response;
- the `live` set of ACP ids this process holds, and the `replaying` counter
  (per connection, so a load on one harness does not mask live activity on
  the other);
- `loadSession`, `mintAcpThread`, `applyMode`, `applyConfig` (the renamed
  `applyModel`), each carrying the registry entry's `sessionMeta` and defaults;
- `handleExecExit` and `teardownConnection`, which tear down *this*
  connection's threads only: their turns are cleared, their tasks dropped,
  their browsers told, and the other connection is not touched.

Specific points:

- **Thread lookup keys on harness and id together.** `threadByAcpId(db,
  sessionId, harness, acpSessionId)`. The in-memory maps in `Broadcast`,
  `Activity` and `PendingStore` stay keyed by ACP id, which is a UUID from
  either adapter.
- **`initialize` is per connection.** It is passed through to browsers, and the
  two adapters advertise different things. `downstream.ts`'s `initialize`
  handler already runs after `attach` has started the pin; it awaits `pinned`
  and answers with the cached response of the pinned thread's harness. A
  browser sends `initialize` before `session/new`, so this costs it nothing
  it was not already waiting for.
- **`_meta` comes from the registry.** Only Claude gets
  `_meta.claudeCode.options.thinking`. Send it on `session/new`,
  `session/load` and `session/fork`, as now. Codex gets no `_meta`.
- **Client capabilities are no longer empty.** Advertise the async-task
  capability — see section 8 — as
  `clientCapabilities._meta.jetbrains.air = { version: 1, capabilities:
  ['asyncTasks'] }`. Nothing else: no fs, no terminal, no elicitation.
- **Authentication.** Codex's adapter checks authorization on `session/new`,
  `session/load`, `session/fork` and `session/list`, and with
  `DEFAULT_AUTH_REQUEST` set (Appendix A) logs itself in from the environment
  first. If it still fails, the error is JSON-RPC `-32000` with a message
  beginning `Authentication required`. Treat that as a configuration problem
  rather than a spawn failure: no retry, the session status stays as it was,
  the connection is kept up, the browser's request fails with the adapter's
  message, and the log says which credential is missing. Claude's adapter
  offers no auth method Boxes uses and fails inside the turn instead, with a
  401 from the API; that path is unchanged.
- **Forks stay on their source's harness.** A transcript is only loadable by
  the adapter that wrote it. `forkThread` reads the source row's harness and
  uses that connection; `CreateThreadBody.options` is ignored when `from` is
  set.
- **`canFork` is per thread.** Both adapters advertise `fork: {}`, but the
  answer comes from each connection's `initialize`. `ThreadSummary.canFork`
  replaces `SessionSummary.canFork`; the card's fork button reads it off the
  current thread.
- **Status.** A session is in error when the connection a thread needs cannot
  start after its three attempts, not when any connection fails. A connection
  that dies while the other runs logs, clears its own threads, and is
  respawned by the next message on one of them.
- **Replay of the config map** belongs to `applyConfig` and runs on every
  `loadSession` and `mintAcpThread`, after `applyMode`.

Check `SESSION_PIDS_LIMIT` and `SESSION_MEM_LIMIT` against two adapters with
agents under each. They were sized for one. `codex app-server` is a native
binary and should be light; measure rather than guess.

## 8. Background work

### 8.1 What a person sees comes from the adapters

Both adapters implement the AIR async-task extension identically at the
versions pinned here — the same capability name, the same update names, the
same stop request — so one translation serves both. There is no public
specification for it beyond the two adapters' sources and `codex-acp`'s
`docs/async-tasks.md`; Appendix A carries the exact shapes.

- Advertise `asyncTasks` at `initialize` (section 7).
- Translate `async_task_spawned` into a `BackgroundProcess` on the thread the
  notification's `sessionId` names, and drop it on an `async_task_state_update`
  whose `state` is `completed`, `failed` or `stopped`. `running` and `paused`
  keep it. Claude also sends `async_task_progress`; use its `description` if
  it carries one, and require nothing from it. Codex sends no progress and,
  as far as its source shows, no `running`: a task is spawned and then
  terminal.
- `BackgroundProcess` gains what the events know and loses what only the
  process table knew:

  ```ts
  export interface BackgroundProcess {
    /** The adapter's asyncTaskId, which is what a stop names. */
    id: string;
    /** `name` from the spawn: the command for a shell, a description otherwise. */
    command: string;
    /** `shell`, `workflow`, `monitor` or `task` from Claude; `shell` from Codex. */
    kind: string;
    /** `canStop` from the spawn. Both adapters send true today. */
    stoppable: boolean;
    /** When the spawn arrived, in epoch milliseconds. */
    startedAt: number;
  }
  ```

  The dashboard's `BackgroundBar` reads `command` and `id` and needs no change
  beyond the new fields being present.
- The stop button sends `_session/async_task/stop` with `{ sessionId,
  asyncTaskId }` on the thread's own connection, instead of signalling a pid.
  `POST /api/sessions/:id/threads/:threadId/background/stop` keeps its shape;
  `processId` in the body is now the task id. The adapter answers `{ stopped:
  boolean }`; `false` means the task was already over, and the thread state is
  re-sent so the bar catches up. Claude's adapter also emits an
  `agent_message_chunk` saying the task was stopped, which the thread shows as
  it shows any other line.
- Tasks live in memory on the connection that announced them, keyed by
  thread, and go with it: an adapter exit drops every task it announced and
  re-sends the thread states. Nothing re-announces them on the respawn. That
  is the case the floor exists for.

This replaces the `--session-id=` parse and the `eval '…'` unwrapping in
`background.ts`, and with them a dependency on a command-line shape that can
change in any release. `threadOfAgent`, `commandOf`, `processId` and
`workToStop` go.

The `_meta.jetbrains.air.asyncTasks.backgrounded: true` marker both adapters
put on the tool call's own update is what `startsBackgroundWork` reads first
from now on, before `rawInput.run_in_background` and the registry's
`alwaysBackground` names. Codex has no `run_in_background` and no
`_meta.claudeCode.toolName`; its shell calls are `kind: 'execute'` with a
`terminal` content block, and only the marker says one was backgrounded.

### 8.2 The floor stays

The reaper's question is "is this box busy", and it must be answerable when no
adapter is running and when not every thread is loaded — Boxes only replays the
current thread and the ones browsers are watching. Events cannot answer it:
verified from both adapters' sources, a respawned adapter knows nothing about
the shells the one before it left running.

So `background.ts` keeps a reading of the box, reduced to one answer about the
whole box rather than one per conversation:

```ts
export interface BoxReading {
  /** Whether anything is running that Boxes did not put there to hold the box open. */
  busy: boolean;
  /** The command lines of what is, for the log and for the stop below. */
  work: readonly string[];
}
export function readBox(processes: readonly ContainerProcess[], harnesses: readonly Harness[]): BoxReading;
```

Work is every process that is not *resident*. Resident is: PID 1 and the
entrypoint's `sleep infinity`; every adapter, found by the registry's
`processToken`; every adapter's direct children, which are the agent processes
(`claude`, `codex app-server`); anything matching a harness's
`residentProcesses`; and the `ps` that took the reading. Everything else —
shells under an agent, a build orphaned to PID 1 by a dead adapter, a
`!command` exec still running — is work and holds the box. The rule must
know both harnesses' tokens: left alone it silently mis-reads a Codex box, and
an invisible build gets suspended. Verify step 2 fills `residentProcesses`.

The shapes to expect, from the sources: under Claude, `claude-agent-acp` →
`claude` → `/bin/bash -c …`; under Codex in `agent-full-access`,
`codex-acp` → `codex app-server` → `bash -lc …`; under Codex's sandboxed
modes the shell sits three wrappers down (`codex-linux-sandbox` → `bwrap` →
`codex-linux-sandbox --apply-seccomp-then-exec` → `bash -lc …`), every one of
which is that command's own and correctly reads as work. An MCP server either
agent was asked to run would be a long-lived child of the agent and the one
thing this rule would misread; Boxes configures none, and `residentProcesses`
is where one would go.

**The events decorate the reading. They never replace it.** A missed event
costs a name on a bar. A missed reading costs a build.

**The kill stays, for what no task claims.** After a respawn the bars are
empty and the box is busy, and the only thing that can stop the orphaned
build is a signal. `POST /api/sessions/:id/background/stop` — session-level,
new — reads the box from inside (`containerProcessesFromInside`), TERMs every
pid the reading calls work, leaves first, and KILLs what is left two seconds
later, exactly as the per-thread stop does today. The session card offers it
as "Stop everything running in this box" only while the box is busy and no
thread of it has a task. `killInContainer`, `containerProcessesFromInside` and
the TERM-then-KILL escalation in `upstream.ts` are kept for this.

`startsBackgroundWork` in `background.ts` and the `_meta.claudeCode.toolName`
reads in `activity.ts` keep working for Codex through their `name` fallback and
the marker above. Move the `ALWAYS_BACKGROUND` tool names into the registry.

`Activity`'s end-of-cycle reading is the `usage_update` with a `cost` that
Claude's adapter sends. Codex's sends no such thing, so a Codex thread falls
to the `AGENT_QUIET_SECONDS` timer, which is the fallback that setting exists
for. Say so in its comment.

## 9. Agent sets

A box may hold threads of both harnesses, so there is no per-box answer about
where an `AGENTS.md` goes. Install both layouts, always. The content is
kilobytes.

| Piece | Claude | Codex |
|---|---|---|
| `AGENTS.md` | `.claude/CLAUDE.md` | `.codex/AGENTS.md` |
| Skill | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| Command | `.claude/commands/<name>.md` | `.codex/prompts/<name>.md` |

Verified: Claude Code reads skills from `~/.claude/skills` only. The
`.agents/skills` strings in its binary belong to an import feature that copies
other tools' skills into `.claude/skills`, and the adapter probes
`.agents/skills` only to render a link. Codex reads `~/.agents/skills` and not
`.claude/skills`. Both copies are needed.

Changes:

- `agents.ts` writes both layouts into the materialized directory, driven by
  each registry entry's `layout`, and lists every path in the manifest.
- **Manifest paths become home-relative**, because skills now land outside a
  single configuration directory. `entrypoint.sh` installs relative to `$HOME`
  rather than to `$CLAUDE_CONFIG_DIR`, and the record of what it installed
  moves from `~/.claude/.boxes-managed` to `~/.boxes/managed`.
- **Tighten `safe_rel`.** It decides what gets deleted, and its root is now
  the whole home. Besides the existing checks, a line is accepted only if it
  has at least two path components and starts with one of the layouts'
  prefixes: `.claude/CLAUDE.md`, `.claude/skills/`, `.claude/commands/`,
  `.codex/AGENTS.md`, `.codex/prompts/`, `.agents/skills/`. A manifest naming
  `.claude` or `.ssh` is refused rather than removed. The list is written into
  the entrypoint, not read from the manifest.
- **`~/.codex` has to exist before Codex starts.** The Codex CLI treats a
  `CODEX_HOME` that names a missing directory as an error rather than creating
  it. The entrypoint `mkdir -p`s it beside `~/.local/bin`.
- The `playwright-cli` skill the entrypoint installs needs a copy in
  `~/.agents/skills` too. It installs into `~/.claude/skills` with
  `--global`; copy it across afterwards. The manifest check that defers to a
  configured skill of that name looks for `.claude/skills/playwright-cli` now.
- Codex's custom prompts are deprecated upstream but still load. Write them
  while that is true; Appendix A says where that stands.

## 10. The session image

- Install `@openai/codex` pinned, globally, beside the Claude pair. Its npm
  package is a 13 KB launcher whose platform binary comes through an optional
  dependency (`@openai/codex-linux-x64`, 339 MB), so one global install is
  one copy.
- Install `@agentclientprotocol/codex-acp` pinned with `--omit=optional`. It
  depends on `@openai/codex` with a caret range and npm nests its own copy
  under the adapter; omitting optionals leaves that copy as the 13 KB
  launcher with no binary behind it, and `CODEX_PATH=/usr/local/bin/codex` in
  the image's `ENV` points the adapter at the global one instead. One binary,
  both commands on `PATH`, both versions pinned exactly rather than one of
  them following a range, and the CLI a person logs in with is the build the
  adapter drives. This replaces the draft's "link the nested binary", which
  would have left the CLI version to the range.
- Extend the identity check that asserts `claude-agent-acp` resolves to
  `/usr/local/bin` to cover `codex-acp` and `codex`, and assert
  `codex --version` prints the pinned version.
- The pins stay in the Dockerfile, for the reason the existing one does.
- `ENV CODEX_HOME=/home/agent/.codex` beside `CLAUDE_CONFIG_DIR`, so a shell in
  the box and the adapter agree.

## 11. The dashboard

**New thread dialog.** Agent, mode, model, effort — the mode from the
catalogue's `modes`, the rest from its `configOptions` minus the `mode`
category, rendered with the same `Setting` controls `ThreadHeader` uses.
Opens prefilled with the last choice for that agent from `settings`, so it is
the same on every device. Offers only harnesses whose credential works, and
shows the others greyed out with the reason. `SessionCard`'s "New thread"
opens it; a fresh deployment with no catalogue shows the agent choice alone.

**New session dialog.** Name and agent set, then the same block. A box is a
deliberate act, so the name stays required and no rename is needed. The
session's first thread is created with what the block says, in one request.

**Fork** stays its own action, with no dialog. Same harness, same box.

**Settings page** at `/settings`, linked from the shell beside the agent sets.
One entry per credential: its status, its account, when it was last refreshed
or entered. Add by pasting, or by logging in — which opens the device-code
flow and shows the URL and the code, or asks for the code back where the CLI
wants it pasted. Secrets are write-only: show the last four characters, never
the value. Git name and email are two fields on the same page.

**Elsewhere.** A thread's harness shows on its row and in the thread header,
because it decides what the settings mean. `TokenWarning` becomes a
per-harness message driven by `HealthResponse.harnesses`: one line per harness
that cannot run, naming the settings page. `claudeTokenConfigured` goes from
`HealthResponse` and from `stores/sessions.ts`. `SessionCard` shows "Stop
everything running in this box" under the conditions in section 8.2.

### 11.1 API

```
GET    /api/harnesses                          HarnessInfo[]   // registry + catalogue + health
GET    /api/credentials                        CredentialSummary[]
PUT    /api/credentials/:id                    { method, secret }  -> CredentialSummary
DELETE /api/credentials/:id                    204
POST   /api/credentials/:id/login              -> { loginId }
GET    /api/credentials/:id/login/:loginId     -> LoginState
POST   /api/credentials/:id/login/:loginId/code   { code }          // Claude's paste-back
DELETE /api/credentials/:id/login/:loginId     204                  // cancel
GET    /api/settings                           Settings
PATCH  /api/settings                           Partial<Settings> -> Settings
POST   /api/sessions/:id/background/stop       -> { stopped: number }
```

Bodies that change:

```ts
export interface ThreadOptions {
  harness: HarnessId;
  modeId?: string;                       // registry default when absent
  config?: Record<string, string>;       // registry defaultConfig when absent
}
export interface CreateThreadBody {
  from?: string;                         // fork: ThreadOptions ignored
  options?: ThreadOptions;
}
export interface CreateSessionBody {
  name: string;
  agentSet?: string | null;
  thread?: ThreadOptions;                // the first thread; Claude defaults when absent
}
export interface ThreadSummary { /* … */ harness: HarnessId; modeId: string | null; config: Record<string, string>; canFork: boolean; }
export interface Settings { gitName: string; gitEmail: string; dialogs: Partial<Record<HarnessId, { modeId?: string; config?: Record<string, string> }>>; }
export interface HarnessInfo extends HarnessHealth {
  defaultModeId: string;
  forkModeId: string;
  defaultConfig: Record<string, string>;
  /** What the adapter last advertised, or null on a deployment that has never run one. */
  catalog: { modes: SessionModeState | null; configOptions: SessionConfigOption[]; seenAt: number } | null;
}
```

`SessionModeState` and `SessionConfigOption` are the ACP shapes the gateway
already reads in `upstream.ts`; they move to `shared/types.ts` so the dialog
and the gateway agree on them.

## 12. Documentation

- `README.md`: setup without credentials in `.env`, the settings page, the
  harness choice, what a box can reach, the end of "log in inside a session",
  and the warning that the data volume now holds credentials.
- `ARCHITECTURE.md`: a "Harnesses" section, and edits to "The ACP gateway",
  "What the agent is configured with", "Work left running in the background",
  "Network isolation", "Configuration and secrets", "Build-time pins" and
  "Testing".
- `.env.example`: remove every credential and the paragraph about exporting
  them; keep deployment settings.
- `compose.yaml`: drop the two `environment` entries and their comment.

## 13. Tests

- `harness.test.ts`: the registry, and that every harness supplies every
  field, that `env()` names its placeholder, and that no two harnesses share a
  `layout` path.
- `db.test.ts`: the migration, including a thread row that predates it with a
  `model_id`, which comes out as `config = {"model": …}` on harness `claude`.
- `credentials.test.ts`: put, summarize (never the secret), status, and that
  `onChange` fires on every write.
- `login.test.ts`: the state machine over a fake exec for both flows, the
  timeout, and cancellation.
- `agents.test.ts`: both layouts, the manifest, and that a removed item
  disappears from both.
- `config.test.ts` and `egress.test.ts`: the store as the source of secrets,
  placeholders for every entry whether or not configured, the CA always
  present, a recompose on change, and the OpenAI credential's hosts and
  headers.
- `upstream.test.ts`: two connections in one session, a thread routed to its
  own, a failure in one leaving the other up, `initialize` answered per
  harness, an `auth_required` not retried, and replay of the config map with
  the `mode` category excluded.
- `background.test.ts`: the async-task translation and the stop; the box
  reading with two adapters present, with a shell under each, with an orphan
  under PID 1, and with only resident processes; the session-level kill.
- `docker.test.ts`: `sessionEnv` carrying both harnesses' environment and the
  CA unconditionally.
- `app.test.ts`: the new routes.
- `dashboard/e2e`: both dialogs, the settings page including a login flow
  against the stub, a thread showing its harness, the per-harness warning.
  The stub orchestrator gains the new endpoints and the new health shape.
- `scripts/smoke-test.sh` and `scripts/live-test.sh`: a Codex thread beside a
  Claude one in the same box. Both scripts, and `scripts/verify.sh`, read
  `PROFILE_DEFAULT_*` from the orchestrator's environment today; they seed the
  store through `PUT /api/credentials/:id` instead.

## 14. Milestones

Each one is shippable on its own.

1. **Credential store and settings page.** Claude and GitHub only, pasted
   secrets, git identity in settings, placeholders and the CA always
   delivered, the policy recomposed on change. No behaviour change beyond
   where the values come from and the end of in-box login. Worth doing even
   if Codex never ships.
2. **The harness model.** Registry, `threads.harness`, `AdapterConnection`,
   the per-thread config map, the catalogue, the dialogs. Claude only, so the
   machinery is exercised before a second harness is added.
3. **Codex.** The image, the environment, the OpenAI credential, the defaults,
   the mode picker's handling of the two sandboxed modes. A Codex thread runs
   on an API key entered in the settings page. Blocked on verify step 4 until
   the proxy is shown to carry Codex traffic, and shaped by steps 3 and 5.
4. **Background work.** Async tasks for both harnesses, the reduced reading,
   the session-level kill. Do not leave a long gap after milestone 3: until
   this lands, a Codex thread shows no background bar and cannot stop what it
   started.
5. **Subscription credentials.** Logging in from the settings page for both
   harnesses, the refresh loop for Codex, and whichever delivery the spike
   chose — the proxy swapping the token on `chatgpt.com`, or the orchestrator
   minting a short-lived `auth.json` into each box.

## 15. Carried assumptions

Confirm before building on them:

- Secrets are stored as-is in SQLite, with no encryption layer.
- One global set of credentials, not named profiles. `sessions.profile` exists
  and every session is `DEFAULT`; this plan leaves it alone.
- Logins run the harness's own CLI in a throwaway container rather than Boxes
  speaking OAuth, except for the Codex token refresh, which is one POST.
- A login container on Docker's default bridge is acceptable for the minutes
  it lives.

## Appendix A: reference

Verified on 2026-09-12 against the npm registry and the packages' published
sources. Versions move; check before pinning.

**Packages**

| Package | Version | Notes |
|---|---|---|
| `@agentclientprotocol/codex-acp` | 1.11.0 | bin `codex-acp`; 1.3 MB single bundle; depends on `@openai/codex ^0.153.4`, `@agentclientprotocol/sdk ^1.4.0` |
| `@openai/codex` | 0.154.0 | 13 KB launcher; the binary is the optional `@openai/codex-linux-x64`, 339 MB |
| `@agentclientprotocol/claude-agent-acp` | 0.76.0 current; 0.75.1 pinned today | async tasks since 0.71.0, `session_info_update` since 0.52.0, so the pin already suffices; bumping is a separate change |
| `@anthropic-ai/claude-code` | 2.1.269 | installer; the binary is `@anthropic-ai/claude-code-linux-x64`, 220 MB |
| `@agentclientprotocol/sdk` | 1.3.0 in the orchestrator | carries no async-task types; the gateway passes them through raw as it does everything else |

**Registry values**

| Field | Claude | Codex |
|---|---|---|
| `cmd` | `['claude-agent-acp']` | `['codex-acp']` |
| `processToken` | `claude-agent-acp` | `codex-acp` |
| `residentProcesses` | from verify step 2 | from verify step 2 |
| modes advertised | `default`, `acceptEdits`, `plan`, `auto`; `bypassPermissions` only when the adapter's `ALLOW_BYPASS` is set | `read-only` ("Ask for approval"), `agent` ("Approve for me", the adapter's own default), `agent-full-access` ("Full access") |
| `defaultModeId` | `auto` | `agent-full-access` |
| `forkModeId` | `plan` | `read-only` |
| config options (id → category) | `mode` → `mode`; `model` → `model` (sentinel value `default`); `effort` → `thought_level` (`default`, `low`, `medium`, `high`, `xhigh`, `max` as the model supports); `fast` → `model_config`, only when the model supports it | `mode` → `mode`; `model` → `model` (Codex model ids); `reasoning_effort` → `thought_level` (per model); `collaboration_mode` → `collaboration_mode` (`default`, `plan`); `fast-mode` → `model_config` |
| `defaultConfig` | `{ model: 'opus' }` | `{}` — the adapter's own default model |
| `sessionMeta` | `{ claudeCode: { options: { thinking: { type: 'enabled', budgetTokens: 10000, display: 'summarized' } } } }` | `undefined` |
| `credentialId` | `claude` | `openai` |
| `env(placeholder)` | `CLAUDE_CODE_OAUTH_TOKEN=<p>`, `CLAUDE_CONFIG_DIR=/home/agent/.claude` | `CODEX_API_KEY=<p>`, `CODEX_HOME=/home/agent/.codex`, `NO_BROWSER=1`, `INITIAL_AGENT_MODE=agent-full-access`, `DEFAULT_AUTH_REQUEST={"methodId":"api-key"}`, and `CODEX_CA_CERTIFICATE` set to the same path as `SSL_CERT_FILE` whenever the CA is delivered (that one belongs in `sessionEnv` beside the other CA variables rather than in the registry, since it is about the proxy, not the harness) |
| `layout` | `.claude/CLAUDE.md`, `.claude/skills`, `.claude/commands` | `.codex/AGENTS.md`, `.agents/skills`, `.codex/prompts` |
| `alwaysBackground` | `Monitor`, `Workflow` | none |

Codex's modes are approval policies on a sandbox, not sandboxes: `read-only`
is `on-request` approval with a human reviewer on the `workspaceWrite`
sandbox; `agent` is the same sandbox with Codex's own reviewer; only
`agent-full-access` is `never` on `dangerFullAccess`. The mode picker's labels
should say what each does rather than repeat the id. `workspaceWrite` makes
the cwd, `/tmp` and `$TMPDIR` writable and nothing else — not `$HOME`, and
`.git`, `.agents` and `.codex` stay read-only even under a writable root. On
Linux it is enforced by bubblewrap (`--unshare-user --unshare-pid`, seccomp,
`--cap-drop ALL`), which needs unprivileged user namespaces; Landlock is a
hidden legacy fallback. Codex's docs name containers that block namespaces as
a case for `danger-full-access`, with the container as the boundary.

**Codex environment, as `codex-acp` reads it** (everything else is passed
through to the `codex` process)

| Variable | Read by | Meaning |
|---|---|---|
| `CODEX_API_KEY`, then `OPENAI_API_KEY` | adapter | the key the `api-key` auth method uses when the request carries none |
| `CODEX_PATH` | adapter | path of the `codex` binary to spawn as `codex app-server`; default is the nested `@openai/codex` launcher |
| `CODEX_CONFIG` | adapter | JSON merged into every thread's config |
| `MODEL_PROVIDER` | adapter | provider name passed to `thread/start` |
| `DEFAULT_AUTH_REQUEST` | adapter | JSON `authenticate` request the adapter sends itself when a session call finds no account |
| `INITIAL_AGENT_MODE` | adapter | mode id every new session starts in; unknown values fall back to `agent` |
| `NO_BROWSER` | adapter | hides the browser-based `chat-gpt` auth method |
| `APP_SERVER_LOGS` | adapter | directory for a log of every JSON-RPC frame to and from Codex |
| `CODEX_HOME` | the `codex` binary | root of Codex state — config, `auth.json`, sessions, skills; default `~/.codex`; **must already exist** |
| `CODEX_CA_CERTIFICATE`, then `SSL_CERT_FILE` | the `codex` binary | PEM bundle to trust, applied to API calls, websockets and login |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | the `codex` binary | reqwest's default environment handling; honoured without configuration |

`CODEX_ACCESS_TOKEN`, named in the draft as an adapter variable, is only a
`codex login --with-access-token` input to the CLI and is not read by the
adapter or the app-server. The app-server reads `CODEX_API_KEY` from *no*
environment variable for model calls; only `codex exec` and `codex mcp` do.
The key reaches it through the adapter's `account/login`, which is why
`DEFAULT_AUTH_REQUEST` is set.

**Codex auth methods**, as `initialize` lists them: `api-key` always (reads
the two variables above); `chat-gpt` unless `NO_BROWSER`, which opens a
browser from inside the adapter's process; `chat-gpt-device-code` only when
the client advertises URL elicitation, which Boxes does not; `gateway` only
when the client opts in. An unauthenticated session call fails with JSON-RPC
error `-32000`, message `Authentication required…`.

**Codex paths.** `$CODEX_HOME/config.toml`; `$CODEX_HOME/AGENTS.override.md`
or `AGENTS.md` (first non-empty), then `AGENTS.md` in every directory from the
project root down to the cwd, concatenated under a 32 KiB cap;
`$CODEX_HOME/prompts/*.md` (deprecated in favour of skills, still loaded as
slash commands, no version given for their removal); `$CODEX_HOME/auth.json`;
skills from `~/.agents/skills/<name>/SKILL.md`, `<repo>/.agents/skills` up the
tree, `<repo>/.codex/skills`, `$CODEX_HOME/skills` (deprecated) and
`/etc/codex/skills`. The adapter marks the session's cwd trusted in the
per-thread config it sends (`projects.<cwd>.trust_level = "trusted"`), not in
`config.toml`, so `/workspace` needs no setup. The API-key login persists the
key through Codex into `auth.json`. Codex's documentation has moved from
`developers.openai.com/codex` to `learn.chatgpt.com/docs`; cite the latter.

**Codex background commands.** The model's `exec_command` runs in a PTY and
yields after `yield_time_ms` (250 ms to 30 s); a process still running then
persists as a session the model polls, which is what the adapter surfaces as
an async task through `thread/backgroundTerminals/list`. There is no
`run_in_background` flag. The source carries a default background timeout of
300 seconds; verify step 11 says what that means for a long build.

**Codex CLI facts still to settle from the box** are listed in section 3:
whether the published musl binary reads the CA variables (step 4), the exact
lines `--device-auth` prints (step 9), bubblewrap under the container's
security options (step 3), the background timeout (step 11).

**`codex-acp` capabilities.** `loadSession: true`; `sessionCapabilities`
`resume`, `list`, `close`, `delete`, `fork: {}`, `additionalDirectories`,
`subagents`; `mcpCapabilities.http: true`. `session/fork` calls Codex
`thread/fork` with `excludeTurns: true` and replays nothing, which is the
shape Boxes' inherited replay already covers. `session/load` streams every
stored turn as `session/update`s.

**Endpoints**

| Host | Used for | Intercept |
|---|---|---|
| `api.openai.com` | API key traffic: `/v1/responses` | yes, when an OpenAI key is configured |
| `chatgpt.com` | ChatGPT subscription traffic: `/backend-api/codex/responses`, `/backend-api/codex/models`, usage and files under `/backend-api/` | no — see verify step 10 |
| `auth.openai.com` | login (`/api/accounts/deviceauth/*`, `/codex/device`) and refresh (`/oauth/token`) | no |
| `files.openai.com` | attachments the model uploads | no |
| `ab.chatgpt.com` | Codex's own telemetry, OTLP metrics, on by default in release builds | no; under an allowlist the proxy refuses it and Codex carries on, so expect the denial in the proxy's counters |

The two inference endpoints take different credentials and reject each
other's. Leaving `chatgpt.com` unintercepted is what lets a deployment key and
a subscription credential coexist. With an `EGRESS_ALLOWED_HOSTS` set, the
OpenAI credential's `alsoAllow` has to carry `auth.openai.com` and
`chatgpt.com`; `files.openai.com` and `ab.chatgpt.com` are a deployment's own
choice.

OpenAI's entry in `CREDENTIAL_SET`:

```ts
{
  id: 'openai',
  hosts: ['api.openai.com'],
  headers: ['authorization'],
  alsoAllow: ['auth.openai.com', 'chatgpt.com'],
  placeholderPrefix: 'sk-',
}
```

**Async task extension**, identical in both adapters at the pinned versions

Client advertises: `clientCapabilities._meta.jetbrains.air = { version: 1,
capabilities: ['asyncTasks'] }`. The adapter requires `version` to be an
integer of at least 1 and the name to be in the array; without it, no task
update is ever sent. Both adapters list `asyncTasks` in their own top-level
`_meta.jetbrains.air.capabilities` on the `initialize` response.

Updates, as `session/update` with `sessionId` naming the thread:

```ts
{ sessionUpdate: 'async_task_spawned', asyncTaskId, name, taskType, description?,
  showInTranscript: boolean, canStop: boolean, outputFilePath?, toolCallId? }
{ sessionUpdate: 'async_task_state_update', asyncTaskId,
  state: 'running' | 'paused' | 'completed' | 'failed' | 'stopped', summary?, outputFilePath?, toolCallId? }
{ sessionUpdate: 'async_task_progress', asyncTaskId, description?, summary?, lastToolName?, usage?, outputFilePath?, toolCallId? }  // Claude only
```

Claude's `taskType` is `shell` for a backgrounded Bash (with `name` and
`description` both the command), `workflow`, `monitor`, or `task`; subagents
go through a different extension and never appear here. Codex's is always
`shell`, `name` is the command with its `bash -lc` prefix stripped, and
`asyncTaskId` is the Codex command item id (`<childThreadId>:<itemId>` for a
subagent's command). Codex sends only the terminal states.

Both mark the tool call itself: a `tool_call_update` for the call's
`toolCallId` carrying `_meta.jetbrains.air.asyncTasks.backgrounded: true`.

Stop: request `_session/async_task/stop` with `{ sessionId, asyncTaskId }`,
answered `{ stopped: boolean }`. Claude also emits an `agent_message_chunk`
`**Task stopped by user:** <name>.`; Codex answers `true` only after Codex has
confirmed the terminal is gone.

Neither adapter re-announces tasks for a process that has died. Codex's
adapter reconciles against `thread/backgroundTerminals/list` on load, which
answers for the *new* app-server; Claude's `replaySessionHistory` mentions
tasks nowhere.

**Claude tool-call metadata.** Every `tool_call` and `tool_call_update`
carries `_meta.claudeCode.toolName`; a backgrounded Bash completes its own
call with the text `Command running in background with ID: …` and then the
marker above. Codex carries no tool name; a shell call is `kind: 'execute'`
with a `{ type: 'terminal' }` content block and `_meta.terminal_info`.

**Claude login.** `claude setup-token` prints a one-year token prefixed
`sk-ant-oat01-` and saves nothing; it is an interactive flow that opens or
prints a URL and prompts `Paste code here if prompted >`. It requires a TTY.
There is no refresh token, so the credential cannot self-heal. Credential
precedence in the CLI puts `CLAUDE_CODE_OAUTH_TOKEN` ahead of its own stored
login, which is why a placeholder in the environment ends in-box login.

**Codex login and refresh.** `auth.json` under `CODEX_HOME` is
`{ auth_mode?, OPENAI_API_KEY: string | null, tokens: { id_token,
access_token, refresh_token, account_id }, last_refresh: RFC3339 }` plus
optional fields Boxes ignores (`codex-rs/login/src/auth/storage.rs`);
`account_id` comes from the id token's `https://api.openai.com/auth.chatgpt_account_id`
claim. Codex refreshes when the access token's `exp` is within five minutes or
`last_refresh` is more than eight days old: `POST https://auth.openai.com/oauth/token`
with JSON `{ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type:
"refresh_token", refresh_token }`; revocation is `/oauth/revoke`. Neither the
client id nor the endpoint is a stable API; both are read from
`codex-rs/login/src/auth/manager.rs` and should be re-read at milestone 5.
`codex login status` prints `Logged in using ChatGPT`, `Logged in using an API
key - sk-…***…` or `Not logged in` (exit 1), all on stderr. `codex login
--device-auth` is described in verify step 9.

## Appendix B: touchpoints

| File | What changes |
|---|---|
| `orchestrator/src/harness.ts` | New. The registry |
| `orchestrator/src/credentials.ts` | New. The store and the refresh loop |
| `orchestrator/src/login.ts` | New. The throwaway-container login flows and their state machine |
| `orchestrator/src/settings.ts` | New. Git identity and dialog defaults over the `settings` table |
| `orchestrator/src/config.ts` | Credentials and profiles out; `CREDENTIAL_SET` gains OpenAI |
| `orchestrator/src/db.ts` | Migration, `ThreadRow`, the three new tables, config map helpers, `threadByAcpId` with harness |
| `orchestrator/src/sessions.ts` | `AGENT_CMD` and `profileFor` go; `containerSpec` builds the env from every harness; `createThread` takes options; the session-level kill; login containers in `sweepOrphans` |
| `orchestrator/src/docker.ts` | `SessionEgress`/`SessionProfile` replaced by an env map; CA always, with `CODEX_CA_CERTIFICATE` beside the four CA variables; `Tty: true` exec for the Claude login; login containers on the default bridge with a tmpfs home |
| `orchestrator/src/egress.ts` | Placeholders for the whole set; policy from the store; recompose on sync; `placeholderFor` |
| `orchestrator/src/agents.ts` | Both layouts, home-relative manifest |
| `orchestrator/src/gateway/upstream.ts` | Session-level state only; owns the connections; thread resolution across them |
| `orchestrator/src/gateway/adapter.ts` | New. One adapter process: spawn, initialize, load, mint, config replay, tasks, teardown |
| `orchestrator/src/gateway/downstream.ts` | `initialize` resolved after the pin |
| `orchestrator/src/gateway/background.ts` | Async tasks in; the reading reduced to the box; the kill kept for unclaimed work |
| `orchestrator/src/gateway/activity.ts` | Tool names from the registry; the marker read |
| `orchestrator/src/app.ts` | Harness, credential, login and settings routes; options in create bodies; health |
| `orchestrator/src/index.ts` | The refresh loop |
| `orchestrator/src/reaper.ts` | Nothing structural; `backgroundActive` reads the box |
| `shared/types.ts` | `harness` and `config` on threads, `ThreadOptions`, credential and login types, health, `BackgroundProcess` |
| `session-image/Dockerfile` | `@openai/codex` and `codex-acp` pinned, `CODEX_PATH`, `CODEX_HOME`, identity checks |
| `session-image/entrypoint.sh` | Install relative to `$HOME`; the tightened `safe_rel`; `~/.codex`; the skill copy |
| `compose.yaml`, `.env.example` | Credentials out |
| `dashboard/src/views/Settings.tsx` | New. Credentials and git identity |
| `dashboard/src/components/ThreadOptions.tsx` | New. The agent/mode/model/effort block both dialogs use |
| `dashboard/src/views/SessionCreate.tsx`, `components/SessionCard.tsx`, `components/ThreadHeader.tsx`, `components/TokenWarning.tsx`, `stores/sessions.ts`, `api.ts` | The dialogs, the harness on rows and headers, the per-harness warning, the new calls |
| `dashboard/e2e/stub-orchestrator.ts` | The new endpoints and health shape |
| `proxy/src/policy.ts` | Nothing structural; the OpenAI credential is data |

## Appendix C: what this revision changed in the draft

Findings against the code:

- The draft's "delivery already works" held only for a box created after a
  credential was set: `sessionValue` returns `''` for an unconfigured
  credential and `composePolicy` sends no CA until one is configured. Section
  5.2 now makes placeholders and the CA unconditional, and section 2 records
  that this ends logging in inside a box.
- `sessions.profile`, `create()`'s profile validation, `SessionProfile`,
  `Config.profiles`, `ConfiguredCredential` and the compose pass-throughs were
  not named; they are now.
- Both adapters echo the mode as a config option with `category: 'mode'`;
  section 6.2 excludes it from the config map, or a thread would be put in
  its mode twice by two mechanisms.
- `canFork` was session-level and comes from a per-connection `initialize`;
  it moves to the thread.
- `safe_rel`'s root becomes the whole home; section 9 tightens it to the
  layouts' prefixes.
- `Activity`'s end-of-cycle signal is Claude's; noted for Codex.
- Test scripts read the credentials from the orchestrator's environment and
  need to seed the store instead.
- The migration, the settings storage the dialogs need, the catalogue table,
  the credential type, the health shape, the API and the request bodies are
  written out, since the draft left each to be inferred.

Findings against the sources:

- Neither adapter re-announces the tasks of a dead process on `session/load`.
  The draft said both did. The floor therefore keeps a kill for work no task
  claims (section 8.2), session-level rather than per thread.
- Codex's `read-only` mode is a human-approval policy on a writable sandbox,
  not a read-only sandbox. The fork decision stands; its rationale is
  corrected.
- `CODEX_ACCESS_TOKEN` is a `codex login` input, not an adapter variable, and
  is dropped from the environment. `CODEX_HOME` is read by the `codex`
  binary, not the adapter, and the directory must exist. `codex-acp` sends no
  `current_mode_update`, and `config_option_update` only in two cases.
- Claude Code does not read `~/.agents/skills`; the two-copy layout is
  confirmed necessary.
- `claude setup-token` is an interactive TTY flow with a pasted-back code and
  a one-year, non-refreshable token; section 5.3 designs the login around
  that.
- `@openai/codex` on npm is a launcher with the binary in an optional
  platform package; section 10 pins both packages exactly rather than linking
  the nested copy and leaving the CLI to a caret range.
- The `auth_required` error is JSON-RPC `-32000` with a `Authentication
  required` message; section 7 matches on both.
- `@agentclientprotocol/claude-agent-acp` moved to 0.76.0 and
  `@agentclientprotocol/codex-acp` to 1.11.0 with `@openai/codex` 0.154.0;
  Appendix A carries the numbers and what each depends on.
- The Codex CLI honours `HTTPS_PROXY` through reqwest's defaults and reads a
  custom CA from `CODEX_CA_CERTIFICATE` or `SSL_CERT_FILE`; whether the
  published musl binary links the TLS backend that applies them is the one
  open point, so verify step 4 stays and blocks milestone 3.
- Codex's Linux sandbox is bubblewrap with seccomp, not Landlock, and needs
  user namespaces a hardened container is likely to refuse; `workspaceWrite`
  leaves `$HOME` read-only. The `agent-full-access` default is confirmed for
  a second reason, and verify step 3 now says what to expect.
- The Codex app-server reads no API key from its environment; the adapter's
  `account/login` is what carries it into `auth.json`. Verify step 5 is
  rewritten around that.
- `codex login --device-auth` is non-interactive with a known URL and exit
  code; `auth.json`'s shape, the refresh endpoint, the client id and the
  refresh cadence are read from the Codex source and written into section
  5.3 and Appendix A, replacing "read them out of the source at milestone 5".
- Codex's `exec_command` has no background flag and a 300-second default
  background timeout; verify step 11 asks what that does to a long build.
- Codex's telemetry host and its attachments host are added to the endpoint
  table so an allowlisted deployment is not surprised by the denials.

## Appendix D: found while building

Three things the plan did not know, recorded where the next reader will look.

- **The ACP SDK eats an update it does not know.** `@agentclientprotocol/sdk`
  1.3.0's client installs a session-update router ahead of every handler an app
  registers, and that router parses each `session/update` against the schema it
  was generated from and throws on a `sessionUpdate` outside it. A handler that
  throws takes the whole message with it, so a raw parser never sees the frame,
  and every async-task notification was logged as invalid params and dropped.
  The connection therefore lifts those lines off the adapter's stdout before
  the SDK parses them and delivers them by the path the SDK would have used —
  `siftExtensions` in `gateway/adapter.ts`. Section 8.1's "the gateway passes
  them through raw as it does everything else" is not enough on its own.
- **`processToken` alone misclassifies the agent as an adapter.**
  `claude-agent-acp` is on the *agent's* command line too, because the CLI the
  adapter spawns lives inside the adapter package's own `node_modules`. The
  rule in section 8.2 would have read an agent as an adapter and everything
  under it as an agent, which is work made invisible. `readBox` counts a
  token-carrying process as an adapter only when no harness's
  `residentProcesses` pattern matches it and nothing above it carries a token
  either; either test alone is enough.
- **None of section 3's box runs could be made.** No Docker daemon was
  available in the sessions that built this, so verify steps 1 to 11 are all
  still open. Step 4 blocks nothing that has been written but has to be settled
  before a Codex thread's egress is relied on; steps 2, 3, 5 and 11 shape
  values and copy that are in place on the sources alone; steps 8 and 9 shape
  the login flows, which parse for shapes rather than for wording so that a
  surprise is recoverable by hand. Every path that rests on one carries a
  comment naming the step.
