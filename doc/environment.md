# Environment variables

Boxes is started via Docker Compose. The orchestrator reads its configuration from environment variables. All
variables have sensible defaults, so you only need to set the ones you want to change.

By default, the distributed compose file will read a `.env` file in the repository root - you can override this
by setting the `BOXES_ENV` variable in your shell before running `docker compose`. 

Note that credentials are not environment variables, they are set in the dashboard and stored in the orchestrator
database.

## Compose variables

These variables are read by Docker Compose, not by the orchestrator.

| Variable | Default | Description                                                                                                                             |
| --- | --- |-----------------------------------------------------------------------------------------------------------------------------------------|
| `BOXES_ENV` | `.env` | Path to the optional environment file loaded into the orchestrator container. This must be set in the shell that runs `docker compose`. |
| `BIND_ADDR` | `127.0.0.1` | Host address on which Compose publishes the Boxes HTTP port.                                                                            |
| `HOST_PORT` | `3000` | Host port on which Compose publishes the orchestrator's port.                                                                   |

## Orchestrator variables

These variables are read by the orchestrator container.

| Variable | Default | Accepted value | Description |
| --- | --- | --- | --- |
| `DATA_DIR` | `/data` | Non-empty path | Directory for the database, generated keys, and box workspaces. |
| `HOST_DATA_DIR` | empty | Path | Host-side path corresponding to `DATA_DIR`. Usually leave this unset so Boxes discovers the Docker volume mount. Set it for rootless or nested Docker, or when `/data` is a host bind mount. |
| `PORT` | `3000` | Positive integer | Port on which the orchestrator listens inside its container. The shipped Compose file publishes port 3000, so changing this also requires a matching Compose change. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` | Lowest severity written to standard error. `debug` logs every forwarded ACP message. |
| `BOX_IMAGE` | `ghcr.io/splitbrain/boxes/box:latest` | Non-empty image reference | Image used to create boxes. |
| `BOX_UID` | `1020` | Positive integer | User ID used inside boxes and for workspace files. A custom box image must be built with the matching `AGENT_UID` build argument. |
| `BOX_GID` | `1020` | Positive integer | Group ID used inside boxes and for workspace files. A custom box image must be built with the matching `AGENT_GID` build argument. |
| `BOX_IMAGE_PULL_MINUTES` | `60` | Non-negative integer | How often Boxes refreshes the box image. `0` disables scheduled and startup refreshes, but a missing image is still pulled. |
| `BOX_IMAGE_PRUNE` | `true` | `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off` | Removes superseded copies of the box image after refreshes. |
| `BOX_SUBNET_POOL` | `10.200.0.0/16` | IPv4 CIDR | Address pool from which Boxes allocates each box's private network. |
| `BOX_MEM_LIMIT` | `4g` | Positive integer, optionally ending in `k`, `m`, or `g` | Memory limit for each box container. |
| `BOX_CPUS` | `2` | Positive number | CPU limit for each box container. |
| `BOX_PIDS_LIMIT` | `512` | Positive integer | Process limit for each box container. |
| `IDLE_STOP_MINUTES` | `30` | Positive integer | Idle time before Boxes stops a box. |
| `BACKGROUND_POLL_SECONDS` | `20` | Positive integer | Interval for checking work that continues in the background. |
| `AGENT_QUIET_SECONDS` | `3` | Positive integer | Silence period after which a thread counts as stopped when its adapter does not report completion. |
| `AGENT_SETTLE_SECONDS` | `30` | Positive integer | Silence period before Boxes sends a completion push notification. |
| `MAX_ATTACHMENT_MB` | `25` | Positive integer | Largest file attachment accepted with one prompt, in MiB. |
| `PERMISSION_FALLBACK` | `hold` | `hold` or `deny` | Action for a permission request that reaches its hold timeout. |
| `PERMISSION_HOLD_MINUTES` | `120` | Positive integer | Time before `PERMISSION_FALLBACK` applies. |
| `PUSH_SUBJECT` | `https://github.com/splitbrain/boxes` | `mailto:` or `https:` URL | Contact URI included in Web Push VAPID assertions. |
| `EGRESS_PROXY_CONTAINER` | `boxes-egress-proxy` | Non-empty container name | Name of the egress proxy container. Change this only when the proxy container is renamed too. |
| `EGRESS_PROXY_ALIAS` | `proxy` | Non-empty hostname | Name boxes use for the egress proxy on their private networks. |
| `EGRESS_PROXY_PORT` | `3128` | Positive integer | Egress proxy port used by boxes. Changing it requires matching proxy container configuration. |
| `EGRESS_CONTROL_PORT` | `3129` | Positive integer | Egress proxy control port used by the orchestrator. Changing it requires matching proxy container configuration. |
| `EGRESS_ALLOWED_HOSTS` | empty | Comma- or whitespace-separated hostnames | Optional egress allowlist. Exact hostnames and one-label wildcards such as `*.example.com` are accepted. Leave empty to allow all public hosts. Private ranges remain blocked. A bare `*` is invalid. |
| `GITLAB_HOST` | `gitlab.com` | Bare hostname with at least two labels | GitLab host for the GitLab credential. Set this for a self-managed public GitLab instance. |

## Development variable

| Variable | Default | Description |
| --- | --- | --- |
| `ORCHESTRATOR_URL` | `http://localhost:3000` | Target used by the dashboard Vite development server for `/api`, `/healthz`, and `/ws`. It has no effect on deployed Boxes. |

## Internal container variables

Boxes sets the following variables when it creates a box. They are not
deployment settings and should not be added to the orchestrator environment.

| Variables | Purpose |
| --- | --- |
| `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy` | Route box traffic through the egress proxy while keeping local traffic direct. |
| `BOXES_PROXY_CA`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `CODEX_CA_CERTIFICATE` | Trust the deployment certificate authority for TLS interception. |
| `GH_TOKEN`, `GITLAB_TOKEN`, `GITLAB_HOST`, `DEVTUNNELS_TOKEN` | Credential placeholders and GitLab host for `git`, `gh`, `glab`, and Dev Tunnels. The proxy replaces placeholders with stored credentials only for approved destinations. |
| `GIT_NAME`, `GIT_EMAIL` | Git identity selected on the dashboard. |
| `CODEX_API_KEY`, `CODEX_HOME`, `NO_BROWSER`, `INITIAL_AGENT_MODE`, `DEFAULT_AUTH_REQUEST` | Codex adapter configuration. |
| `TERM` | Set to `dumb` for commands run through Boxes. |

The box image also defines standard runtime variables such as `HOME`, `PATH`,
`TMPDIR`, `PLAYWRIGHT_BROWSERS_PATH`, and `BOXES_IMAGE_BROWSERS`. Treat these as
image implementation details. Override them only in a derived image that also
preserves the image entrypoint's expectations.

## Custom proxy deployments

The egress proxy accepts `PORT`, `CONTROL_PORT`, and `CONTROL_BIND` directly.
They default to `3128`, `3129`, and an automatically selected Compose-network
address. The shipped Compose file does not pass these variables into the proxy.
Use them only with a custom Compose configuration that changes the matching
orchestrator settings: `EGRESS_PROXY_PORT` for `PORT` and
`EGRESS_CONTROL_PORT` for `CONTROL_PORT`. `CONTROL_BIND` must be an IP address.
