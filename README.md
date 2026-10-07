# Boxes

<img src="dashboard/public/icon-512.png" alt="Boxes logo" width="120" align="right">

Boxes is a web-based orchestrator for AI coding agents, similar to Claude Code on the web. It runs Claude Code and
OpenAI Codex over the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP).

Each box is a Docker container with a workspace, a home directory and a Nix store. It contains one or more threads, and
each thread is one conversation with one agent. Threads of the same box share the workspace, so Claude and Codex can
work on the same checkout.

> [!NOTE]
> This project is mostly vibe coded. I know what I am doing and have a good general idea of the architecture - but
> I will not pretend to have read much of the code. This is a personal project to scratch my own itch.

## Features

- **Isolation.** Each box is a docker container of its own, with a private network and its own files. An agent installs
  the tools it needs with `nix`, and they stay in the box across restarts and image updates.
- **Controlled egress.** A private network has no route to the outside. The egress proxy is the only way out, and it
  optionally limits which hosts the processes in a box can reach.
- **Credentials that stay out of the box.** You enter a credential on the settings page. The processes in a box see a
  placeholder only, and the proxy puts the real credential on the wire.
- **Parallel threads.** Several threads can run on one checkout, which keeps the context of each conversation small. A
  turn continues even when you close the browser.
- **Built-in review tool.** Read, comment on and edit the files of a workspace, with Git change marks, and hand the
  comments back to the agent.
- **Terminal access.** A shell in the box, as the same user as the agent, attached to a persistent tmux session.
- **Agent sets.** A named collection of an `AGENTS.md` file, skills and slash commands. One global set applies to every
  box, and a box can add one more.
- **Push notifications.** The browser tells you when a thread needs a decision, even when no tab is open. You can
  install Boxes as a Progressive Web App (PWA).

## Documentation

> [!NOTE]
> As mentioned above, this is a personal project. The documentation below is not so much to help you use Boxes (though it probably would) but to help me make sure this project stays on course and works as intended.

### Install and configure

- [Quickstart](doc/quickstart.md) — Deploy with Docker Compose, put a reverse proxy in front, and do the first steps
  in the dashboard
- [Docker Compose setup](doc/compose.md) — The services, the volume and the Docker socket
- [Environment variables](doc/environment.md) — Every variable the orchestrator reads, and its default
- [Credentials](doc/credentials.md) — The credentials Boxes uses, how to enter them, and their path into a box

### Use Boxes

- [Boxes](doc/boxes.md) — Create, suspend and delete a box, and what is in one
- [Box status](doc/status.md) — The status badges in the box list and the box details
- [Threads](doc/threads.md) — Start, fork and end a conversation with an agent
- [Code review](doc/review.md) — Inspect, comment on and edit the files of a workspace
- [Terminal](doc/terminal.md) — An interactive shell in a box
- [Agent sets](doc/agent-sets.md) — Give the agents instructions, skills and slash commands
- [Built-in skills](doc/skills.md) — The skills the box image carries, and how to replace one
- [Push notifications](doc/notifications.md) — Let the browser tell you when a thread needs you
- [Glossary](doc/glossary.md) — The terms the documentation uses

### Internals

- [Orchestrator](doc/orchestrator.md) — The service that serves the dashboard and drives Docker
- [Agent communication](doc/acp.md) — The way the dashboard, the orchestrator and an agent speak ACP
- [Egress proxy](doc/egress.md) — Host filtering and credential injection
- [Storage](doc/storage.md) — The contents of the data volume, and the files a box keeps
- [REST API](doc/rests.md) — The HTTP API under `/api` used by the dashboard
- [Development](doc/development.md) — Repository layout, technologies and tests
