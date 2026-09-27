---
name: nix
description: Install tools, languages and services with nix when this box does not have them. Use when a command is missing, a project needs a database or another service, or a repository ships a flake.nix, shell.nix or devenv.nix.
---

# Nix in this box

`nix` is installed and runs as your own user. There is no root, no `sudo`
and no `apt` here, and nix is how you get software the image does not carry.

## What lasts

- `/nix` is this box's own store. It persists across stops, restarts and
  image updates, like `/workspace` and your home.
- What you install into your profile persists with it. The profile lives at
  `~/.local/state/nix/profile`, and its `bin` is on your `PATH`.
- Nothing you start keeps running after the box stops. Start services again
  when you come back.

## Commands

Install a tool for good:

```sh
nix profile add nixpkgs#ripgrep
```

Try a tool for one shell, without installing it:

```sh
nix shell nixpkgs#jq --command jq --version
nix-shell -p imagemagick --run 'convert --version'
```

Enter a repository's own environment:

```sh
nix develop          # a flake.nix
nix-shell            # a shell.nix
devenv shell         # a devenv.nix, after: nix profile add nixpkgs#devenv
```

Search for a package:

```sh
nix search nixpkgs postgresql
```

Reclaim disk after experiments:

```sh
nix-collect-garbage
```

## Services

A database or a server is a normal program here. Run it as yourself, on a
port of your choice, with its data in the workspace or your home. Low ports
work too.

```sh
nix profile add nixpkgs#postgresql
initdb -D /workspace/.pgdata
pg_ctl -D /workspace/.pgdata -o '-k /tmp' -l /workspace/.pgdata/log start
createdb -h /tmp app
```

Run long-lived services in the background so you can keep working. A
repository with a `devenv.nix` that declares services can start all of them
with `devenv up`.

## What to expect

- The first command that names `nixpkgs` downloads and evaluates it. That
  takes about a minute and a few hundred megabytes. Later commands are fast.
- Builds are not sandboxed here. Almost everything comes prebuilt from the
  binary cache; what does not is built as you, in your environment.
- Downloads go through the box's proxy. If nix reports that it cannot reach
  `cache.nixos.org` or `channels.nixos.org`, the deployment's allowlist
  blocks them: tell the user rather than working around it.
- `docker` is not available. Use nix for what you would otherwise run in a
  container.
