#!/usr/bin/env bash
# Box setup. The orchestrator runs it as the agent after each start of the
# box, before the box is ready. It seeds a new home, prepares the home for
# the tools of the base image, then runs the steps that an image adds in
# setup.d.
#
# A step that breaks the box fails it, and the orchestrator marks the box as
# an error with this output. A step that breaks one tool only warns. The
# setup runs every step, so the output names every failure.
set -uo pipefail

# Writes one line to stderr, which the orchestrator reads.
log() { printf '[setup] %s\n' "$*" >&2; }

failed=0

# Records a failure, which the exit code reports at the end.
fail() {
  log "ERROR: $*"
  failed=1
}

# --- the home seed ----------------------------------------------------------
# A new home gets the files of the image's seed directory, once. The marker
# keeps a file that the agent deleted from coming back. The copy overwrites
# nothing and keeps the mode of the home itself, so a home that has files
# keeps them.
seed=/usr/local/share/boxes/home
marker=/home/agent/.boxes/seeded
if [ ! -e "$marker" ]; then
  if cp -R --update=none "$seed/." /home/agent/ \
     && mkdir -p /home/agent/.boxes \
     && touch "$marker"; then
    log "seeded the home from $seed"
  else
    fail "could not seed the home from $seed; the shell and the harnesses would miss their files"
  fi
fi

# --- scratch space ----------------------------------------------------------
# TMPDIR lies on the persistent home, so it is emptied at every start. It is
# created for a home seeded from an older image. Only the contents go, so a
# wrong TMPDIR cannot delete a directory that matters.
if [ -n "${TMPDIR:-}" ]; then
  if mkdir -p "$TMPDIR"; then
    find "$TMPDIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  else
    log "WARNING: could not create $TMPDIR; tools reading TMPDIR will fail"
  fi
fi

# --- the CA bundle -------------------------------------------------------------
# The system authorities and the deployment CA together. The orchestrator
# writes the CA to ~/.boxes/proxy-ca.crt and points the CA env vars at the
# bundle. Some tools, such as git-lfs, trust only the file they are pointed
# at, so it must hold every authority. Written even without a CA, because
# nix.conf of the full image names the file.
proxy_ca=/home/agent/.boxes/proxy-ca.crt
bundle=/home/agent/.boxes/ca-bundle.crt
if mkdir -p /home/agent/.boxes \
   && cat /etc/ssl/certs/ca-certificates.crt > "$bundle.tmp" \
   && { [ ! -f "$proxy_ca" ] || cat "$proxy_ca" >> "$bundle.tmp"; } \
   && mv "$bundle.tmp" "$bundle"; then
  log "wrote the CA bundle to $bundle"
else
  rm -f "$bundle.tmp"
  fail "could not write $bundle; TLS would fail for nix, git, curl and other tools"
fi

# --- directories an agent needs to find already there ------------------------
# npm install -g needs its prefix to exist, and Codex fails on a missing
# CODEX_HOME. A home seeded from an older image may lack either.
if ! mkdir -p /home/agent/.local/bin; then
  fail "could not create /home/agent/.local/bin; installing tools would fail"
fi
if ! mkdir -p "${CODEX_HOME:-/home/agent/.codex}"; then
  fail "could not create ${CODEX_HOME:-/home/agent/.codex}; Codex would not start"
fi

# --- github auth ------------------------------------------------------------
if [ -n "${GH_TOKEN:-}" ]; then
  if gh auth setup-git 2>/dev/null; then
    log "configured git credential helper via gh"
  else
    log "WARNING: gh auth setup-git failed; https pushes may prompt"
  fi
fi

# --- gitlab auth ------------------------------------------------------------
# glab reads GITLAB_TOKEN and GITLAB_HOST from the environment. git uses
# glab's credential helper for that one host.
if [ -n "${GITLAB_TOKEN:-}" ] && [ -n "${GITLAB_HOST:-}" ]; then
  if git config --global "credential.https://${GITLAB_HOST}.helper" '!glab auth git-credential'; then
    log "configured git credential helper for $GITLAB_HOST via glab"
  else
    log "WARNING: could not configure the glab credential helper; https pushes to $GITLAB_HOST may prompt"
  fi
fi

# --- the steps of the image ----------------------------------------------------
# An image built from this one adds its steps as executable files. Each runs
# in name order, under the same rules as this script: a non-zero exit code
# is an error of the box, and a WARNING: line is a warning.
for step in /usr/local/lib/boxes/setup.d/*; do
  if [ ! -f "$step" ] || [ ! -x "$step" ]; then
    continue
  fi
  if ! "$step"; then
    fail "the setup step $(basename "$step") failed"
  fi
done

exit "$failed"
