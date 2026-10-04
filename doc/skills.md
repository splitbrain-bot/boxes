# Built-in skills

Boxes preinstalls skills for common project tasks. They are available in every box
and are updated when the box image is updated.

Custom skills can be added to a box by including them in the agent set. Agent sets
can also be used to override built-in skills with project-specific instructions.

## Nix

Boxes runs the agent in an unprivileged account inside a container with a
read-only root filesystem. There is no `sudo`, `apt`, or Docker daemon in a box.

The nix skill provides instructions for installing software using the nix
a package manager that does not require root access.

The Nix store and user profile persist when a box stops or restarts, so installed
tools remain available.

Nix fetches packages through the box egress proxy. A restrictive egress
allowlist must permit `cache.nixos.org` and `channels.nixos.org`.

Skill instructions: [nix](../box-image/skills/nix/SKILL.md)

## Share app

Services started by the agent are only available inside the box's own network.
When a user want to review or test a running application, the `share-app` skill
provides a public URL that forwards to the box's private network.

This uses the free
[Microsoft Dev Tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/overview)
service.

Anyone with the generated URL can open it, so the tunnel should be removed when
sharing is finished.

Skill instructions: [share-app](../box-image/skills/share-app/SKILL.md)

## Playwright CLI

When doing web development, browser debugging is necessary. The box image includes
the Playwright CLI and the `playwright-cli` skill to do this.

Playwright makes it possible to run a web service in a real headless browser,
inspect the accessibility tree, interact with DOM elements, and verify behavior.
Chromium is already installed. Firefox and WebKit can be downloaded when a
project needs them.

Skill instructions: [playwright-cli](https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/SKILL.md)
