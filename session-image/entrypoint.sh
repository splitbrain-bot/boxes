#!/usr/bin/env bash
# Runs as agent on container start. Prepares the git and gh identity, then
# holds the container open with sleep. The gateway spawns the ACP adapter
# separately, as a long-lived exec.
set -uo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# --- egress proxy CA --------------------------------------------------------
# The proxy terminates TLS for the hosts whose credentials it translates, so
# this container has to trust the deployment's CA for those hosts to work. The
# certificate arrives as a PEM in the environment rather than a mount, and the
# variables that point node, gh, git and curl at the file are already set by
# the orchestrator; all that is left is putting it where they look.
if [ -n "${BOXES_PROXY_CA:-}" ]; then
  mkdir -p /home/agent/.boxes
  if printf '%s\n' "$BOXES_PROXY_CA" > /home/agent/.boxes/proxy-ca.crt; then
    chmod 0644 /home/agent/.boxes/proxy-ca.crt
    log "wrote the egress proxy CA to /home/agent/.boxes/proxy-ca.crt"
  else
    log "WARNING: could not write the egress proxy CA; TLS to translated hosts will fail"
  fi
fi

# --- git identity -----------------------------------------------------------
if [ -n "${GIT_NAME:-}" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "${GIT_EMAIL:-}" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
git config --global init.defaultBranch main
git config --global advice.detachedHead false
# /workspace is the agent's own volume. Marking it safe avoids git's
# dubious-ownership refusal when uid mapping differs across volume restores.
git config --global --add safe.directory '*'

# --- github auth ------------------------------------------------------------
if [ -n "${GH_TOKEN:-}" ]; then
  if gh auth setup-git 2>/dev/null; then
    log "configured git credential helper via gh"
  else
    log "WARNING: gh auth setup-git failed; https pushes may prompt"
  fi
fi

# --- hold the container -----------------------------------------------------
log "ready; holding container open"
exec sleep infinity
