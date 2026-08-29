#!/usr/bin/env bash
# Runs as agent on container start. Prepares the git and gh identity and the
# clone, then holds the container open with sleep. The gateway spawns the ACP
# adapter separately, as a long-lived exec.
set -uo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# --- git identity -----------------------------------------------------------
if [ -n "${GIT_NAME:-}" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "${GIT_EMAIL:-}" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
git config --global init.defaultBranch main
git config --global advice.detachedHead false
# The clone below is the agent's own checkout. Marking it safe avoids git's
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

# --- repo clone -------------------------------------------------------------
# Only clone when a repo was requested and the target is absent/empty, so a
# restart onto an existing /workspace volume never clobbers the agent's work.
if [ -n "${REPO_URL:-}" ]; then
  case "$REPO_URL" in
    https://*) ;;
    *) log "ERROR: REPO_URL must be an https:// URL, got: $REPO_URL"; REPO_URL="" ;;
  esac
fi

if [ -n "${REPO_URL:-}" ]; then
  if [ -d /workspace/repo/.git ]; then
    log "/workspace/repo already contains a clone; leaving it alone"
  elif [ -z "$(ls -A /workspace/repo 2>/dev/null)" ]; then
    log "cloning $REPO_URL into /workspace/repo"
    if git clone --depth 50 "$REPO_URL" /workspace/repo; then
      log "clone complete"
    else
      log "WARNING: clone failed; /workspace/repo left empty"
    fi
  else
    log "WARNING: /workspace/repo is non-empty but not a git repo; skipping clone"
  fi
fi

# --- hold the container -----------------------------------------------------
log "ready; holding container open"
exec sleep infinity
