# Docker Compose setup

The supplied `compose.yaml` starts Boxes as two services and one named volume:

| Resource | Purpose |
| --- | --- |
| `orchestrator` | Serves the dashboard, API, health endpoint, and WebSocket gateway. It creates and manages box containers through the Docker socket. |
| `egress-proxy` | Provides the only network route out of each box's private network. It applies egress policy and replaces credential placeholders with stored credentials. |
| `boxes-data` | Persists the Boxes database, generated Web Push keys, and every box workspace. |

Start the stack from the repository root:

```sh
docker compose up -d
```

The default address is `http://localhost:3000`.

## Network layout

Compose creates the default `boxes_default` network. The orchestrator and
egress proxy both join it. The dashboard, API, and WebSocket gateway are served
by the orchestrator on one port.

At runtime, the orchestrator creates a separate internal network for each box.
It connects the egress proxy to that network and gives it the `proxy` alias.
Individual boxes therefore cannot connect to the internet directly. Their proxy-aware
tools use the egress proxy, and other outbound connections have no route.

The egress proxy's control channel is available only on the Compose network.
It is not published to the host or box networks.

## Host access

By default, Compose publishes the orchestrator only on the loopback interface.
This is deliberate: the orchestrator has no authentication of its own and
controls the host Docker daemon.

To provide access from outside the host, put an authenticated reverse proxy in
front of Boxes. The reverse proxy must forward WebSocket upgrades for `/ws`.
A reverse proxy on the host can connect through the loopback address. A proxy
running in a container can join `boxes_default` and connect to
`orchestrator:3000`.

## Persistent data

The `boxes-data` named volume is mounted at `/data` in the orchestrator. It
contains state that must survive container recreation, including box
workspaces. Back up this volume before upgrading or moving a deployment.

The orchestrator bind-mounts workspace directories from this volume into box
containers. It discovers the volume's host path automatically when using the
shipped Compose file.

## Docker socket access

The orchestrator mounts `/var/run/docker.sock`. This is required to create box
containers, networks, and mounts, but grants root-equivalent access to the
Docker host. Keep the service bound to loopback or protected by a trusted
authentication layer.

## Configuration

The Compose file supports an optional environment file for the orchestrator.
See [Environment variables](environment.md) for its location, every supported
setting, and guidance for custom deployments.
