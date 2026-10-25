# Built-in skills

A box gets skills from three sources: its [agent set](agent-sets.md), the orchestrator, and the box image. The
orchestrator and the image provide the built-in skills. A skill of the set replaces a built-in skill of the same name,
and a skill of the orchestrator replaces a skill of the image.

## Skills of the orchestrator

These skills describe features of the deployment. The orchestrator installs each one only while the deployment has the
feature. Their source is in `orchestrator/skills`.

### Share app

Services started by the agent are only available inside the box's own network. When a user want to review or test a
running application, the `share-app` skill provides a public URL that forwards to the box's private network.

This uses the free [Microsoft Dev Tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/overview) service.
The skill is installed only when the Dev Tunnels [credential](credentials.md) is stored.

Anyone with the generated URL can open it, so the tunnel should be removed when sharing is finished.

Skill instructions: [share-app](../orchestrator/skills/share-app/SKILL.md)

### Diagrams

Some answers are easier to understand with a picture, for example how components connect or how a request moves through
a system. The dashboard can show mermaid diagrams in the agent's answers.

The `diagrams` skill tells the agent when a diagram helps and when text is sufficient. It also gives rules to write the
mermaid source: which diagram type to use for which purpose and how to accommodate small screens.

Before the agent sends a diagram, it can render the diagram to an image with the mermaid CLI and the Chromium of the
box. Then it can find syntax errors and layout problems itself. The CLI is downloaded from the npm registry when the
agent first uses it.

Skill instructions: [diagrams](../orchestrator/skills/diagrams/SKILL.md)

## Skills of the box image

These skills describe tools of the full [box image](boxes.md). A box gets all skills in
`/usr/local/share/boxes/skills` of its image, one directory per skill. A [custom image](custom-images.md) adds its own.

### Nix

Boxes runs the agent in an unprivileged account inside a container with a read-only root filesystem. There is no `sudo`,
`apt`, or Docker daemon in a box.

The nix skill provides instructions for installing software using the nix a package manager that does not require root
access.

The Nix store and user profile [persist](storage.md) when a box stops or restarts, so installed tools remain available.

Nix fetches packages through the box [egress proxy](egress.md), so a closed
[egress profile](egress-profiles.md) must list `cache.nixos.org` and `channels.nixos.org`.

Skill instructions: [nix](../box-image/skills/nix/SKILL.md)

### Playwright CLI

When doing web development, browser debugging is necessary. The box image includes the Playwright CLI and the
`playwright-cli` skill to do this.

Playwright makes it possible to run a web service in a real headless browser, inspect the accessibility tree, interact
with DOM elements, and verify behavior. Chromium is already installed. Firefox and WebKit can be downloaded when a
project needs them.

Skill instructions:
[playwright-cli](https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/SKILL.md)
