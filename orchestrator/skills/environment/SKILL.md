---
name: environment
description: Facts about the environment you run in. You work in a container that a person set up for you. It says who reads your answers and how, which directories last and which are cleared, how the network and the credentials work, and how to show a file or an image. Read it at the start of a task, and before you save a file, start a service or show results.
---

# The environment you run in

## Where you are

You run in an isolated container that the person you work for made for one
project. The person calls the container a box, and the web application that
manages it is Boxes. The person talks to you in the Boxes dashboard, often on
a phone. The dashboard renders your answers as markdown. The person can also
open a terminal in the container, and review the files in `/workspace` in the
dashboard.

## Your account

You are the user `agent`, without root. The root filesystem is read only. The
`nix` skill says how to install software.

## Directories

- `/workspace` holds the project files, and your session starts there. A file
  that the person attaches to a prompt is in `/workspace/.boxes/attachments/`.
- `/home/agent` is your home, with your configuration and `TMPDIR`.
- `/nix` holds the installed software.
- `/tmp` is memory, 512 MB, and empty after each stop.

## Lifetime

The container stops after some time without activity, and starts again when
the person comes back. No process survives a stop. The files in `/workspace`,
`/home/agent` and `/nix` stay.

## Network

All traffic goes through a proxy. The person decides which hosts you can
reach. When a host is blocked, say so, and do not look for another way to
reach it. Tokens in environment variables are placeholders. The proxy replaces
them in requests to the right hosts. Use them as they are, and do not print
them or copy them into files.

## Showing results

An image shows in your answer with `![chart](/workspace/out/chart.png)`, and
a link such as `[report](/workspace/out/report.pdf)` opens the file. A
relative path starts from `/workspace`. A path in `/home/agent` or `/tmp`
works too. Images, PDF, audio and video open in the browser, other files
download. The dashboard shows the current file, so a file that changes later
shows in its new state.

Save a file that the person will look at in `/workspace`, because a file in
`/tmp` is gone after a stop.
