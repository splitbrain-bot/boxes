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

# --- the agent's own tool directory -----------------------------------------
# npm's prefix has to exist before `npm install -g` will use it, and a home
# volume created before this directory was part of the image does not have it:
# Docker initialises a named volume from the image once and never again.
if ! mkdir -p /home/agent/.local/bin; then
  log "WARNING: could not create /home/agent/.local/bin; installing tools will fail"
fi

# --- agent configuration ----------------------------------------------------
# The orchestrator materializes this box's merged AGENTS.md, skills and slash
# commands into a read-only bind at /boxes/agent, laid out exactly as they have
# to appear under ~/.claude. Only the copy happens here, because ~/.claude is
# on the home volume and the orchestrator has no path to it.
#
# The manifest is what makes the install reversible: it names every path put
# there, a copy of it is left behind in ~/.claude/.boxes-managed, and the next
# start removes exactly those before installing again. So a skill deleted in
# the dashboard disappears from the box, while anything the agent itself put in
# ~/.claude is never touched.
AGENT_SRC=/boxes/agent
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-/home/agent/.claude}"
MANAGED="$CLAUDE_DIR/.boxes-managed"

# A manifest line has to be one relative path under CLAUDE_DIR and nothing
# else. The file is written by the orchestrator, but it decides what gets
# deleted, so it is checked rather than trusted.
safe_rel() {
  case "$1" in
    ''|/*|*..*|*'
'*) return 1 ;;
  esac
  return 0
}

install_agent_config() {
  mkdir -p "$CLAUDE_DIR" || { log "WARNING: could not create $CLAUDE_DIR"; return; }

  if [ -f "$MANAGED" ]; then
    while IFS= read -r rel; do
      safe_rel "$rel" || continue
      rm -rf -- "$CLAUDE_DIR/$rel"
    done < "$MANAGED"
    rm -f "$MANAGED"
  fi

  if [ ! -f "$AGENT_SRC/manifest" ]; then
    log "no agent configuration is mounted"
    return
  fi

  installed=0
  while IFS= read -r rel; do
    safe_rel "$rel" || continue
    [ -e "$AGENT_SRC/$rel" ] || continue
    mkdir -p "$CLAUDE_DIR/$(dirname -- "$rel")"
    # cp -R onto an existing directory would nest inside it rather than
    # replace it, so the destination goes first. A managed name wins over
    # anything already sitting under it.
    rm -rf -- "$CLAUDE_DIR/$rel"
    if cp -R -- "$AGENT_SRC/$rel" "$CLAUDE_DIR/$rel"; then
      printf '%s\n' "$rel" >> "$MANAGED"
      installed=$((installed + 1))
    else
      log "WARNING: could not install $rel"
    fi
  done < "$AGENT_SRC/manifest"
  log "installed $installed agent configuration entries into $CLAUDE_DIR"
}

install_agent_config

# --- chromium's trust store -------------------------------------------------
# Chromium reads none of the CA variables the rest of the image is pointed at;
# it keeps its own NSS database under ~/.pki/nssdb. Without the deployment CA
# in there, the hosts the proxy intercepts -- and only those -- fail TLS inside
# the browser while working in every other tool, which is a confusing shape to
# debug from a page that will not load.
#
# Removed before it is added, so a restart replaces the entry rather than
# failing on one that is already there.
if [ -n "${BOXES_PROXY_CA:-}" ] && command -v certutil >/dev/null 2>&1; then
  nssdb=/home/agent/.pki/nssdb
  if mkdir -p "$nssdb"; then
    [ -f "$nssdb/cert9.db" ] || certutil -N -d "sql:$nssdb" --empty-password >/dev/null 2>&1
    certutil -D -n boxes-egress-proxy -d "sql:$nssdb" >/dev/null 2>&1
    if certutil -A -n boxes-egress-proxy -t C,, -i /home/agent/.boxes/proxy-ca.crt \
         -d "sql:$nssdb" 2>/dev/null; then
      log "trusted the egress proxy CA in the browser's certificate store"
    else
      log "WARNING: could not add the egress proxy CA to $nssdb; intercepted hosts will fail TLS in the browser"
    fi
  fi
fi

# --- the skills the image ships ---------------------------------------------
# Symlinked rather than copied. Claude Code follows a symlink at a skill
# directory, so the image stays the single source of truth and a new image's
# skills reach a session whose home volume already exists -- a copy would be
# frozen at whatever that volume was initialised with. A directory the session
# put there itself is left alone; only our own links are replaced.
skills_src=/usr/local/share/boxes/skills
skills_dst="${CLAUDE_CONFIG_DIR:-/home/agent/.claude}/skills"
if [ -d "$skills_src" ] && mkdir -p "$skills_dst"; then
  for src in "$skills_src"/*/; do
    [ -d "$src" ] || continue
    dst="$skills_dst/$(basename "$src")"
    if [ -e "$dst" ] && [ ! -L "$dst" ]; then
      log "leaving this session's own $(basename "$src") skill in place"
      continue
    fi
    ln -sfn "${src%/}" "$dst" || log "WARNING: could not link the $(basename "$src") skill"
  done
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
