#!/usr/bin/env bash
# End-to-end verification of the egress proxy, the allowlist and the token
# translation on a real Docker deployment.
#
# Builds the three images, brings the stack up on its own env file, runs the
# checks, and takes the stack down again. It never reads or writes the .env
# file in the repository.
#
#   PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... ./scripts/verify.sh
#
# The Claude token pays for the real inference turns. Without it, the run
# skips those checks and says so.
#
# The script stores each token it gets in the deployment with a PUT to
# /api/credentials once the stack is up.
#
# Optional:
#   PROFILE_DEFAULT_GH_TOKEN=ghp_...  a real PAT; a fake one is used otherwise,
#                                     which still exercises interception
#   PROFILE_DEFAULT_OPENAI_API_KEY=sk-...  what a Codex thread runs on. Without
#                                     one, every Codex check below is skipped
#   PROFILE_DEFAULT_GITLAB_TOKEN=glpat-...  a real PAT; a fake one is used
#                                     otherwise, as for GitHub
#   PROFILE_DEFAULT_GITLAB_HOST=gitlab.example.com  a self-managed instance to
#                                     run the GitLab checks against instead of
#                                     gitlab.com
#   SKIP_BUILD=1                      reuse the images already built
#   SKIP_UNIT=1                       skip the three vitest suites
#   SKIP_SUITES=1                     skip smoke-test.sh and live-test.sh
#   SKIP_RESTART=1                    skip the restart phase (~2 min)
#   KEEP_UP=1                         leave the stack running at the end
#   HOST_PORT=3000                    port the stack is published on
#
# Needs: docker with compose v2, curl, jq, node 22+, openssl.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

HOST_PORT="${HOST_PORT:-3000}"
API_BASE="http://127.0.0.1:${HOST_PORT}"
COMPOSE=(docker compose -f "$REPO/compose.yaml")
REAL_CLAUDE="${PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN:-}"
REAL_GH="${PROFILE_DEFAULT_GH_TOKEN:-}"
REAL_OPENAI="${PROFILE_DEFAULT_OPENAI_API_KEY:-}"
GITLAB_HOST="${PROFILE_DEFAULT_GITLAB_HOST:-gitlab.com}"
REAL_GITLAB="${PROFILE_DEFAULT_GITLAB_TOKEN:-}"

# The proxy swaps a fake PAT in like a real one, and GitHub rejects it. A
# foreign token gets a refusal from the proxy instead.
GH_IS_FAKE=0
if [ -z "$REAL_GH" ]; then
  REAL_GH="ghp_verifyFake$(openssl rand -hex 12)"
  GH_IS_FAKE=1
fi

# The same for GitLab.
GITLAB_IS_FAKE=0
if [ -z "$REAL_GITLAB" ]; then
  REAL_GITLAB="glpat-verifyFake$(openssl rand -hex 12)"
  GITLAB_IS_FAKE=1
fi

ALLOWLIST='github.com,*.github.com,*.githubusercontent.com,api.anthropic.com,api.openai.com,registry.npmjs.org'

# ---------------------------------------------------------------- reporting --

pass=0; fail=0; skip=0; note=0
FAILED_IDS=()

# Prints the arguments in colour, or as a phase heading.
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[90m%s\033[0m\n' "$*"; }
head1() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# Filters stdin to stdout and replaces every real credential with a label.
redact() {
  sed -e "s|$REAL_GH|<GH_TOKEN>|g" \
      ${REAL_CLAUDE:+-e "s|$REAL_CLAUDE|<CLAUDE_TOKEN>|g"} \
      ${REAL_OPENAI:+-e "s|$REAL_OPENAI|<OPENAI_KEY>|g"} \
      ${REAL_GITLAB:+-e "s|$REAL_GITLAB|<GITLAB_TOKEN>|g"}
}

# Filters stdin to stdout without colour escapes.
uncolour() { sed -e 's/\x1b\[[0-9;]*m//g'; }

# Records one outcome: $1 is the check id, $2 the description.
ok()      { green "PASS $1  $2"; pass=$((pass+1)); }
bad()     { red   "FAIL $1  $2"; fail=$((fail+1)); FAILED_IDS+=("$1"); }
skipped() { grey  "SKIP $1  $2"; skip=$((skip+1)); }
noted()   { grey  "NOTE $1  $2"; note=$((note+1)); }

# Prints the evidence behind a failure, capped and redacted.
why() { printf '%s\n' "$1" | head -c 700 | redact | sed 's/^/          | /'; }

# Runs a command; PASS when it succeeds.
must() {
  local id="$1" desc="$2" out; shift 2
  if out=$("$@" 2>&1); then ok "$id" "$desc"; else bad "$id" "$desc"; why "$out"; fi
}

# Runs a command; PASS when it fails.
mustnot() {
  local id="$1" desc="$2" out; shift 2
  if out=$("$@" 2>&1); then bad "$id" "$desc (succeeded but must not)"; why "$out"; else ok "$id" "$desc"; fi
}

# Runs a command; PASS when its combined output matches an extended regex.
matches() {
  local id="$1" desc="$2" pattern="$3" out; shift 3
  out=$("$@" 2>&1)
  if printf '%s' "$out" | grep -Eqi -- "$pattern"; then
    ok "$id" "$desc"
  else
    bad "$id" "$desc"; grey "          | wanted /$pattern/"; why "$out"
  fi
}

# Runs a command; PASS when its combined output does NOT match.
lacks() {
  local id="$1" desc="$2" pattern="$3" out; shift 3
  out=$("$@" 2>&1)
  if printf '%s' "$out" | grep -Eqi -- "$pattern"; then
    bad "$id" "$desc"; grey "          | must not match /$pattern/"; why "$out"
  else
    ok "$id" "$desc"
  fi
}

# Runs a command (sx) or a login shell script (sxs) as the agent in the box.
sx()  { docker exec -u agent "$CONTAINER" "$@"; }
sxs() { docker exec -u agent "$CONTAINER" bash -lc "$1"; }

# ----------------------------------------------------------------- preflight --

head1 "preflight"
for tool in docker curl jq node openssl; do
  command -v "$tool" >/dev/null 2>&1 || { red "missing required tool: $tool"; exit 1; }
done
docker compose version >/dev/null 2>&1 || { red "docker compose v2 is required"; exit 1; }
docker info >/dev/null 2>&1 || { red "cannot talk to the Docker daemon"; exit 1; }
grey "node $(node --version), docker compose $(docker compose version --short)"

[ -z "$REAL_CLAUDE" ] && \
  grey "PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN is unset: the inference checks will be skipped"
[ -z "$REAL_OPENAI" ] && \
  grey "PROFILE_DEFAULT_OPENAI_API_KEY is unset: the Codex checks will be skipped"
[ "$GH_IS_FAKE" = 1 ] && \
  grey "PROFILE_DEFAULT_GH_TOKEN is unset: using a fake PAT, which still exercises interception"

if curl -fsS -m 2 "$API_BASE/healthz" >/dev/null 2>&1; then
  red "something already answers on $API_BASE - stop it, or set HOST_PORT to a free port"
  exit 1
fi

ENV_FILE="$(mktemp -t boxes-verify-env.XXXXXX)"
LOG_DIR="$(mktemp -d -t boxes-verify-logs.XXXXXX)"
chmod 600 "$ENV_FILE"
# Writes this run's env file, with $1 as the egress allowlist.
write_env() {
  cat > "$ENV_FILE" <<ENV
EGRESS_ALLOWED_HOSTS=$1
GITLAB_HOST=$GITLAB_HOST
IDLE_STOP_MINUTES=60
BOX_IMAGE=boxes-box:latest
BOX_IMAGE_PULL_MINUTES=0
ENV
}
write_env "$ALLOWLIST"

# Runs docker compose with this run's env file, port and bind address.
up() { BOXES_ENV="$ENV_FILE" HOST_PORT="$HOST_PORT" BIND_ADDR=127.0.0.1 "${COMPOSE[@]}" "$@"; }

BOX_ID=""
CONTAINER=""
CFG_BOX=""
OVR_BOX=""
STACK_UP=0

# Prints the recent log lines of the proxy and the orchestrator, redacted.
dump_logs() {
  head1 "container logs (tail)"
  for c in boxes-egress-proxy boxes-orchestrator; do
    grey "--- $c ---"
    docker logs --tail 60 "$c" 2>&1 | redact | sed 's/^/  /'
  done
}

# Deletes the boxes this run created and takes the stack down, unless KEEP_UP=1.
cleanup() {
  local status=$? id
  for id in "$BOX_ID" "$CFG_BOX" "$OVR_BOX"; do
    [ -n "$id" ] && [ "$id" != null ] && \
      curl -sS -m 15 -X DELETE "$API_BASE/api/boxes/$id" >/dev/null 2>&1
  done
  if [ "$STACK_UP" = 1 ]; then
    if [ "${KEEP_UP:-0}" = 1 ]; then
      grey "leaving the stack up on $API_BASE (KEEP_UP=1); take it down with: docker compose down"
    else
      grey "taking the stack down"
      up down >/dev/null 2>&1
    fi
  fi
  rm -f "$ENV_FILE"
  rm -rf "$LOG_DIR"
  exit $status
}
trap cleanup EXIT INT TERM

# Waits for the API to answer at all.
wait_health() {
  local i
  for i in $(seq 1 60); do
    curl -fsS -m 3 "$API_BASE/healthz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Waits for the orchestrator to report the proxy is running its policy.
wait_insync() {
  local i
  for i in $(seq 1 "${1:-35}"); do
    curl -fsS -m 5 "$API_BASE/healthz" | jq -e '.egress.inSync == true' >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

# Asserts a string appears nowhere in a box's environment, workspace or
# home. The needle is a real credential, so it is never printed.
absent() {
  local id="$1" desc="$2" needle="$3" hits
  [ -z "$needle" ] && { skipped "$id" "$desc (not configured)"; return; }
  hits=0
  docker exec "$CONTAINER" env 2>/dev/null | grep -qF -- "$needle" && hits=1
  docker exec "$CONTAINER" sh -c 'cat /proc/*/environ 2>/dev/null | tr "\0" "\n"' 2>/dev/null \
    | grep -qF -- "$needle" && hits=1
  docker exec "$CONTAINER" sh -c 'grep -rlF -- "$0" /workspace /home/agent 2>/dev/null | head -1' \
    "$needle" 2>/dev/null | grep -q . && hits=1
  if [ "$hits" = 1 ]; then bad "$id" "$desc"; else ok "$id" "$desc"; fi
}

# Asserts that no real GitHub, GitLab, Claude or OpenAI credential is in a
# container's log.
absent_from_log() {
  local id="$1" desc="$2" container="$3" hits=0
  docker logs "$container" 2>&1 | grep -qF -- "$REAL_GH" && hits=1
  docker logs "$container" 2>&1 | grep -qF -- "$REAL_GITLAB" && hits=1
  [ -n "$REAL_CLAUDE" ] && docker logs "$container" 2>&1 | grep -qF -- "$REAL_CLAUDE" && hits=1
  [ -n "$REAL_OPENAI" ] && docker logs "$container" 2>&1 | grep -qF -- "$REAL_OPENAI" && hits=1
  if [ "$hits" = 1 ]; then bad "$id" "$desc"; else ok "$id" "$desc"; fi
}

# ---------------------------------------------------------------- unit suites --

if [ "${SKIP_UNIT:-0}" != 1 ]; then
  head1 "unit suites"
  # Runs in the build's node image, with node_modules on a throwaway volume.
  # better-sqlite3 needs its install script, which npm on a host may refuse
  # to run, and the checkout stays untouched.
  for pkg in proxy orchestrator dashboard; do
    # This image has no Chromium for the dashboard's e2e project. Run npm test
    # in dashboard/ for that half.
    project=''
    [ "$pkg" = dashboard ] && project='-- --project unit'
    out=$(docker run --rm \
            -v "$REPO:/repo" -v "/repo/$pkg/node_modules" \
            -w "/repo/$pkg" node:26-bookworm \
            sh -c "npm ci --no-audit --no-fund >/dev/null 2>&1 && npm test $project" 2>&1)
    if [ $? -eq 0 ]; then
      ok "unit-$pkg" "$(printf '%s' "$out" | uncolour | grep -Eo 'Tests +[0-9]+ passed.*' | tail -1)"
    else
      bad "unit-$pkg" "vitest failed"
      printf '%s\n' "$out" | uncolour | grep -E '×|FAIL |Tests ' | head -20 | sed 's/^/          | /'
    fi
  done
fi

# --------------------------------------------------------------------- build --

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  head1 "building images"
  if docker build -q -t boxes-box:latest "$REPO/box-image/" > "$LOG_DIR/box.log" 2>&1; then
    ok "build-box" "boxes-box:latest"
  else
    bad "build-box" "box image build failed"
    tail -20 "$LOG_DIR/box.log" | sed 's/^/          | /'
  fi
  if up build > "$LOG_DIR/compose-build.log" 2>&1; then
    ok "build-compose" "orchestrator and egress-proxy images"
  else
    bad "build-compose" "compose build failed"
    tail -30 "$LOG_DIR/compose-build.log" | sed 's/^/          | /'
    exit 1
  fi
fi

# ----------------------------------------------------------------------- up ---

head1 "bringing the stack up"
if up up -d > "$LOG_DIR/up.log" 2>&1; then
  STACK_UP=1; ok "up" "docker compose up -d"
else
  bad "up" "docker compose up failed"; tail -30 "$LOG_DIR/up.log" | sed 's/^/          | /'; exit 1
fi
if wait_health; then ok "health" "/healthz answers on $API_BASE"
else bad "health" "/healthz never answered"; dump_logs; exit 1; fi

# Stores one credential in the deployment. The data volume keeps it across
# the restarts below. $3 is how the settings page would record the secret:
# api_key for a pasted OpenAI key, token for the rest.
seed_credential() {
  local id="$1" secret="$2" method="${3:-token}"
  [ -z "$secret" ] && { skipped "seed-$id" "not configured"; return; }
  if curl -fsS -m 15 -X PUT "$API_BASE/api/credentials/$id" \
       -H 'Content-Type: application/json' \
       -d "$(jq -n --arg m "$method" --arg s "$secret" '{method:$m,secret:$s}')" >/dev/null 2>&1; then
    ok "seed-$id" "the $id credential is stored"
  else
    bad "seed-$id" "the deployment refused the $id credential"
  fi
}
seed_credential github "$REAL_GH"
seed_credential gitlab "$REAL_GITLAB"
seed_credential claude "$REAL_CLAUDE"
seed_credential openai "$REAL_OPENAI" api_key

# ------------------------------------------------------------ A. the policy ---

head1 "A. the policy the proxy is running"

# The first push can lose a race with the proxy's boot. The reconciler fixes
# that within about a minute.
if wait_insync; then ok "A1" "/healthz reports the proxy is running the composed policy"
else bad "A1" "/healthz never reported inSync"; why "$(curl -sS -m 5 "$API_BASE/healthz" | jq -c '.egress')"; fi

matches "A2" "the allowlist is reported active" '^true$' \
  bash -c "curl -fsS -m 5 '$API_BASE/healthz' | jq -r '.egress.allowlistActive'"

# Alphabetical, because the check sorts the reported ids.
WANT_CREDS="github gitlab"
[ -n "$REAL_CLAUDE" ] && WANT_CREDS="claude $WANT_CREDS"
[ -n "$REAL_OPENAI" ] && WANT_CREDS="$WANT_CREDS openai"
matches "A3" "the proxy holds exactly the stored credentials ($WANT_CREDS)" "^$WANT_CREDS\$" \
  bash -c "curl -fsS -m 5 '$API_BASE/healthz' | jq -r '.egress.credentialIds | sort | join(\" \")'"

matches "A4" "the proxy logged the policy it applied" 'applied policy' \
  bash -c "docker logs boxes-egress-proxy 2>&1 | grep -F 'applied policy' | tail -1"

matches "A5" "the control channel bound to the compose network, not loopback" 'control channel listening' \
  bash -c "docker logs boxes-egress-proxy 2>&1 | grep -F 'control channel listening' | tail -1"
lacks "A6" "the control channel did not fall back to loopback" 'could not resolve the control interface' \
  bash -c "docker logs boxes-egress-proxy 2>&1"

absent_from_log "A7" "no real credential appears in the proxy log" boxes-egress-proxy
absent_from_log "A8" "no real credential appears in the orchestrator log" boxes-orchestrator

matches "A9" "the stored egress material is owner-only" '^600$' \
  docker exec boxes-orchestrator stat -c '%a' /data/egress-secrets.json

# ----------------------------------------------------------- B. the box ---

head1 "B. a box, and what it holds"

BOX_ID=$(curl -sS -m 60 -X POST "$API_BASE/api/boxes" \
  -H 'Content-Type: application/json' -d '{"name":"verify"}' | jq -r '.id')
if [ -z "$BOX_ID" ] || [ "$BOX_ID" = null ]; then
  bad "B0" "could not create a box"; dump_logs; exit 1
fi
CONTAINER="box-$BOX_ID"
ok "B0" "box $BOX_ID created"

ready=0
for _ in $(seq 1 40); do
  docker exec "$CONTAINER" test -f /home/agent/.boxes/proxy-ca.crt >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
if [ "$ready" = 1 ]; then ok "B1" "the entrypoint wrote the CA to /home/agent/.boxes/proxy-ca.crt"
else bad "B1" "the CA file never appeared"; why "$(docker logs "$CONTAINER" 2>&1 | tail -20)"; fi

matches "B2" "the CA file is the deployment CA" 'Boxes egress proxy CA' \
  sx openssl x509 -in /home/agent/.boxes/proxy-ca.crt -noout -subject

matches "B3" "the CA file is exactly what BOXES_PROXY_CA carried" '^same$' \
  sxs 'if [ "$(cat /home/agent/.boxes/proxy-ca.crt)" = "$(printf "%s\n" "$BOXES_PROXY_CA")" ]; then echo same; else echo differs; fi'

# Codex reads CODEX_CA_CERTIFICATE before SSL_CERT_FILE. Every box gets it.
for var in NODE_EXTRA_CA_CERTS SSL_CERT_FILE GIT_SSL_CAINFO CURL_CA_BUNDLE CODEX_CA_CERTIFICATE; do
  matches "B4-$var" "$var points at the CA file" '^/home/agent/\.boxes/proxy-ca\.crt$' \
    sx printenv "$var"
done

# A box holds a placeholder for every credential, stored or not, because its
# environment is fixed at creation and a later token must still reach it.
matches "B5" "the box holds a Claude-shaped value" '^sk-ant-oat01-' \
  sx printenv CLAUDE_CODE_OAUTH_TOKEN
if [ -n "$REAL_CLAUDE" ]; then
  lacks "B6" "that value is not the deployment's own token" "^$(printf '%s' "$REAL_CLAUDE" | sed 's/[][\.*^$+?(){}|/]/\\&/g')\$" \
    sx printenv CLAUDE_CODE_OAUTH_TOKEN
else
  skipped "B6" "no Claude token was passed to compare against"
fi
matches "B7" "the box holds a GitHub-shaped value" '^ghp_' \
  sx printenv GH_TOKEN
# The Codex side: the key placeholder, the login request, the start mode,
# CODEX_HOME and the provider setting.
matches "B7a" "the box holds an OpenAI-shaped value" '^sk-' \
  sx printenv CODEX_API_KEY
matches "B7b" "the adapter is told to log in with it" '^\{"methodId":"api-key"\}$' \
  sx printenv DEFAULT_AUTH_REQUEST
matches "B7c" "a fresh Codex thread starts in full access" '^agent-full-access$' \
  sx printenv INITIAL_AGENT_MODE
matches "B7d" "Codex's own state directory exists before it starts" '^ok$' \
  sxs 'test -d "$CODEX_HOME" && echo ok'
matches "B7f" "Codex is told to skip the WebSocket transport" '^ok$' \
  sxs 'grep -q "^supports_websockets = false" /etc/codex/config.toml && echo ok'
if [ -n "$REAL_OPENAI" ]; then
  lacks "B7e" "that value is not the deployment's own key" "^$(printf '%s' "$REAL_OPENAI" | sed 's/[][\.*^$+?(){}|/]/\\&/g')\$" \
    sx printenv CODEX_API_KEY
else
  skipped "B7e" "no OpenAI key was passed to compare against"
fi
lacks "B8" "that value is not the deployment's own PAT" "^$(printf '%s' "$REAL_GH" | sed 's/[][\.*^$+?(){}|/]/\\&/g')\$" \
  sx printenv GH_TOKEN

absent "B9"  "the real Claude token is nowhere in the box" "$REAL_CLAUDE"
absent "B10" "the real GitHub token is nowhere in the box" "$REAL_GH"
absent "B10a" "the real OpenAI key is nowhere in the box" "$REAL_OPENAI"
absent "B10b" "the real GitLab token is nowhere in the box" "$REAL_GITLAB"

matches "B11" "the proxy is attached to the box network" '^true$' \
  bash -c "curl -fsS -m 5 '$API_BASE/api/boxes/$BOX_ID' | jq -r '.proxyAttached'"

# A Codex thread beside the Claude one, in the same box.
if [ -z "$REAL_OPENAI" ]; then
  skipped "B11a" "no OpenAI key, so a Codex thread could not run"
  skipped "B11b" "no OpenAI key, so a Codex thread could not run"
else
  matches "B11a" "the box takes a Codex thread beside its Claude one" '^codex$' \
    bash -c "curl -fsS -m 30 -X POST '$API_BASE/api/boxes/$BOX_ID/threads' \
      -H 'Content-Type: application/json' -d '{\"options\":{\"harness\":\"codex\"}}' | jq -r '.harness'"
  matches "B11b" "and /healthz says a Codex thread can run a turn" '^true$' \
    bash -c "curl -fsS -m 5 '$API_BASE/healthz' | jq -r '.harnesses[] | select(.id==\"codex\") | .runnable'"
fi

# ------------------------------------------------- B2. agent configuration ---

head1 "B2. an agent set reaches the box that named it"

# Unit tests cover the merge rule. This phase proves the bind mount and the
# entrypoint's copy on a real deployment.

# Sends one API request: $1 is the method, $2 the path, $3 an optional JSON
# body.
api() {
  local method="$1" path="$2" body="${3:-}" args=()
  [ -n "$body" ] && args=(-H 'Content-Type: application/json' -d "$body")
  curl -sS -m 30 -X "$method" "$API_BASE$path" "${args[@]}"
}

# The global AGENTS.md belongs to the operator, so it is saved and restored.
GLOBAL_AGENTS_MD=$(api GET /api/agent-sets/global | jq -r '.agentsMd // ""')
api PATCH /api/agent-sets/global '{"agentsMd":"Verify: the house rules."}' >/dev/null
api PUT /api/agent-sets/global/items \
  '{"kind":"command","name":"housecmd","content":"the global command"}' >/dev/null
SET_ID=$(api POST /api/agent-sets '{"name":"verify set"}' | jq -r '.id')
api PUT "/api/agent-sets/$SET_ID/items" \
  '{"kind":"skill","name":"verifyskill","content":"---\nname: verifyskill\ndescription: x\n---\n"}' \
  >/dev/null

CFG_BOX=$(curl -sS -m 60 -X POST "$API_BASE/api/boxes" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-agents\",\"agentSet\":\"$SET_ID\"}" | jq -r '.id')
if [ -z "$CFG_BOX" ] || [ "$CFG_BOX" = null ]; then
  bad "B12" "could not create a box against an agent set"
  for id in B13 B14 B15 B16 B17 B18; do skipped "$id" "no box to inspect"; done
else
  CFG_CONTAINER="box-$CFG_BOX"
  installed=0
  for _ in $(seq 1 40); do
    docker exec "$CFG_CONTAINER" test -f /home/agent/.boxes/managed >/dev/null 2>&1 \
      && { installed=1; break; }
    sleep 1
  done
  if [ "$installed" = 1 ]; then ok "B12" "the entrypoint installed the merged set under \$HOME"
  else bad "B12" "nothing was installed"; why "$(docker logs "$CFG_CONTAINER" 2>&1 | tail -20)"; fi

  matches "B13" "the AGENTS.md landed as the agent's own memory" 'Verify: the house rules' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.claude/CLAUDE.md
  matches "B14" "the global set's command came along" 'the global command' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.claude/commands/housecmd.md
  matches "B15" "the named set's skill is there too" 'name: verifyskill' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.claude/skills/verifyskill/SKILL.md
  # Both layouts, because neither agent reads the other's directories.
  matches "B15a" "the AGENTS.md landed where Codex reads it too" 'Verify: the house rules' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.codex/AGENTS.md
  matches "B15b" "the command is a Codex prompt as well" 'the global command' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.codex/prompts/housecmd.md
  matches "B15c" "the skill is in the harness-neutral skills directory" 'name: verifyskill' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.agents/skills/verifyskill/SKILL.md
  # The agent must not rewrite the configuration the dashboard shows.
  mustnot "B16" "the mounted configuration is not writable from inside the box" \
    docker exec -u agent "$CFG_CONTAINER" sh -c 'echo x > /boxes/agent/manifest'

  # No set claims the name, so the box gets the image's own browser skill.
  matches "B17" "a skill the image ships is installed when no set claims its name" \
    'name: playwright-cli' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.claude/skills/playwright-cli/SKILL.md
  matches "B17a" "and Codex gets its copy of that skill too" 'name: playwright-cli' \
    docker exec -u agent "$CFG_CONTAINER" cat /home/agent/.agents/skills/playwright-cli/SKILL.md

  curl -sS -m 30 -X DELETE "$API_BASE/api/boxes/$CFG_BOX" >/dev/null 2>&1

  # A set that claims the name wins, because the editor shows that version
  # as the effective one.
  api PUT "/api/agent-sets/$SET_ID/items" \
    '{"kind":"skill","name":"playwright-cli","content":"---\nname: playwright-cli\ndescription: y\n---\nthe set overrides the image\n"}' \
    >/dev/null
  OVR_BOX=$(curl -sS -m 60 -X POST "$API_BASE/api/boxes" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"verify-agents-override\",\"agentSet\":\"$SET_ID\"}" | jq -r '.id')
  if [ -z "$OVR_BOX" ] || [ "$OVR_BOX" = null ]; then
    skipped "B18" "could not create the overriding box"
  else
    OVR_CONTAINER="box-$OVR_BOX"
    for _ in $(seq 1 40); do
      docker exec "$OVR_CONTAINER" test -f /home/agent/.boxes/managed >/dev/null 2>&1 \
        && break
      sleep 1
    done
    matches "B18" "a set's skill of the same name beats the image's" \
      'the set overrides the image' \
      docker exec -u agent "$OVR_CONTAINER" cat /home/agent/.claude/skills/playwright-cli/SKILL.md
    matches "B18a" "in both layouts" 'the set overrides the image' \
      docker exec -u agent "$OVR_CONTAINER" cat /home/agent/.agents/skills/playwright-cli/SKILL.md
    curl -sS -m 30 -X DELETE "$API_BASE/api/boxes/$OVR_BOX" >/dev/null 2>&1
  fi
fi
[ -n "${SET_ID:-}" ] && [ "$SET_ID" != null ] && \
  curl -sS -m 15 -X DELETE "$API_BASE/api/agent-sets/$SET_ID" >/dev/null 2>&1
api PATCH /api/agent-sets/global \
  "$(jq -n --arg md "$GLOBAL_AGENTS_MD" '{agentsMd:$md}')" >/dev/null
curl -sS -m 15 -X DELETE "$API_BASE/api/agent-sets/global/items?kind=command&name=housecmd" \
  >/dev/null 2>&1

# --------------------------------------------------------------- C. TLS trust --

head1 "C. TLS trust, both sides of the boundary"

matches "C1" "an intercepted host presents the deployment CA" 'Boxes egress proxy CA' \
  sxs 'curl -sS -m 25 -o /dev/null -v https://api.github.com/ 2>&1 | grep -i "issuer:"'

matches "C2" "a passthrough host presents its own chain, not ours" 'issuer:' \
  sxs 'curl -sS -m 25 -o /dev/null -v https://registry.npmjs.org/ 2>&1 | grep -i "issuer:" | grep -vi "Boxes egress proxy CA"'

must "C3" "curl reaches a passthrough host, so public CAs still verify" \
  sxs 'curl -fsS -m 25 -o /dev/null https://registry.npmjs.org/'
# Opens the CONNECT tunnel by hand, because node ignores HTTP_PROXY. The test
# is of node's trust store, which NODE_EXTRA_CA_CERTS extends and the ACP
# adapter depends on.
NODE_TLS_PROBE='node -e '"'"'
const http=require("http"),tls=require("tls");
const host=process.argv[1];
const req=http.request({host:"proxy",port:3128,method:"CONNECT",path:host+":443"});
req.on("connect",(res,socket)=>{
  if(res.statusCode!==200){console.error("CONNECT "+res.statusCode);process.exit(1);}
  const s=tls.connect({socket,servername:host},()=>{
    const issuer=(s.getPeerCertificate().issuer||{}).CN;
    console.log(host,s.authorized?"authorized":"UNAUTHORIZED "+s.authorizationError,"| issuer:",issuer);
    s.destroy();process.exit(s.authorized?0:1);
  });
  s.on("error",e=>{console.error(e.message);process.exit(1);});
});
req.on("error",e=>{console.error(e.message);process.exit(1);});
req.end();'"'"' '

matches "C4" "node trusts the deployment CA on an intercepted host" 'authorized \| issuer: Boxes egress proxy CA' \
  sxs "$NODE_TLS_PROBE api.github.com"
matches "C5" "node still trusts the public chain on a passthrough host" 'authorized \| issuer:' \
  sxs "$NODE_TLS_PROBE registry.npmjs.org"
must "C6" "git speaks to an intercepted host" \
  sxs 'git ls-remote --heads https://github.com/git/git.git >/dev/null'
must "C7" "npm resolves a package through the proxy" \
  sxs 'npm view --silent semver version >/dev/null'

# ------------------------------------------------------------ D. translation --

head1 "D. token translation on the wire"

if [ -n "$REAL_CLAUDE" ]; then
  matches "D1" "an invented Anthropic credential is refused by the proxy" 'egress denied' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer sk-ant-oat01-notThisDeployments" https://api.anthropic.com/v1/messages'
else
  skipped "D1" "api.anthropic.com is not intercepted without a Claude token"
fi

matches "D2" "an invented GitHub credential is refused by the proxy" 'egress denied' \
  sxs 'curl -sS -m 25 -H "Authorization: Bearer ghp_notThisDeploymentsToken" https://api.github.com/user'

# The proxy swaps credentials but does not require one.
matches "D3" "an unauthenticated request still reaches the intercepted host" 'current_user_url' \
  sxs 'curl -sS -m 25 https://api.github.com/'

if [ "$GH_IS_FAKE" = 1 ]; then
  # An answer from GitHub proves the proxy swapped and forwarded the
  # placeholder. The proxy refuses a foreign credential itself.
  matches "D4" "the placeholder is swapped and GitHub answers (fake PAT, so 401)" 'Bad credentials|"login"' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
  skipped "D5" "gh api user needs a real PAT"
else
  matches "D4" "the placeholder authenticates as the bot at api.github.com" '"login"' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
  matches "D5" "gh authenticates with the placeholder" '"login"' \
    sxs 'gh api user'
fi

matches "D6" "an invented GitLab credential is refused by the proxy" 'egress denied' \
  sxs "curl -sS -m 25 -H 'PRIVATE-TOKEN: glpat-notThisDeploymentsToken' https://$GITLAB_HOST/api/v4/user"

# An answer from the instance proves the proxy swapped and forwarded the
# placeholder.
if [ "$GITLAB_IS_FAKE" = 1 ]; then
  matches "D7" "the GitLab placeholder is swapped and $GITLAB_HOST answers (fake PAT, so 401)" '401|"username"' \
    sxs "curl -sS -m 25 -H \"PRIVATE-TOKEN: \$GITLAB_TOKEN\" https://$GITLAB_HOST/api/v4/user"
  skipped "D8" "glab api user needs a real PAT"
else
  matches "D7" "the GitLab placeholder authenticates at $GITLAB_HOST" '"username"' \
    sxs "curl -sS -m 25 -H \"PRIVATE-TOKEN: \$GITLAB_TOKEN\" https://$GITLAB_HOST/api/v4/user"
  matches "D8" "glab authenticates with the placeholder" '"username"' \
    sxs 'glab api user'
fi

if [ -n "$REAL_OPENAI" ]; then
  # An answer from OpenAI proves the proxy swapped the placeholder.
  matches "D2a" "the OpenAI placeholder is swapped and OpenAI answers" '"object"' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer $CODEX_API_KEY" https://api.openai.com/v1/models'
  matches "D2b" "an invented OpenAI key is refused by the proxy" 'egress denied' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer sk-notThisDeployments" https://api.openai.com/v1/models'
  matches "D2c" "api.openai.com presents the deployment CA" 'Boxes egress proxy CA' \
    sxs 'curl -sS -m 25 -o /dev/null -v https://api.openai.com/v1/models 2>&1 | grep -i "issuer:"'
  # Codex logs in at auth.openai.com, and a subscription uses chatgpt.com
  # with a credential this deployment does not hold. Neither is intercepted.
  lacks "D2d" "Codex's login host is not intercepted" 'Boxes egress proxy CA' \
    sxs 'curl -sS -m 25 -o /dev/null -v https://auth.openai.com/ 2>&1 | grep -i "issuer:"'
  lacks "D2e" "the subscription endpoint is not intercepted" 'Boxes egress proxy CA' \
    sxs 'curl -sS -m 25 -o /dev/null -v https://chatgpt.com/ 2>&1 | grep -i "issuer:"'
else
  for id in D2a D2b D2c D2d D2e; do skipped "$id" "no OpenAI key configured"; done
fi

# git sends its credential as Basic auth after a 401. The proxy must swap it
# there too, so the refusal must not come from the proxy.
lacks "D9" "git's Basic-auth framing is swapped, not refused by the proxy" 'egress denied|error: 403' \
  sxs 'git ls-remote https://github.com/boxes-verify/no-such-repo.git 2>&1 | head -3'

if [ -n "$REAL_CLAUDE" ]; then
  # The Claude credential may also travel in x-api-key.
  lacks "D10" "the placeholder is swapped in x-api-key too, not refused" 'egress denied' \
    sxs 'curl -sS -m 25 -H "x-api-key: $CLAUDE_CODE_OAUTH_TOKEN" https://api.anthropic.com/v1/messages'
  # One host's placeholder is a foreign credential at another host.
  matches "D11" "a placeholder for another host is refused" 'egress denied' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer $GH_TOKEN" https://api.anthropic.com/v1/messages'
else
  skipped "D10" "api.anthropic.com is not intercepted without a Claude token"
  skipped "D11" "api.anthropic.com is not intercepted without a Claude token"
fi

# ------------------------------------------------------------- E. allowlist ---

head1 "E. the egress allowlist"
grey "allowlist: $ALLOWLIST"

mustnot "E1" "an unlisted host is denied" \
  sxs 'curl -fsS -m 25 -o /dev/null https://example.com'
mustnot "E2" "an unlisted address literal is denied" \
  sxs 'curl -fsS -m 25 -o /dev/null https://1.1.1.1'
must "E3" "a listed host is reachable" \
  sxs 'curl -fsS -m 25 -o /dev/null https://registry.npmjs.org/'
must "E4" "a credential host is implied by the allowlist" \
  sxs 'curl -fsS -m 25 -o /dev/null https://api.github.com'
if [ -n "$REAL_CLAUDE" ]; then
  matches "E5" "an alsoAllow host is reachable, so an OAuth refresh still works" '^[2345][0-9][0-9]$' \
    sxs 'curl -sS -m 25 -o /dev/null -w "%{http_code}" https://console.anthropic.com/'
else
  skipped "E5" "alsoAllow hosts come with the Claude credential"
fi
if [ -n "$REAL_OPENAI" ]; then
  # The OpenAI credential's alsoAllow hosts stay reachable under a narrow
  # allowlist.
  matches "E5a" "Codex's login host comes with the OpenAI credential" '^[2345][0-9][0-9]$' \
    sxs 'curl -sS -m 25 -o /dev/null -w "%{http_code}" https://auth.openai.com/'
  matches "E5b" "the subscription endpoint comes with it too" '^[2345][0-9][0-9]$' \
    sxs 'curl -sS -m 25 -o /dev/null -w "%{http_code}" https://chatgpt.com/'
  # No credential implies the telemetry host, so a narrow list refuses it.
  mustnot "E5c" "Codex's telemetry host is not implied by the credential" \
    sxs 'curl -fsS -m 15 -o /dev/null https://ab.chatgpt.com/'
else
  for id in E5a E5b E5c; do skipped "$id" "alsoAllow hosts come with the OpenAI credential"; done
fi
mustnot "E6" "a credential host may not be reached in the clear" \
  sxs 'curl -fsS -m 25 -o /dev/null http://api.github.com/'
mustnot "E7" "private space is still denied" \
  sxs 'curl -fsS -m 8 -o /dev/null http://192.168.1.1'
mustnot "E8" "cloud metadata is still denied" \
  sxs 'curl -fsS -m 8 -o /dev/null http://169.254.169.254/latest/meta-data/'
mustnot "E9" "a public name that resolves into private space is denied" \
  sxs 'curl -fsS -m 8 -o /dev/null http://localtest.me'

# -------------------------------------------------------- F. control channel --

head1 "F. the control channel is out of a box's reach"

PROXY_BOX_IP=$(docker inspect \
  -f "{{with index .NetworkSettings.Networks \"bn-$BOX_ID\"}}{{.IPAddress}}{{end}}" \
  boxes-egress-proxy 2>/dev/null)
if [ -n "$PROXY_BOX_IP" ]; then
  grey "the proxy is $PROXY_BOX_IP on this box's network"
  mustnot "F1" "the control port is closed on the box network" \
    sx nc -w5 -z "$PROXY_BOX_IP" 3129
else
  skipped "F1" "could not read the proxy's address on the box network"
fi
mustnot "F2" "the control port is closed on the proxy alias" \
  sx nc -w5 -z proxy 3129
mustnot "F3" "the proxy will not forward a box to its own control port" \
  sxs 'curl -fsS -m 8 -o /dev/null http://proxy:3129/status'
matches "F4" "the control channel refuses a wrong bearer" '^401$' \
  docker exec boxes-orchestrator node -e \
    'fetch("http://boxes-egress-proxy:3129/status",{headers:{authorization:"Bearer wrong"}}).then(r=>console.log(r.status)).catch(e=>console.log(e.message))'

# The compose network is an ordinary bridge, so the host can address the
# proxy directly.
PROXY_COMPOSE_IP=$(docker inspect \
  -f '{{with index .NetworkSettings.Networks "boxes_default"}}{{.IPAddress}}{{end}}' \
  boxes-egress-proxy 2>/dev/null)
if [ -n "$PROXY_COMPOSE_IP" ]; then
  matches "F5" "the control channel refuses an unclaimed bearer from the host" '^401$' \
    bash -c "curl -sS -m 5 -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer someone-else' http://$PROXY_COMPOSE_IP:3129/status"
  if curl -fsS -m 10 -o /dev/null -x "http://$PROXY_COMPOSE_IP:3128" https://api.github.com/ 2>/dev/null; then
    noted "F6" "the front door at $PROXY_COMPOSE_IP:3128 is an open proxy for anything on this host"
  else
    ok "F6" "the front door is not usable from the host"
  fi
else
  skipped "F5" "could not read the proxy's address on the compose network"
  skipped "F6" "could not read the proxy's address on the compose network"
fi

# ----------------------------------------------------------- G. a real turn ---

head1 "G. a real agent turn through the translation"

# Runs one real claude -p turn and prints the hosts the proxy refused during
# it. Phase I repeats the turn without an allowlist, which tells a too narrow
# list from a broken translation.
turn() {
  local id="$1" desc="$2" before after
  before=$(docker logs boxes-egress-proxy 2>&1 | wc -l)
  matches "$id" "$desc" 'ok' \
    bash -c "timeout 300 docker exec -u agent '$CONTAINER' claude -p 'reply with the word ok and nothing else' 2>&1 | tail -5"
  after=$(docker logs boxes-egress-proxy 2>&1 | tail -n "+$((before + 1))" \
    | grep -F '"denied' | jq -r '.host // empty' 2>/dev/null | sort -u | tr '\n' ' ')
  [ -n "$after" ] && grey "          | the proxy refused these while the turn ran: $after"
}

if [ -z "$REAL_CLAUDE" ]; then
  skipped "G1" "no Claude token configured"
  skipped "G2" "no Claude token configured"
else
  turn "G1" "claude -p answers, on a placeholder the proxy swapped"
  absent "G2" "the real Claude token is still nowhere in the box after a turn" "$REAL_CLAUDE"
fi

# ------------------------------------------------------------- H. restarts ----

if [ "${SKIP_RESTART:-0}" = 1 ]; then
  head1 "H. restart resilience (skipped)"
  for id in H1 H2 H3 H4 H5; do skipped "$id" "SKIP_RESTART=1"; done
else
  head1 "H. what a restart does to the policy"

  docker restart boxes-egress-proxy >/dev/null 2>&1
  sleep 6
  # The proxy stores nothing, so right after a restart it runs the empty
  # policy until the orchestrator pushes again. This records that window.
  if sxs 'curl -fsS -m 15 -o /dev/null https://example.com' >/dev/null 2>&1; then
    noted "H1" "straight after a proxy restart the allowlist is OFF: an unlisted host is reachable"
  else
    ok "H1" "the allowlist survived a proxy restart"
  fi

  back=0
  for _ in $(seq 1 45); do
    if wait_insync 1 && ! sxs 'curl -fsS -m 15 -o /dev/null https://example.com' >/dev/null 2>&1; then
      back=1; break
    fi
    sleep 2
  done
  if [ "$back" = 1 ]; then ok "H2" "the reconciler re-pushed the policy after the proxy restart"
  else bad "H2" "the policy was never re-pushed after the proxy restart"; why "$(curl -sS "$API_BASE/healthz" | jq -c '.egress')"; fi

  matches "H3" "interception works again after the restart" 'Boxes egress proxy CA' \
    sxs 'curl -sS -m 25 -o /dev/null -v https://api.github.com/ 2>&1 | grep -i "issuer:"'

  # A running box trusts the CA, so the CA must survive the restart.
  CA_BEFORE=$(docker exec boxes-orchestrator sha256sum /data/egress-secrets.json 2>/dev/null | cut -d' ' -f1)
  docker restart boxes-orchestrator >/dev/null 2>&1
  wait_health
  CA_AFTER=$(docker exec boxes-orchestrator sha256sum /data/egress-secrets.json 2>/dev/null | cut -d' ' -f1)
  if [ -n "$CA_BEFORE" ] && [ "$CA_BEFORE" = "$CA_AFTER" ]; then
    ok "H4" "the CA and the placeholders survived an orchestrator restart"
  else
    bad "H4" "the egress material changed across an orchestrator restart"
  fi
  wait_insync
  matches "H5" "the running box still trusts the CA after both restarts" 'Boxes egress proxy CA' \
    sxs 'curl -sS -m 25 -o /dev/null -v https://api.github.com/ 2>&1 | grep -i "issuer:"'
fi

# ------------------------------------------------- I. the allowlist is live ---

head1 "I. turning the allowlist off is a live push"

write_env ""
if up up -d --no-deps --force-recreate orchestrator >/dev/null 2>&1 && wait_health; then
  off=0
  for _ in $(seq 1 25); do
    sxs 'curl -fsS -m 15 -o /dev/null https://example.com' >/dev/null 2>&1 && { off=1; break; }
    sleep 3
  done
  if [ "$off" = 1 ]; then ok "I1" "with the allowlist unset every public host is reachable again"
  else bad "I1" "the allowlist stayed on after being unset"; fi
  matches "I2" "/healthz reports the allowlist inactive" '^false$' \
    bash -c "curl -fsS -m 5 '$API_BASE/healthz' | jq -r '.egress.allowlistActive'"
  matches "I3" "interception is unaffected by the allowlist" 'Boxes egress proxy CA' \
    sxs 'curl -sS -m 25 -o /dev/null -v https://api.github.com/ 2>&1 | grep -i "issuer:"'
  mustnot "I4" "private space is denied even with no allowlist at all" \
    sxs 'curl -fsS -m 8 -o /dev/null http://192.168.1.1'
  if [ -n "$REAL_CLAUDE" ]; then
    turn "I5" "a real turn still runs with the allowlist off"
  else
    skipped "I5" "no Claude token configured"
  fi
else
  bad "I1" "could not recreate the orchestrator with the allowlist unset"
  for id in I2 I3 I4 I5; do skipped "$id" "the orchestrator did not come back"; done
fi

# The suites below run with the allowlist.
write_env "$ALLOWLIST"
up up -d --no-deps --force-recreate orchestrator >/dev/null 2>&1
wait_health
wait_insync

# ------------------------------------------------------------- the suites -----

if [ "${SKIP_SUITES:-0}" != 1 ]; then
  head1 "J. scripts/smoke-test.sh"
  if API_BASE="$API_BASE" "$REPO/scripts/smoke-test.sh" 2>&1 \
       | redact | uncolour | tee "$LOG_DIR/smoke.log" | sed 's/^/  /'; then
    ok "smoke" "smoke-test.sh green"
  elif [ "$GH_IS_FAKE" = 1 ] \
       && [ "$(grep -c '^FAIL' "$LOG_DIR/smoke.log")" = 1 ] \
       && grep -q '^FAIL.*is the bot' "$LOG_DIR/smoke.log"; then
    noted "smoke" "green apart from the one probe that needs a real PAT to authenticate"
  else
    bad "smoke" "smoke-test.sh reported failures"
    grep -E '^FAIL' "$LOG_DIR/smoke.log" | head -12 | sed 's/^/          | /'
  fi

  head1 "K. scripts/live-test.sh"
  if [ -z "$REAL_CLAUDE" ]; then
    skipped "live" "no Claude token configured"
  elif API_BASE="$API_BASE" "$REPO/scripts/live-test.sh" 2>&1 \
         | redact | uncolour | tee "$LOG_DIR/live.log" | sed 's/^/  /'; then
    ok "live" "live-test.sh green"
  else
    bad "live" "live-test.sh reported failures"
    grep -E '^FAIL' "$LOG_DIR/live.log" | head -12 | sed 's/^/          | /'
  fi
fi

# ------------------------------------------------------------------ summary ---

[ "$fail" -gt 0 ] && dump_logs

head1 "summary"
echo "passed: $pass   failed: $fail   skipped: $skip   noted: $note"
if [ "$fail" -gt 0 ]; then
  red "failing checks: ${FAILED_IDS[*]}"
  exit 1
fi
green "verification green"
