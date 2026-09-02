# Boxes session image: one long-lived container per agent session.
# PID 1 only holds the container open; the ACP adapter runs as a gateway-owned
# docker exec, so browser churn never restarts it.
#
# Ubuntu, and Node from NodeSource rather than from the official node image,
# because those are two independent choices and this image wants both current.
# The OS is picked for its language toolchains: 26.04 carries PHP 8.5, Go 1.26
# and Rust 1.93 where Debian stable carries 8.4, 1.24 and 1.85, and Debian
# oldstable -- what the node image was pinning us to -- carried 8.2, 1.19 and
# 1.63. Node is picked for the two npm globals the agent itself runs. Basing
# on the node image would have tied the first choice to the second, and all it
# ever supplied was Node, npm, and a uid 1000 this file renamed anyway.
FROM ubuntu:26.04

# What the repositories below need before they can be added. apt reaches the
# Ubuntu archive over plain http, but curl needs a trust store.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Node from NodeSource, because Ubuntu's own is frozen at whatever the release
# shipped for the whole of its life -- 26.04 is on 22.x with npm 9, and the
# runtime the agent itself depends on should not be stuck there. The signing
# key is ASCII-armoured, so a .asc name is all `signed-by` needs and there is
# no gnupg to install for a dearmor. `nodistro` is NodeSource's one
# distribution-independent suite, so nothing here names a codename.
ARG NODE_MAJOR=22
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      -o /etc/apt/keyrings/nodesource.asc \
 && chmod go+r /etc/apt/keyrings/nodesource.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      jq \
      build-essential \
      python3 \
      python3-venv \
      pipx \
      less \
      netcat-openbsd \
      bind9-dnsutils \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI from the official apt repo, for the bot's fork and PR flow.
# Ubuntu packages a `gh` of its own now, but it freezes with the release the
# same way Node does, and this is the tool the PR flow depends on.
RUN install -d -m 0755 /usr/share/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Go, Rust and PHP, so a session can work in them without installing a
# toolchain first. The distribution's own packages rather than upstream
# tarballs: they carry its security updates and pin no checksum here. This is
# the reason the base image is Ubuntu -- see README, "Language toolchains".
#
# pkg-config and libssl-dev are not toolchains but are what the common
# native-dependency crates and extensions look for; build-essential, already
# installed above, is the C linker all three need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      golang-go \
      rustc \
      cargo \
      rustfmt \
      rust-clippy \
      rust-src \
      php-cli \
      php-mbstring \
      php-xml \
      php-curl \
      php-zip \
      php-intl \
      php-sqlite3 \
      php-gd \
      php-bcmath \
      composer \
      pkg-config \
      libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# The tools an agent reaches for that are not a language: reading a PDF a
# ticket linked to, unpacking whatever a download turned out to be, converting
# a document, poking at a database file. All of it is stuck behind a read-only
# /usr at runtime, so a tool that is not here is one the agent has to build or
# do without in the middle of a task.
#
# Chosen for what a coding agent actually hits, not for completeness -- these
# add a few hundred megabytes between them, and a deployment that wants a
# leaner image strips them in a derived one.
#
# Two names are not the obvious ones: fd-find installs itself as `fdfind` to
# avoid a collision, and `7zip` replaced `p7zip-full`, which is now virtual.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      qpdf \
      mupdf-tools \
      ghostscript \
      pandoc \
      tesseract-ocr \
      tesseract-ocr-eng \
      ocrmypdf \
      imagemagick \
      graphviz \
      unzip \
      zip \
      xz-utils \
      zstd \
      7zip \
      bzip2 \
      file \
      tree \
      patch \
      wget \
      git-lfs \
      sqlite3 \
      fd-find \
      shellcheck \
      yq \
      cmake \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# uv, the one tool here the archive does not carry. Installed with the pipx
# that is already present, both of its directories pointed at /usr/local for
# this one command: the runtime values below put the agent's own `pipx install`
# in the home volume, and uv belongs on the image beside the npm globals for
# the same reason -- Docker initialises a named volume once and never again, so
# anything durable landing there is frozen at the version the volume was born
# with.
#
# It earns its place twice over under a read-only /usr: `uv tool install` and
# `uv python install` both write to the home volume, so the agent can fetch a
# Python it does not have without any privilege at all.
RUN PIPX_HOME=/usr/local/pipx PIPX_BIN_DIR=/usr/local/bin pipx install uv \
 && rm -rf /root/.cache

# The adapter is pinned here and nowhere else. Do not switch to
# @zed-industries/claude-code-acp, which is stale at 0.16.2.
RUN npm install -g \
      @anthropic-ai/claude-code \
      @agentclientprotocol/claude-agent-acp@0.70.0 \
 && npm cache clean --force

# The browser an agent drives, and the tool it drives it with.
#
# @playwright/cli is Microsoft's own CLI for coding agents: a snapshot command
# that renders the page as an accessibility tree with a [ref=eN] handle on
# every element, and click/type/select/hover commands that take those refs. It
# holds the browser in a daemon between invocations, so a snapshot in one
# command and a click in the next act on the same page. That is the same
# interaction model as Playwright MCP -- the two share the implementation --
# without an MCP server to configure or a second process for anything here to
# manage, and it writes each snapshot to a file rather than into the model's
# context. It ships its own agent skill, which the entrypoint installs.
#
# Pinned, like the ACP adapter, and for a better reason: this is 0.1.x, and it
# depends on a prerelease Playwright.
#
# Chromium only. Firefox and WebKit would roughly double the layer, and a
# coding agent wants a browser rather than a compatibility matrix. Ubuntu's own
# chromium is not an option in any case -- it is a virtual package standing in
# for a snap, and snapd does not run in here.
#
# --with-deps rather than a hand-written library list, because Playwright
# maintains that mapping per distribution and Ubuntu's 64-bit time_t
# transition renamed half of it (libasound2t64, libcups2t64, libglib2.0-0t64).
# It also brings the font packages, without which a screenshot of a page in a
# non-Latin script comes back as boxes.
#
# PLAYWRIGHT_BROWSERS_PATH keeps the browser on the image rather than in the
# home volume, for the reason the npm globals are on the image: a named volume
# is initialised once and never refreshed. The cost is that it is read-only at
# runtime, so a project pinning its own Playwright has to point the variable at
# its own home and download there -- which the shipped skill spells out.
#
# libnss3-tools is not Playwright's: it is certutil, which the entrypoint uses
# to put the deployment CA where Chromium will actually look for it.
ARG PLAYWRIGHT_CLI_VERSION=0.1.19
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install -g @playwright/cli@${PLAYWRIGHT_CLI_VERSION} \
 && npm cache clean --force \
 && playwright-cli install-browser chromium --with-deps \
 && apt-get update && apt-get install -y --no-install-recommends libnss3-tools \
 && rm -rf /var/lib/apt/lists/*

# The environment's half of the CLI's configuration: which browser, and the two
# launch options a session container needs. The entrypoint copies this to the
# CLI's global config with the egress proxy added, since only runtime knows
# that. Read the file -- it explains why each key is there.
COPY playwright-cli.config.json /usr/local/share/boxes/playwright-cli.config.json

# The agent's own account, created rather than renamed: an Ubuntu base ships
# no developer user to reuse, and 1020 keeps clear of the `ubuntu` account it
# does carry at 1000 -- which on a real host is usually a person.
#
# These have to match the orchestrator's SESSION_UID and SESSION_GID -- their
# defaults are the same numbers, in orchestrator/src/workspaces.ts. A session's
# home is a named volume Docker ownership-initialises from /home/agent below,
# so a mismatch leaves the agent unable to write its own home; the orchestrator
# reads this image's user back at boot and says so if they have drifted.
ARG AGENT_UID=1020
ARG AGENT_GID=1020

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g "${AGENT_GID}" -m -d /home/agent -s /bin/bash agent

# HOME is named outright rather than left to Docker's /etc/passwd lookup: it
# is what GOPATH, GOCACHE, CARGO_HOME and COMPOSER_HOME are each derived from,
# so a session that resolved it differently would put every build cache
# somewhere other than its own volume.
#
# LANG likewise: the node image carried the locales package and this base does
# not, and a session that ran in the C locale would mangle any non-ASCII path
# or diff it touched. C.UTF-8 is built into glibc, so it needs no package.
ENV HOME=/home/agent \
    LANG=C.UTF-8 \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    TERM=dumb \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Where the agent installs tools for itself.
#
# The root filesystem is read-only at runtime and nothing in a session is
# root, so `apt-get install` cannot work and neither can `npm install -g` into
# /usr/local. /home/agent is a persistent volume, so pointing the user-level
# package managers there is what turns "the agent needs one more tool" into
# something it can do on its own -- and it needs no privilege the session
# does not already have, which is the point.
#
# Set *after* the global install above, deliberately. That one belongs in
# /usr/local, on the image. Landing it in the home volume instead would pin
# the adapter to whatever version the volume was born with: Docker
# initialises a named volume from the image exactly once and never refreshes
# it, so every later image update would be invisible to an existing session.
ENV NPM_CONFIG_PREFIX=/home/agent/.local \
    PIPX_HOME=/home/agent/.local/pipx \
    PIPX_BIN_DIR=/home/agent/.local/bin

# Each toolchain's own install directory, on PATH for the same reason. Go,
# Cargo and Composer all default to somewhere under $HOME already -- ~/go/bin,
# ~/.cargo/bin, ~/.config/composer/vendor/bin -- as do their build caches, so
# a read-only /usr costs them nothing and there is nothing to redirect. What
# they do not do is put those directories on PATH, which is what makes
# `go install`, `cargo install` and `composer global require` produce a tool
# the agent can then actually run. The tools create the directories
# themselves; being absent on PATH is harmless.
ENV PATH=/home/agent/.local/bin:/home/agent/go/bin:/home/agent/.cargo/bin:/home/agent/.config/composer/vendor/bin:$PATH

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# A login shell has to end up with every directory above, because `bash -lc`
# is what the command surface and the agent's own shell tools run under.
# Ubuntu's /etc/profile leaves PATH alone, so today they survive it; Debian's
# assigns PATH outright and drops all of them, and this image has been based
# on both. /etc/profile.d is sourced after that assignment either way, so the
# snippet below puts them back -- from this snapshot of PATH rather than from
# a second copy of the list, which would be free to drift from the real one.
#
# Taken here, after every ENV that adds to PATH and before nothing else does.
RUN mkdir -p /etc/boxes \
 && printf "BOXES_IMAGE_PATH='%s'\n" "$PATH" > /etc/boxes/image-path \
 && chmod 0644 /etc/boxes/image-path
COPY profile-image-path.sh /etc/profile.d/boxes-image-path.sh
RUN chmod 0644 /etc/profile.d/boxes-image-path.sh

# The root filesystem is mounted read-only at runtime. /workspace and
# /home/agent are the writable volumes, and /tmp is a tmpfs.
# /boxes/agent is where the orchestrator binds this session's merged agent
# configuration, read-only. Created here rather than left to the daemon so the
# mount point exists on a read-only rootfs.
RUN mkdir -p /workspace /home/agent/.local/bin /boxes/agent \
 && chown agent:agent /workspace /home/agent /home/agent/.local /home/agent/.local/bin

# Numeric rather than `agent`, so the uid is readable from the image itself.
USER ${AGENT_UID}
WORKDIR /workspace

# Proof rather than assumption, because every failure this guards against is
# silent: an ARG out of scope leaves USER empty, which means root, and the
# build succeeds anyway having quietly undone both the uid and the non-root
# part of the security model. The rest is the tool directories: an unwritable
# one, an npm prefix that did not take, a login shell that lost them all to
# /etc/profile, or an adapter that ended up in the home volume instead of on
# the image -- none of which shows up until a session is running. Runs as the
# user it is checking, so it needs no privileges of its own.
RUN test "$(id -u)" = "${AGENT_UID}" \
 && test "$(id -g)" = "${AGENT_GID}" \
 && test "$(id -un)" = "agent" \
 && test -w /workspace && test -w /home/agent \
 && test -w /home/agent/.local/bin \
 && test "$(npm config get prefix)" = "/home/agent/.local" \
 && test "$(command -v claude-agent-acp)" = "/usr/local/bin/claude-agent-acp" \
 && bash -lc 'set -eu; . /etc/boxes/image-path; IFS=:; for d in $BOXES_IMAGE_PATH; do \
      case ":$PATH:" in *":$d:"*) ;; *) echo "a login shell lost $d" >&2; exit 1 ;; esac; \
    done'

# Node is the one thing here that does not come from the distribution, so both
# halves of that get checked. The major is the one asked for -- and because
# Ubuntu's own nodejs is on the same major, which would make that check pass
# on the wrong package, the vendor is checked too: apt quietly preferring the
# distribution's build would leave a working image whose npm is a separate
# package nobody installed.
RUN test "$(node -p 'process.versions.node.split(".")[0]')" = "${NODE_MAJOR}" \
 && test "$(command -v node)" = "/usr/bin/node" \
 && dpkg-query -W -f='${Version}' nodejs | grep -q nodesource \
 && npm --version >/dev/null

# Every added tool resolves, as the agent, under the name it will be reached
# for. This is the check that catches a package renamed out from under the
# list -- `p7zip-full` going virtual, or `dnsutils` doing the same -- which apt
# reports as an unsatisfiable dependency only if the name is gone entirely,
# and silently installs nothing useful if some other package still provides it.
RUN set -eu; \
    for t in pdftotext pdftoppm pdfinfo qpdf mutool gs pandoc tesseract ocrmypdf \
             magick dot unzip zip xz zstd 7z file tree patch wget git-lfs \
             sqlite3 fd fdfind shellcheck yq cmake uv uvx dig playwright-cli certutil; do \
      command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; \
    done

# The browser opens, loads a page and snapshots it with refs, as the agent.
#
# Everything this catches is a runtime failure the build would otherwise ship:
# a missing shared library, a browsers directory the agent cannot read, a
# config that leaves the CLI looking for Google Chrome at /opt/google/chrome,
# and above all a Chromium sandbox left on -- which fails at browser startup
# and would make every browser command in every session useless.
#
# Served over loopback by python rather than fetched, because the build host
# has no business needing egress for this, and `file:` URLs are blocked by the
# CLI by design. --config points at the image's copy: the global config does
# not exist until the entrypoint writes one.
RUN set -eu; \
    cd /tmp; \
    printf '<!doctype html><title>t</title><button>Continue</button>\n' > index.html; \
    python3 -m http.server 18901 --bind 127.0.0.1 >/dev/null 2>&1 & \
    server=$!; \
    trap 'kill $server 2>/dev/null || true' EXIT; \
    cfg=/usr/local/share/boxes/playwright-cli.config.json; \
    for _ in $(seq 1 50); do \
      curl -fsS -o /dev/null http://127.0.0.1:18901/ && break; sleep 0.2; \
    done; \
    playwright-cli --config "$cfg" open http://127.0.0.1:18901/; \
    playwright-cli --config "$cfg" snapshot >/dev/null; \
    grep -qE 'button "Continue" \[ref=e[0-9]+\]' .playwright-cli/*.yml; \
    playwright-cli --config "$cfg" close; \
    rm -rf /tmp/index.html /tmp/.playwright-cli

# The toolchains build something, as the agent, with their caches where a
# session will really put them.
#
# Running each binary with --version would only prove it is installed. The
# thing that breaks at runtime is subtler: /usr is read-only there, so every
# one of these has to be writing its build cache somewhere under /home/agent.
# One compiled file each is what shows that, and it shows it here rather than
# in the first real session that tries to build anything.
#
# The caches are removed afterwards, deliberately: left in place they would be
# copied into every new session's home volume, which Docker initialises from
# this image once and never refreshes.
RUN set -eu; \
    cd /tmp; \
    printf 'package main\nimport "fmt"\nfunc main() { fmt.Println("ok") }\n' > hello.go; \
    test "$(go run hello.go)" = "ok"; \
    test "$(go env GOPATH)" = "/home/agent/go"; \
    test "$(go env GOCACHE)" = "/home/agent/.cache/go-build"; \
    cargo new --quiet --bin --vcs none /tmp/hello-rs; \
    cd /tmp/hello-rs && cargo build --quiet --offline && ./target/debug/hello-rs >/dev/null; \
    command -v rustfmt >/dev/null && command -v cargo-clippy >/dev/null; \
    test "$(php -r 'echo "ok";')" = "ok"; \
    composer --version >/dev/null; \
    cd /tmp && rm -rf hello.go /tmp/hello-rs \
      /home/agent/.cache /home/agent/go /home/agent/.cargo /home/agent/.config/composer

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
