# Boxes session image: one long-lived container per agent session.
# PID 1 only holds the container open; the ACP adapter runs as a
# gateway-owned `docker exec` so browser churn never restarts it (plan §8.1).
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

# GitHub CLI from the official apt repo (used by the bot fork/PR flow, §8.1).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Pinned per plan §2 / §12.3. The adapter package was renamed; the old
# @zed-industries/claude-code-acp is stale at 0.16.2 and must not be used.
RUN npm install -g \
      @anthropic-ai/claude-code \
      @agentclientprotocol/claude-agent-acp@0.70.0 \
 && npm cache clean --force

# node:22-bookworm already ships uid 1000 as `node`; rename to `agent` so the
# container user, the volume owner and the exec user all line up.
RUN usermod -l agent -d /home/agent -m node \
 && groupmod -n agent node

ENV CLAUDE_CONFIG_DIR=/home/agent/.claude \
    TERM=dumb \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Root filesystem is mounted read-only at runtime; /workspace and /home/agent
# are the writable volumes, /tmp is a tmpfs (plan §8.2 step 5).
RUN mkdir -p /workspace /home/agent \
 && chown agent:agent /workspace /home/agent

USER agent
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
