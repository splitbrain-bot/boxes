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

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# The root filesystem is mounted read-only at runtime. /workspace and
# /home/agent are the writable volumes, and /tmp is a tmpfs.
RUN mkdir -p /workspace /home/agent \
 && chown agent:agent /workspace /home/agent

# Numeric rather than `agent`, so the uid is readable from the image itself.
USER ${AGENT_UID}
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
