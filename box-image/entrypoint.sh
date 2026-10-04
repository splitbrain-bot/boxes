#!/usr/bin/env bash
# Box container entrypoint. Runs as the agent at every start, prepares the
# home, then holds the container open. The gateway runs the ACP adapter as a
# separate exec.
set -uo pipefail

# Writes one line to stderr, which is the container log.
log() { printf '[entrypoint] %s\n' "$*" >&2; }

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

# --- egress proxy CA --------------------------------------------------------
# The proxy terminates TLS for the hosts whose credentials it translates. The
# orchestrator passes the deployment CA as a PEM. The bundle below and the
# browser's certificate store are built from this file.
if [ -n "${BOXES_PROXY_CA:-}" ]; then
  mkdir -p /home/agent/.boxes
  if printf '%s\n' "$BOXES_PROXY_CA" > /home/agent/.boxes/proxy-ca.crt; then
    chmod 0644 /home/agent/.boxes/proxy-ca.crt
    log "wrote the egress proxy CA to /home/agent/.boxes/proxy-ca.crt"
  else
    log "WARNING: could not write the egress proxy CA; TLS to translated hosts will fail"
  fi
fi

# --- the CA bundle -------------------------------------------------------------
# The system authorities and the deployment CA together. The orchestrator
# points the CA env vars at this file, and nix.conf names it for nix. Some
# tools, such as git-lfs, trust only the file they are pointed at, so it must
# hold every authority. Written even without a CA, because nix.conf always
# names the file.
bundle=/home/agent/.boxes/ca-bundle.crt
if mkdir -p /home/agent/.boxes \
   && cat /etc/ssl/certs/ca-certificates.crt > "$bundle.tmp" \
   && { [ ! -f /home/agent/.boxes/proxy-ca.crt ] || cat /home/agent/.boxes/proxy-ca.crt >> "$bundle.tmp"; } \
   && mv "$bundle.tmp" "$bundle"; then
  log "wrote the CA bundle to $bundle"
else
  rm -f "$bundle.tmp"
  log "WARNING: could not write $bundle; TLS will fail for nix, git, curl and other tools"
fi

# --- the nix store -----------------------------------------------------------
# The orchestrator binds in a /nix of the box's own. Nix creates the store
# in it on first use.
if [ ! -w /nix ]; then
  log "WARNING: /nix is not writable; nix will not work in this box"
fi

# --- directories an agent needs to find already there ------------------------
# npm install -g needs its prefix to exist, and Codex fails on a missing
# CODEX_HOME. A home seeded from an older image may lack either.
if ! mkdir -p /home/agent/.local/bin; then
  log "WARNING: could not create /home/agent/.local/bin; installing tools will fail"
fi
if ! mkdir -p "${CODEX_HOME:-/home/agent/.codex}"; then
  log "WARNING: could not create ${CODEX_HOME:-/home/agent/.codex}; Codex will not start"
fi

# --- agent configuration ----------------------------------------------------
# The orchestrator writes this box's merged AGENTS.md, skills and commands to
# a read-only bind at /boxes/agent, laid out as they appear under $HOME. The
# copy runs here, inside the box, so it cannot race the agent's own writes.
AGENT_SRC=/boxes/agent
HOME_DIR="${HOME:-/home/agent}"
MANAGED="$HOME_DIR/.boxes/managed"

# Returns success when manifest line $1 is a safe relative path under $HOME.
#
# The manifest decides what gets deleted, so each line must have two
# components or more and one of the known prefixes. A line such as .claude or
# .ssh is refused.
safe_rel() {
  case "$1" in
    ''|/*|*..*|*'
'*) return 1 ;;
  esac
  case "$1" in
    */?*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    .claude/CLAUDE.md|.codex/AGENTS.md) return 0 ;;
    .claude/skills/?*|.claude/commands/?*) return 0 ;;
    .codex/prompts/?*|.agents/skills/?*) return 0 ;;
  esac
  return 1
}

# Removes the paths the last start installed, then copies every manifest
# entry into $HOME and records it in ~/.boxes/managed. A skill deleted in the
# dashboard therefore leaves the box, and the agent's own files stay.
install_agent_config() {
  if [ -f "$MANAGED" ]; then
    while IFS= read -r rel; do
      safe_rel "$rel" || continue
      rm -rf -- "$HOME_DIR/$rel"
    done < "$MANAGED"
    rm -f "$MANAGED"
  fi

  if [ ! -f "$AGENT_SRC/manifest" ]; then
    log "no agent configuration is mounted"
    return
  fi

  mkdir -p "$(dirname -- "$MANAGED")" \
    || { log "WARNING: could not create $(dirname -- "$MANAGED")"; return; }

  installed=0
  while IFS= read -r rel; do
    safe_rel "$rel" || continue
    [ -e "$AGENT_SRC/$rel" ] || continue
    mkdir -p "$HOME_DIR/$(dirname -- "$rel")"
    # cp -R onto an existing directory would nest inside it.
    rm -rf -- "$HOME_DIR/$rel"
    if cp -R -- "$AGENT_SRC/$rel" "$HOME_DIR/$rel"; then
      printf '%s\n' "$rel" >> "$MANAGED"
      installed=$((installed + 1))
    else
      log "WARNING: could not install $rel"
    fi
  done < "$AGENT_SRC/manifest"
  log "installed $installed agent configuration entries into $HOME_DIR"
}

install_agent_config

# --- chromium's trust store -------------------------------------------------
# Chromium ignores the CA variables and reads its own NSS database. The
# entry is deleted first, so a restart replaces it.
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
      log "warning: could not write the browser CLI config; the browser uses its own defaults"
    fi
  else
    cp "$cli_base" "$cli_config" \
      && log "wrote the browser CLI config; no egress proxy is configured"
  fi
fi

# Appends this image's browser notes to the installed playwright-cli skill:
# which browsers are here, which are one download away, and which command to
# use. The heading marks the notes, so they are appended only once.
append_browser_notes() {
  skill=/home/agent/.claude/skills/playwright-cli/SKILL.md
  [ -f "$skill" ] || return 0
  grep -qF '## Browsers in this container' "$skill" 2>/dev/null && return 0
  cat >> "$skill" <<'SKILL_NOTES'

## Browsers in this container

Chromium is already installed, at the revision this image's Playwright wants,
and it is already linked into `PLAYWRIGHT_BROWSERS_PATH`. `playwright-cli` uses
it with no setup, and so does a project's own Playwright on that revision.

**There is no need to run `playwright install chromium`.** Nothing is missing,
so it finds the link and returns without downloading anything.

To drive the browser, use `playwright-cli`, described above.

Firefox and WebKit are not in the image, but their system libraries are, so one
download makes either work — into the same path, beside the Chromium link:

```sh
playwright install firefox webkit
```

Use `playwright`, the CLI already on PATH here. Avoid `npx playwright`, which
ignores PATH and downloads a second copy of the tool before running it.

A project pinning a Playwright that wants some other Chromium revision can
download that too, the same way. If you would rather not download at all, name
the browser the image carries instead:

```js
chromium.launch({ executablePath: '/usr/local/bin/chromium' });
```

That is a stable link to whatever revision the image has. Naming it this way is
what skips Playwright's revision check, which `channel: 'chromium'` would fail.
SKILL_NOTES
  log "appended this image's browser notes to the playwright-cli skill"
}

# Copies the playwright-cli skill from ~/.claude/skills, where the CLI
# installs it, to ~/.agents/skills, where Codex reads skills.
copy_skill_to_agents() {
  src=/home/agent/.claude/skills/playwright-cli
  dst=/home/agent/.agents/skills/playwright-cli
  [ -d "$src" ] || return 0
  mkdir -p /home/agent/.agents/skills || {
    log "WARNING: could not create ~/.agents/skills; Codex will not see the browser skill"
    return 0
  }
  # cp -R onto an existing directory would nest inside it.
  rm -rf -- "$dst"
  if cp -R -- "$src" "$dst"; then
    log "copied the playwright-cli skill into ~/.agents/skills"
  else
    log "WARNING: could not copy the playwright-cli skill into ~/.agents/skills"
  fi
}

# The CLI's own skill. --global installs it in the home, outside the
# workspace checkout. Reinstalled at every start, so it follows the image.
#
# A skill of the same name in the box's configured set wins, because the
# dashboard shows that one as effective. The orchestrator writes a configured
# skill into every layout, so checking the .claude one is enough.
if [ -f "$AGENT_SRC/manifest" ] \
   && grep -qxF '.claude/skills/playwright-cli' "$AGENT_SRC/manifest"; then
  log "the playwright-cli skill is configured for this box; leaving the image's copy out"
elif command -v playwright-cli >/dev/null 2>&1; then
  if playwright-cli install --skills --global >/dev/null 2>&1; then
    log "installed the image's playwright-cli skill"
    append_browser_notes
    copy_skill_to_agents
  else
    log "WARNING: could not install the playwright-cli skill"
  fi
fi

# --- skills the image carries -------------------------------------------------

# Installs the image's skill named $1 into both skill layouts, at every
# start. A skill of the same name in the box's configured set wins.
install_image_skill() {
  name=$1
  src=/usr/local/share/boxes/skills/$name
  [ -d "$src" ] || return 0
  if [ -f "$AGENT_SRC/manifest" ] && grep -qxF ".claude/skills/$name" "$AGENT_SRC/manifest"; then
    log "the $name skill is configured for this box; leaving the image's copy out"
    return 0
  fi
  for dst in "/home/agent/.claude/skills/$name" "/home/agent/.agents/skills/$name"; do
    # cp -R onto an existing directory would nest inside it.
    if ! { mkdir -p "$(dirname -- "$dst")" && rm -rf -- "$dst" && cp -R -- "$src" "$dst"; }; then
      log "WARNING: could not install the $name skill into $dst"
    fi
  done
  log "installed the image's $name skill"
}
install_image_skill nix
install_image_skill share-app
install_image_skill diagrams

# --- git identity -----------------------------------------------------------
if [ -n "${GIT_NAME:-}" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "${GIT_EMAIL:-}" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
git config --global init.defaultBranch main
git config --global advice.detachedHead false
# Every directory counts as safe, so git does not refuse a checkout whose
# owner differs from the agent, for example after a restore.
git config --global --replace-all safe.directory '*'

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

# --- hold the container -----------------------------------------------------
log "ready; holding container open"
exec sleep infinity
