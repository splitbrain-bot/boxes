# Credentials

Credentials authenticate the services the processes in a box talk to. They are
entered on the settings page of the dashboard and stored in the orchestrator
database.

## How credentials reach the processes in a box

A real credential never enters a box container. The orchestrator places a
generated placeholder in the environment of each box, one per credential. The
[egress proxy](egress.md) intercepts the requests to the hosts a credential
belongs to and replaces the placeholder with the stored secret.

## The credentials

The settings page manages the credentials below. Each is either pasted or
obtained by an account login the orchestrator runs.

### Claude

Authenticates the Claude Code harness against `api.anthropic.com`. The
placeholder is set as `CLAUDE_CODE_OAUTH_TOKEN`. Two ways to set it up:

- **Log in**: the orchestrator runs `claude setup-token` in a throwaway
  container. You open the shown URL in a browser and paste the code it gives
  you back into the dashboard. This is the convenient path: the token it
  produces (`sk-ant-oat01-…`) is the only credential Claude Code accepts from
  this variable.
- **Paste a token**: enter the token `claude setup-token` printed on another
  machine. The result is the same as logging in.

Either way the token expires one year after it was created and cannot be
refreshed. The credential is then marked `expired`; log in or paste again.

Note: An Anthropic API key does not work here: the harness sends the variable
as an OAuth bearer token, not as an API key.

### OpenAI

Authenticates the Codex harness against `api.openai.com`. The placeholder is
set as `CODEX_API_KEY`.

- **Paste an API key** (`sk-…`): the only way to run Codex threads today.
- ~~**Log in** (subscription):~~ the orchestrator runs `codex login
  --device-auth` and stores the login. **This currently does not work**:
  The Codex harness does not support reading an API key from the environment,
  so the orchestrator cannot pass it to the harness.

### GitHub

A personal access token (`ghp_…`, paste only).
The placeholder is set as `GH_TOKEN`.

It authenticates git over HTTPS and the GitHub CLI (`gh`) in every box. The
box entrypoint configures git's credential helper from the placeholder; the
token travels to `github.com`, `api.github.com` and
`*.githubusercontent.com`.

### GitLab

A personal access token (`glpat-…`, paste only) with the `api` and
`write_repository` scopes. The placeholderis set as `GITLAB_TOKEN`.
The box entrypoint points git's credential helper for the
configured host at the GitLab CLI (`glab`).

The token travels to `gitlab.com` by default. Set the `GITLAB_HOST`
environment variable of the orchestrator to a bare hostname to use a
self-managed instance; the credential is then intercepted on that host
instead.

### Dev Tunnels

Authenticates the Microsoft Dev Tunnels service, which the `share-app`
[skill](skills.md) uses to publish a port that listens in a box. The
placeholder is set as `DEVTUNNELS_TOKEN`.

**Log in** is the only way to set it up: it runs GitHub's device flow for the
Dev Tunnels app. You open the shown URL and enter the one-time code. The
orchestrator stores the login under the GitHub account it belongs to and
refreshes it periodically.

## Statuses and refresh

The orchestrator keeps account logins valid: it checks them once a minute
and refreshes a login against its service before its access token expires.
A pasted token cannot be refreshed.

Each credential carries a status:

- **ok** — believed to work.
- **expired** — a token that cannot be renewed has passed its expiry. Log in
  or paste again.
- **failing** — the last use or refresh failed. The reason is stored with the
  credential and shown on the settings page. The credential is kept, and the
  next refresh retries it.

Removing a credential on the settings page deletes it from the database; the
proxy then stops intercepting its hosts.

## Git identity

The settings page also sets the identity git commits as. `GIT_NAME` and
`GIT_EMAIL` are placed in the environment of every box, and the box
entrypoint writes them to git's global configuration.
Both are settings, not credentials: they authenticate nothing.
