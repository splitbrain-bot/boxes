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

ENV CLAUDE_CONFIG_DIR=/home/agent/.claude \
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
    PIPX_BIN_DIR=/home/agent/.local/bin \
    PATH=/home/agent/.local/bin:$PATH

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Debian's /etc/profile replaces PATH outright for a non-root login shell, so
# the ENV above survives a plain `docker exec` but not the `bash -lc` that the
# command surface and the agent's own shell tools run under. /etc/profile.d is
# sourced after that reset, which is why the directory is re-prepended there
# rather than being left to the image environment alone.
COPY profile-local-bin.sh /etc/profile.d/boxes-local-bin.sh
RUN chmod 0644 /etc/profile.d/boxes-local-bin.sh

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
# part of the security model. The rest is the tool directory: an unwritable
# one, an npm prefix that did not take, a login shell that lost the directory
# to /etc/profile, or an adapter that ended up in the home volume instead of
# on the image -- none of which shows up until a session is running. Runs as
# the user it is checking, so it needs no privileges of its own.
RUN test "$(id -u)" = "${AGENT_UID}" \
 && test "$(id -g)" = "${AGENT_GID}" \
 && test "$(id -un)" = "agent" \
 && test -w /workspace && test -w /home/agent \
 && test -w /home/agent/.local/bin \
 && test "$(npm config get prefix)" = "/home/agent/.local" \
 && test "$(command -v claude-agent-acp)" = "/usr/local/bin/claude-agent-acp" \
 && bash -lc 'case ":$PATH:" in *":/home/agent/.local/bin:"*) ;; *) exit 1 ;; esac'

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
