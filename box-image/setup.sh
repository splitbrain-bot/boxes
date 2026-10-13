#!/usr/bin/env bash
# Box setup. The orchestrator runs it as the agent after each start of the
# box, before the box is ready. It prepares the home for the tools of the
# image.
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
# bundle, and nix.conf names it for nix. Some tools, such as git-lfs, trust
# only the file they are pointed at, so it must hold every authority. Written
# even without a CA, because nix.conf always names the file.
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

# --- the nix store -----------------------------------------------------------
# The orchestrator binds in a /nix of the box's own. Nix creates the store
# in it on first use.
if [ ! -w /nix ]; then
  fail "/nix is not writable; nix would not work in this box"
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

# --- chromium's trust store -------------------------------------------------
# Chromium ignores the CA variables and reads its own NSS database. The
# entry is deleted first, so a restart replaces it.
if [ -f "$proxy_ca" ] && command -v certutil >/dev/null 2>&1; then
  nssdb=/home/agent/.pki/nssdb
  if mkdir -p "$nssdb"; then
    [ -f "$nssdb/cert9.db" ] || certutil -N -d "sql:$nssdb" --empty-password >/dev/null 2>&1
    certutil -D -n boxes-egress-proxy -d "sql:$nssdb" >/dev/null 2>&1
    if certutil -A -n boxes-egress-proxy -t C,, -i "$proxy_ca" \
         -d "sql:$nssdb" 2>/dev/null; then
      log "trusted the egress proxy CA in the browser's certificate store"
    else
      log "WARNING: could not add the egress proxy CA to $nssdb; intercepted hosts will fail TLS in the browser"
    fi
  fi
fi

# --- the browser CLI ---------------------------------------------------------

# Links the image's browser builds into the writable PLAYWRIGHT_BROWSERS_PATH
# and drops links that no longer resolve.
#
# A project can then download its own revision beside the links. This runs at
# every start, because a newer image may carry other revisions. Only links
# are swept, because a real directory is a browser a project downloaded.
link_image_browsers() {
  browsers="${PLAYWRIGHT_BROWSERS_PATH:-}"
  image="${BOXES_IMAGE_BROWSERS:-}"
  if [ -z "$browsers" ] || [ -z "$image" ] || [ ! -d "$image" ]; then
    return 0
  fi
  if ! mkdir -p "$browsers"; then
    log "WARNING: could not create $browsers; the image's browsers will not resolve"
    return 0
  fi
  for link in "$browsers"/*; do
    if [ -L "$link" ] && [ ! -e "$link" ]; then
      rm -f "$link"
      log "dropped a browser link the image no longer carries: $(basename "$link")"
    fi
  done
  linked=0
  for build in "$image"/*/; do
    if [ ! -d "$build" ]; then
      continue
    fi
    target="$browsers/$(basename "$build")"
    if [ -e "$target" ]; then
      continue
    fi
    if ln -s "${build%/}" "$target"; then
      linked=$((linked + 1))
    else
      log "WARNING: could not link $(basename "$build") into $browsers"
    fi
  done
  if [ "$linked" -gt 0 ]; then
    log "linked $linked browser build(s) from the image into $browsers"
  fi
}
link_image_browsers

# The CLI's global config: the image's base config plus the egress proxy,
# which is known only at runtime. Written at every start, so a newer image's
# base reaches an existing home.
cli_base=/usr/local/share/boxes/playwright-cli.config.json
cli_config=/home/agent/.playwright/cli.config.json
if [ -r "$cli_base" ] && mkdir -p /home/agent/.playwright; then
  proxy="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
  if [ -n "$proxy" ]; then
    if jq --arg server "$proxy" --arg bypass "${NO_PROXY:-}" \
         '.browser.launchOptions.proxy = (if $bypass == "" then { server: $server }
                                          else { server: $server, bypass: $bypass } end)' \
         "$cli_base" > "$cli_config.tmp" \
       && mv "$cli_config.tmp" "$cli_config"; then
      log "wrote the browser CLI config, pointed at the egress proxy"
    else
      rm -f "$cli_config.tmp"
      log "WARNING: could not write the browser CLI config; the browser uses its own defaults"
    fi
  else
    cp "$cli_base" "$cli_config" \
      && log "wrote the browser CLI config; no egress proxy is configured"
  fi
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

exit "$failed"
