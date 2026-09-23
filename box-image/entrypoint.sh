#!/usr/bin/env bash
# Runs as agent on container start. Prepares the git and gh identity, then
# holds the container open with sleep. The gateway spawns the ACP adapter
# separately, as a long-lived exec.
set -uo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# --- scratch space ----------------------------------------------------------
# TMPDIR is a directory in the home rather than /tmp, because /tmp here is a
# tmpfs and so RAM charged to the container's memory limit -- see the Dockerfile
# for why that is worth avoiding for anything large.
#
# Created because a home filled from an image older than this variable does not
# have the directory, and a missing TMPDIR fails oddly and far from its cause.
# Emptied because the tmpfs it replaces was discarded on every restart for free,
# and a directory on a persistent volume would instead keep every temporary file
# the box ever made.
#
# The contents go rather than the directory itself, so nothing has to re-create
# it, and so a bad TMPDIR can never turn this into a recursive delete of a path
# that means something else.
if [ -n "${TMPDIR:-}" ]; then
  if mkdir -p "$TMPDIR"; then
    find "$TMPDIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  else
    log "WARNING: could not create $TMPDIR; tools reading TMPDIR will fail"
  fi
fi

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

# --- directories an agent needs to find already there ------------------------
# npm's prefix has to exist before `npm install -g` will use it, and Codex
# treats a CODEX_HOME naming a missing directory as an error rather than
# creating it. The image carries both, but a home filled from an image that
# predates either does not have it: a home is copied out of the image when its
# box is created and never refreshed.
if ! mkdir -p /home/agent/.local/bin; then
  log "WARNING: could not create /home/agent/.local/bin; installing tools will fail"
fi
if ! mkdir -p "${CODEX_HOME:-/home/agent/.codex}"; then
  log "WARNING: could not create ${CODEX_HOME:-/home/agent/.codex}; Codex will not start"
fi

# --- agent configuration ----------------------------------------------------
# The orchestrator materializes this box's merged AGENTS.md, skills and slash
# commands into a read-only bind at /boxes/agent, laid out exactly as they have
# to appear in the home. Only the copy happens here. The orchestrator does have
# a path to the home now that it is a directory of its own, but a box's home is
# the box's to write: doing it out here would race with the agent that is
# living in it.
#
# Every path is relative to $HOME rather than to one agent's configuration
# directory, because a box may hold threads of either harness and each reads a
# layout of its own -- .claude for Claude Code, .codex and .agents for Codex.
# The orchestrator writes both and this installs whatever it wrote.
#
# The manifest is what makes the install reversible: it names every path put
# there, a copy of it is left behind in ~/.boxes/managed, and the next start
# removes exactly those before installing again. So a skill deleted in the
# dashboard disappears from the box, while anything the agent itself put in its
# home is never touched.
AGENT_SRC=/boxes/agent
HOME_DIR="${HOME:-/home/agent}"
MANAGED="$HOME_DIR/.boxes/managed"

# A manifest line has to be one relative path in one of the layouts above and
# nothing else. The file is written by the orchestrator, but it decides what
# gets deleted and its root is now the whole home, so it is checked rather than
# trusted -- against a list written here rather than one the manifest carries,
# which would be the same thing as trusting it.
#
# Two components at least, and a known prefix: a line reading `.claude` or
# `.ssh` names a directory that is not this mechanism's to remove, and is
# refused rather than quietly turned into a recursive delete.
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
    # cp -R onto an existing directory would nest inside it rather than
    # replace it, so the destination goes first. A managed name wins over
    # anything already sitting under it.
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

# --- the browser CLI ---------------------------------------------------------
# Three things the CLI cannot work out for itself.
#
# First, where the browsers are. The image keeps them at BOXES_IMAGE_BROWSERS,
# which is read-only in a box; PLAYWRIGHT_BROWSERS_PATH points instead at a
# directory in the home, which is writable and which Playwright therefore
# treats as somewhere it may install. Linking the image's builds into it is
# what lets both be true at once: the browser the image already carries
# resolves without being copied, and a project downloading a revision of its
# own lands beside the links.
#
# Every start, rather than once when the home was filled. A home is copied out
# of the image at box creation and never refreshed, so links written then
# would name whichever revision that image carried, and an image rebuilt onto a
# newer Playwright would leave every one of them dangling. Relinking against
# the image that is running is what keeps a long-lived box working across
# an upgrade, and the sweep below is what clears out what the upgrade orphaned.
#
# Only links are swept. A real directory here is a browser some project
# downloaded, which this must not remove.
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

# Its global config, at ~/.playwright/cli.config.json, carries which browser to
# use and the launch options a box container needs; the image ships that
# much, and the only piece missing at build time is the egress proxy, which is
# added here. Written on every start rather than once, so a corrected base
# config reaches a box whose home already exists. A project's own
# .playwright/cli.config.json still overrides all of it.
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

# What the CLI's own skill cannot say, because it is written for Playwright
# anywhere rather than for this image: which browsers are already here, which
# are a download away, and which command to reach for.
#
# Written for whoever is in the box rather than for whoever runs the
# deployment. An agent that does
# not know Chromium is already linked reaches for `npx playwright install`,
# which is the one form that still costs something: npx never consults PATH, so
# it downloads a second copy of the tool before discovering there is nothing to
# do.
#
# Appended rather than shipped as a skill of our own: this is a paragraph about
# an existing skill's subject, and a second skill covering the same ground is
# how an agent ends up reading only one of them. Appended only in the branch
# that installed the image's copy, so a box that supplies its own
# playwright-cli skill keeps exactly what the dashboard showed. The marker
# keeps it to one copy if the install ever preserves the file instead of
# rewriting it.
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

# The same skill, where the other harness looks for it. The CLI writes one copy
# and knows only ~/.claude/skills; Codex reads ~/.agents/skills and nothing
# under ~/.claude, so the box gets the browser instructions in one thread and
# not the other unless the copy is made here. After the notes are appended, so
# that both copies carry them.
copy_skill_to_agents() {
  src=/home/agent/.claude/skills/playwright-cli
  dst=/home/agent/.agents/skills/playwright-cli
  [ -d "$src" ] || return 0
  mkdir -p /home/agent/.agents/skills || {
    log "WARNING: could not create ~/.agents/skills; Codex will not see the browser skill"
    return 0
  }
  # The destination goes first, for the reason install_agent_config gives:
  # cp -R onto a directory that is already there nests inside it.
  rm -rf -- "$dst"
  if cp -R -- "$src" "$dst"; then
    log "copied the playwright-cli skill into ~/.agents/skills"
  else
    log "WARNING: could not copy the playwright-cli skill into ~/.agents/skills"
  fi
}

# And its skill, which the CLI installs itself. --global puts it in
# ~/.claude/skills rather than in the workspace, which is a git checkout that
# is none of our business. Re-run every start so the copy in the box's home
# follows the image rather than being frozen at whatever the home was filled
# with when the box was created.
#
# Runs after install_agent_config, and defers to it: a skill of this name in
# the box's merged set is the one the box gets. The dashboard showed that
# version as the effective one, so installing the image's copy over the top
# would be exactly the silent override the editor's merged view exists to
# prevent. This is the same direction the merge itself runs -- the more
# specific configuration wins -- with the image as the least specific layer of
# all. The image's copy fills the name in only while nothing has claimed it,
# and install_agent_config replaces it the moment something does.
#
# One layout is enough to ask: the orchestrator writes a configured skill into
# every harness's, so a set claiming this name claims it everywhere.
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
# glab reads GITLAB_TOKEN and GITLAB_HOST from the environment, so nothing has
# to be logged in; git is pointed at glab's credential helper for that one
# host, which is what `gh auth setup-git` does for GitHub.
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
