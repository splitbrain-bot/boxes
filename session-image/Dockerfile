# Boxes session image: one long-lived container per agent session.
# PID 1 only holds the container open; the ACP adapter runs as a gateway-owned
# docker exec, so browser churn never restarts it.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      ripgrep \
      jq \
      build-essential \
      python3 \
      python3-venv \
      pipx \
      less \
      netcat-openbsd \
      dnsutils \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI from the official apt repo, for the bot's fork and PR flow.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Go, Rust and PHP, so a session can work in them without installing a
# toolchain first. Debian's own packages rather than upstream tarballs: they
# come with the distribution's security updates and need no checksum pinned
# here. What that costs is the version -- see README, "Language toolchains".
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

# The adapter is pinned here and nowhere else. Do not switch to
# @zed-industries/claude-code-acp, which is stale at 0.16.2.
RUN npm install -g \
      @anthropic-ai/claude-code \
      @agentclientprotocol/claude-agent-acp@0.70.0 \
 && npm cache clean --force

# node:22-bookworm ships uid 1000 as node; rename it to agent so the container
# user, the volume owner and the exec user all line up, and move it off 1000,
# which on a real host is usually a person.
#
# These have to match the orchestrator's SESSION_UID and SESSION_GID -- their
# defaults are the same numbers, in orchestrator/src/workspaces.ts. A session's
# home is a named volume Docker ownership-initialises from /home/agent below,
# so a mismatch leaves the agent unable to write its own home; the orchestrator
# reads this image's user back at boot and says so if they have drifted.
ARG AGENT_UID=1020
ARG AGENT_GID=1020

RUN usermod -l agent -d /home/agent -m node \
 && groupmod -n agent node \
 && groupmod -g "${AGENT_GID}" agent \
 && usermod -u "${AGENT_UID}" -g "${AGENT_GID}" agent

# HOME is named outright rather than left to Docker's /etc/passwd lookup: it
# is what GOPATH, GOCACHE, CARGO_HOME and COMPOSER_HOME are each derived from,
# so a session that resolved it differently would put every build cache
# somewhere other than its own volume.
ENV HOME=/home/agent \
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

# Debian's /etc/profile replaces PATH outright for a non-root login shell, so
# every ENV PATH above survives a plain `docker exec` but not the `bash -lc`
# that the command surface and the agent's own shell tools run under.
# /etc/profile.d is sourced after that reset, so the snippet below restores
# what was lost -- from this snapshot of PATH rather than from a second copy of
# the list, which would be free to drift from the real one.
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
