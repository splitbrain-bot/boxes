# Quickstart

This document describes how to deploy Boxes with Docker Compose, how to put a reverse proxy in front of it, and how to
do the first steps in the dashboard.

The [glossary](glossary.md) defines the terms used here.

## Prerequisites

- Docker with Compose v2
- Internet access, so Compose can pull the images from GHCR

## Deploy with Docker Compose

The deployment needs one file: a `compose.yaml` that references the prebuilt images published on GHCR. Create a
directory for the deployment and put this file in it:

```yaml
name: boxes

services:
  orchestrator:
    image: ghcr.io/splitbrain/boxes/orchestrator:latest
    container_name: boxes-orchestrator
    restart: unless-stopped
    depends_on:
      - egress-proxy
    # Run as the user the workspaces belong to, and give it the group of the
    # Docker socket, so the orchestrator drops root but can still create
    # containers. 998 is the group of the socket on many hosts; check with
    # stat -c %g /var/run/docker.sock.
    user: "1020:1020"
    group_add:
      - "998"
    environment:
      # The user and group the processes in a box run as, and the owner of
      # every file in a workspace. Match the user above.
      BOX_UID: 1020
      BOX_GID: 1020
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - boxes-data:/data
    ports:
      # Loopback, so only a reverse proxy on this host can reach it. The port
      # can go entirely when the proxy runs in a container and shares a Docker
      # network with the orchestrator: attach the orchestrator to the proxy's
      # network and let the proxy route to orchestrator:3000.
      - "127.0.0.1:3000:3000"

  egress-proxy:
    image: ghcr.io/splitbrain/boxes/egress-proxy:latest
    container_name: boxes-egress-proxy
    restart: unless-stopped
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true

volumes:
  boxes-data:
```

This starts two services and one named volume:

| Resource | Purpose |
| --- | --- |
| `orchestrator` | Serves the dashboard, the API, and the WebSocket gateways on port 3000. Manages the box containers. |
| `egress-proxy` | The only route out of a box's private network. Applies egress policy and swaps in the credentials. |
| `boxes-data` | The volume with the database, the generated keys, and the workspace, home, and Nix store of each box. |

You are expected to edit this file. The `user`, `group_add`, and `environment` sections above show the settings most
deployments change first: the user and group that own the workspace files. See [Environment variables](environment.md)
for every setting. No credential belongs in this file: credentials are entered on the settings page of the dashboard.

From that directory, run:

```sh
docker compose up -d
```

Follow the start with:

```sh
docker compose logs -f orchestrator
```

See [Docker Compose setup](compose.md) for the network layout and the persistent data.

## Secure the deployment

The orchestrator has no authentication of its own and controls the Docker daemon of the host. To give access from other
machines, put an authenticated reverse proxy in front of it. The setup of the proxy is your responsibility. Two
requirements:

- The proxy must authenticate the users and use HTTPS.
- The proxy must forward WebSocket upgrades for the paths under `/ws`. The dashboard uses these paths to attach to
  threads and terminals.

A proxy on the Docker host reaches the orchestrator on the published loopback port. A proxy in a container reaches it
over a shared Docker network instead; the published port can then go.

The `boxes-data` volume holds the credentials in plain text, because the orchestrator must give them to the egress
proxy. Protect access to this volume and to its backups. See [Storage](storage.md).

## First steps

1. Open the dashboard and go to **Settings**. Enter the credentials for the agents you want to use: a token for Claude
   Code or an API key for Codex. GitHub and GitLab tokens authenticate `git` and the CLIs in each box. See
   [Credentials](credentials.md).
2. Create a [box](boxes.md) from the box list. The dialog asks for the agent and the settings of its first thread. On
   creating the first box, the orchestrator pulls the box image from GHCR, which takes some minutes. It then creates the
   container and its private network, and starts the thread.
3. Type prompts in the [thread](threads.md) view. A running turn continues even when you close the tab.
