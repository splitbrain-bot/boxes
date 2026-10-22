#!/usr/bin/env bash
# Security smoke test.
#
# Run on the Docker host after docker compose up -d. Creates throwaway
# boxes through the API, checks the isolation properties from inside one of
# their containers, then cleans up.
#
#   API_BASE=http://localhost:3000 ./tests/smoke-test.sh
#
# API_USER and API_PASS add HTTP basic auth to every API call.
#
# The token translation checks run only for credentials the script gets. It
# stores each one in the deployment with a PUT to /api/credentials before it
# creates a box:
#
#   PROFILE_DEFAULT_GH_TOKEN=ghp_...
#   PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
#   PROFILE_DEFAULT_OPENAI_API_KEY=sk-...
#
# Without the OpenAI key, the script skips the Codex checks.
#
# The allowlist checks read EGRESS_ALLOWED_HOSTS from the running
# orchestrator. With no allowlist, they run only the allowed probe.
#
# Optional:
#   SMOKE_BOT_FORK=<url>       a repository the bot must be able to reach
#   SMOKE_CLAUDE=1             run one real claude -p call
#   SMOKE_UPSTREAM_REPO=<url>  an upstream the bot must not push to
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
CURL_AUTH=()
if [ -n "${API_USER:-}" ]; then CURL_AUTH=(-u "${API_USER}:${API_PASS:-}"); fi

pass=0; fail=0; noted=0

# green, red and grey print their arguments as one line in that colour on stdout.
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[90m%s\033[0m\n' "$*"; }

# Sends one API request with the optional basic auth. The arguments go to curl.
# Prints the response body on stdout and exits with the status of curl.
api() { curl -sS "${CURL_AUTH[@]}" "$@"; }

# Asserts that a command in the box container fails. $1 is the description,
# and the other arguments are the command. Prints the result and counts it.
must_fail() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    red   "FAIL (succeeded but must not): $desc"; fail=$((fail+1))
  else
    green "ok   (correctly denied):       $desc"; pass=$((pass+1))
  fi
}

# Asserts that a command in the box container succeeds. $1 is the description,
# and the other arguments are the command. Prints the result and counts it. On
# failure, it also prints the last line of the output of the command.
must_pass() {
  local desc="$1"; shift
  local out
  if out=$(docker exec -u agent "$CONTAINER" "$@" 2>&1); then
    green "ok   (allowed as intended):    $desc"; pass=$((pass+1))
  else
    red   "FAIL (denied but must work):  $desc"; fail=$((fail+1))
    grey  "     $(printf '%s' "$out" | tail -n 1 | head -c 200)"
  fi
}

# Logs if a command in the box container succeeds, for an accepted property.
# $1 is the description, and the other arguments are the command. Counts a
# note, and never counts a failure.
note() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    grey "note (reachable, accepted):    $desc"
  else
    grey "note (not reachable):          $desc"
  fi
  noted=$((noted+1))
}

# Asserts that a string is not in the environment of any process in the box
# container, and not in a file in /workspace or /home/agent. $1 is the
# description, and $2 is the string. An empty string skips the check. The
# string is the real credential, so the function never prints it.
absent_from_box() {
  local desc="$1" needle="$2"
  if [ -z "$needle" ]; then return; fi
  local found=0
  docker exec "$CONTAINER" env 2>/dev/null | grep -qF -- "$needle" && found=1
  docker exec "$CONTAINER" sh -c \
    'cat /proc/*/environ 2>/dev/null | tr "\0" "\n"' 2>/dev/null \
    | grep -qF -- "$needle" && found=1
  docker exec "$CONTAINER" sh -c \
    'grep -rlF -- "$0" /workspace /home/agent 2>/dev/null | head -1' "$needle" \
    2>/dev/null | grep -q . && found=1
  if [ "$found" -eq 1 ]; then
    red   "FAIL (real credential present): $desc"; fail=$((fail+1))
  else
    green "ok   (no real credential):      $desc"; pass=$((pass+1))
  fi
}

# Runs a command in the box container and asserts that its output matches a
# pattern. $1 is the description, $2 is the extended regular expression, and
# the other arguments are the command. Prints the result and counts it.
must_output() {
  local desc="$1" pattern="$2"; shift 2
  local out
  out=$(docker exec -u agent "$CONTAINER" "$@" 2>&1)
  if printf '%s' "$out" | grep -Eq "$pattern"; then
    green "ok   (as intended):             $desc"; pass=$((pass+1))
  else
    red   "FAIL (unexpected output):     $desc"; fail=$((fail+1))
    grey  "     wanted /$pattern/, got: $(printf '%s' "$out" | head -c 200 | tr '\n' ' ')"
  fi
}

# Deletes the boxes that BOX_ID and SIBLING_ID name. Takes no arguments.
cleanup() {
  if [ -n "${BOX_ID:-}" ]; then
    grey "cleaning up box $BOX_ID"
    api -X DELETE "$API_BASE/api/boxes/$BOX_ID" >/dev/null || true
  fi
  if [ -n "${SIBLING_ID:-}" ]; then
    api -X DELETE "$API_BASE/api/boxes/$SIBLING_ID" >/dev/null || true
  fi
}
trap cleanup EXIT

# The real credentials this run seeds into the deployment.
REAL_GH="${PROFILE_DEFAULT_GH_TOKEN:-}"
REAL_CLAUDE="${PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN:-}"
REAL_OPENAI="${PROFILE_DEFAULT_OPENAI_API_KEY:-}"

# Stores one credential in the deployment. $1 is the credential id, and $2 is
# the secret. An empty secret skips the credential. $3 is the method that the
# settings page records for the secret, api_key for a pasted API key and token
# for a pasted token. Exits the script with status 1 if the deployment refuses
# the credential.
seed_credential() {
  local id="$1" secret="$2" method="${3:-token}"
  [ -z "$secret" ] && return 0
  if api -f -X PUT "$API_BASE/api/credentials/$id" \
       -H 'Content-Type: application/json' \
       -d "$(jq -n --arg m "$method" --arg s "$secret" '{method:$m,secret:$s}')" >/dev/null; then
    grey "seeded the $id credential"
  else
    red "could not seed the $id credential"; exit 1
  fi
}

echo "== seeding the deployment's credentials =="
if [ -z "$REAL_GH" ] && [ -z "$REAL_CLAUDE" ] && [ -z "$REAL_OPENAI" ]; then
  grey "none passed: the translation checks below will be skipped"
else
  seed_credential github "$REAL_GH"
  seed_credential claude "$REAL_CLAUDE"
  seed_credential openai "$REAL_OPENAI" api_key
fi

echo
echo "== creating throwaway boxes =="
BOX_ID=$(api -X POST "$API_BASE/api/boxes" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test"}' | jq -r '.id')
[ -n "$BOX_ID" ] && [ "$BOX_ID" != "null" ] || { red "could not create box"; exit 1; }

SIBLING_ID=$(api -X POST "$API_BASE/api/boxes" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test-sibling"}' | jq -r '.id')

CONTAINER="box-$BOX_ID"
SIBLING_CONTAINER="box-$SIBLING_ID"
SIBLING_IP=$(docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SIBLING_CONTAINER" 2>/dev/null)
grey "box=$BOX_ID sibling=$SIBLING_ID sibling_ip=${SIBLING_IP:-unknown}"

echo
echo "== both harnesses in one box =="
# The create request above names no harness, so the orchestrator gave each box
# a first thread on the default harness, Claude. The script adds a Codex thread.
if [ -z "$REAL_OPENAI" ]; then
  grey "skipped: no OpenAI key was passed, so a Codex thread could not run a turn"
  noted=$((noted+1))
else
  ADDED_HARNESS=$(api -X POST "$API_BASE/api/boxes/$BOX_ID/threads" \
    -H 'Content-Type: application/json' \
    -d '{"options":{"harness":"codex"}}' | jq -r '.harness')
  if [ "$ADDED_HARNESS" = "codex" ]; then
    green "ok   (a Codex thread was added):  the box now holds one of each"; pass=$((pass+1))
  else
    red   "FAIL (no Codex thread):        the box would not take one"; fail=$((fail+1))
  fi
  HARNESSES=$(api "$API_BASE/api/boxes/$BOX_ID/threads" | jq -r '[.[].harness] | sort | unique | join(",")')
  if [ "$HARNESSES" = "claude,codex" ]; then
    green "ok   (two harnesses, one box):   $HARNESSES"; pass=$((pass+1))
  else
    red   "FAIL (harnesses in the box):   wanted claude,codex, got ${HARNESSES:-none}"; fail=$((fail+1))
  fi
  # /healthz reports Codex runnable when the stored OpenAI credential has the
  # status ok and the orchestrator can deliver it to a box.
  if api "$API_BASE/healthz" | jq -e '.harnesses[] | select(.id=="codex") | .runnable' >/dev/null; then
    green "ok   (Codex is runnable):        /healthz says the key works"; pass=$((pass+1))
  else
    red   "FAIL (Codex is not runnable):  /healthz says it has no usable credential"; fail=$((fail+1))
  fi
fi

echo
echo "== MUST FAIL: direct (proxy-bypassing) egress =="
# The box network is internal, so it has no NAT and no default route.
must_fail "curl --noproxy '*' https://api.github.com" \
  curl --noproxy '*' -fsS -m 3 https://api.github.com
must_fail "nc -w3 1.1.1.1 443" \
  nc -w3 -z 1.1.1.1 443

echo
echo "== MUST FAIL: private space via the proxy (resolved-IP vetting) =="
must_fail "curl http://192.168.1.1" \
  curl -fsS -m 3 http://192.168.1.1
must_fail "curl http://10.0.0.1" \
  curl -fsS -m 3 http://10.0.0.1
must_fail "curl http://169.254.169.254 (cloud metadata)" \
  curl -fsS -m 3 http://169.254.169.254/latest/meta-data/
# localtest.me is a public hostname with the A record 127.0.0.1.
must_fail "curl http://localtest.me (hostname -> private IP)" \
  curl -fsS -m 3 http://localtest.me
must_fail "curl http://[::ffff:192.168.1.1] (v4-mapped bypass)" \
  curl -fsS -m 3 'http://[::ffff:192.168.1.1]'

echo
echo "== MUST FAIL: cross-box reachability =="
if [ -n "${SIBLING_IP:-}" ]; then
  must_fail "nc -w3 <sibling> 22 (distinct internal networks)" \
    nc -w3 -z "$SIBLING_IP" 22
  must_fail "curl http://<sibling>:8080 via proxy" \
    curl -fsS -m 3 "http://$SIBLING_IP:8080"
else
  grey "skipped: sibling IP unavailable"
fi

echo
echo "== MUST FAIL: host and container escapes =="
must_fail "ls /var/run/docker.sock" \
  ls /var/run/docker.sock
must_fail "touch /usr/local/bin/x (read-only rootfs)" \
  touch /usr/local/bin/x

echo
echo "== MUST SUCCEED: intended egress and writes (via injected proxy env) =="
# No -f: GitHub answers an unauthenticated call with 403 or 429 when the
# runner's shared address is over its rate limit, and an error status is
# still the host answering through the proxy.
must_pass "curl https://api.github.com" \
  curl -sS -m 15 -o /dev/null https://api.github.com
must_pass "write to /workspace" \
  sh -c 'echo ok > /workspace/.smoke && rm /workspace/.smoke'
must_pass "write to /home/agent" \
  sh -c 'echo ok > /home/agent/.smoke && rm /home/agent/.smoke'
must_pass "write to /nix" \
  sh -c 'echo ok > /nix/.smoke && rm /nix/.smoke'
must_pass "nix --version" \
  nix --version
must_pass "opencode --version" \
  opencode --version
must_pass "write to /tmp (tmpfs)" \
  sh -c 'echo ok > /tmp/.smoke && rm /tmp/.smoke'

if [ -n "${SMOKE_BOT_FORK:-}" ]; then
  must_pass "git ls-remote \$SMOKE_BOT_FORK" \
    git ls-remote "$SMOKE_BOT_FORK"
fi
if [ "${SMOKE_CLAUDE:-0}" = "1" ]; then
  # The call costs a real inference, so it runs only on request.
  must_pass "claude -p 'reply ok' (subscription auth)" \
    claude -p 'reply ok'
fi

if [ -n "${SMOKE_UPSTREAM_REPO:-}" ]; then
  echo
  echo "== MUST FAIL: pushing to an upstream default branch =="
  # The bot has read access to upstreams and works on forks, so the upstream
  # must refuse a push. The clone goes to the tmpfs, and the workspace of the
  # agent stays unchanged. A failed clone counts as a failure, because the push
  # test needs a clone.
  if docker exec -u agent "$CONTAINER" sh -c \
       'rm -rf /tmp/upstream && git clone --depth 1 "$0" /tmp/upstream' \
       "$SMOKE_UPSTREAM_REPO" >/dev/null 2>&1; then
    must_fail "git push origin HEAD to \$SMOKE_UPSTREAM_REPO" \
      sh -c 'cd /tmp/upstream &&
             git commit --allow-empty -m "smoke test" >/dev/null &&
             git push origin HEAD'
  else
    red "FAIL: could not clone \$SMOKE_UPSTREAM_REPO to test the push guard"
    fail=$((fail+1))
  fi
fi

echo
echo "== pids limit containment =="
# PidsLimit must contain a fork bomb, so the sibling box continues to work. The
# children of the bomb stay in the process group of the exec, so one kill ends
# the bomb.
docker exec -u agent "$CONTAINER" bash -c \
  'bomb() { bomb | bomb & }; bomb & sleep 5; kill -9 0' >/dev/null 2>&1
if docker exec -u agent "$SIBLING_CONTAINER" true >/dev/null 2>&1; then
  green "ok   (sibling unaffected):      fork bomb contained by pids-limit"; pass=$((pass+1))
else
  red   "FAIL: sibling box affected by fork bomb"; fail=$((fail+1))
fi

# The bombed box itself must be usable again once the bomb is gone.
recovered=0
for _ in $(seq 1 15); do
  if docker exec -u agent "$CONTAINER" true >/dev/null 2>&1; then recovered=1; break; fi
  sleep 2
done
if [ "$recovered" -eq 1 ]; then
  green "ok   (box survived):        the bombed box answers again"; pass=$((pass+1))
else
  red   "FAIL: the bombed box stays out of processes"; fail=$((fail+1))
fi

echo
echo "== workspace storage: a directory on the data volume, bound in =="
# The agent must be able to write to its workspace, and one box must not see
# the workspace of another. The parent directory must have mode 0700.
must_pass "the agent can write to its bound workspace" \
  sh -c 'echo ok > /workspace/.smoke-ws && rm /workspace/.smoke-ws'

WS_SOURCE=$(docker inspect -f \
  '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Type}} {{.Source}}{{end}}{{end}}' \
  "$CONTAINER" 2>/dev/null)
case "$WS_SOURCE" in
  "bind "*/workspaces/"$BOX_ID")
    green "ok   /workspace is a bind of the box's own directory"; pass=$((pass+1)) ;;
  *)
    red   "FAIL: /workspace is not a bind of workspaces/\$BOX_ID: ${WS_SOURCE:-none}"
    fail=$((fail+1)) ;;
esac

# A file that the agent writes appears in the data volume of the orchestrator
# container.
docker exec -u agent "$CONTAINER" sh -c 'echo from-the-agent > /workspace/.smoke-seen' \
  >/dev/null 2>&1
if docker exec boxes-orchestrator \
     sh -c 'cat "/data/workspaces/'"$BOX_ID"'/.smoke-seen"' 2>/dev/null \
     | grep -q from-the-agent; then
  green "ok   the orchestrator reads the agent's file directly"; pass=$((pass+1))
else
  red   "FAIL: the orchestrator cannot read the agent's workspace file"; fail=$((fail+1))
fi
docker exec -u agent "$CONTAINER" rm -f /workspace/.smoke-seen >/dev/null 2>&1

# Mode 0700 on the parent, so on the data volume only the owner can read across
# boxes.
WS_MODE=$(docker exec boxes-orchestrator stat -c '%a' /data/workspaces 2>/dev/null)
if [ "$WS_MODE" = "700" ]; then
  green "ok   workspaces/ on the data volume is 0700"; pass=$((pass+1))
else
  red   "FAIL: workspaces/ is ${WS_MODE:-unknown}, must be 700"; fail=$((fail+1))
fi

# One box's workspace is not mounted into another, and the sibling's
# directory is not reachable from inside this one.
if [ -n "${SIBLING_ID:-}" ]; then
  docker exec -u agent "$SIBLING_CONTAINER" \
    sh -c 'echo sibling > /workspace/.smoke-sibling' >/dev/null 2>&1
  must_fail "the sibling's workspace file is not visible" \
    sh -c 'test -f /workspace/.smoke-sibling'
  must_fail "the data volume is not reachable from a box" \
    sh -c 'ls /data'
  docker exec -u agent "$SIBLING_CONTAINER" rm -f /workspace/.smoke-sibling \
    >/dev/null 2>&1
fi

echo
echo "== documented-but-accepted residual surface =="
# A container on a Docker internal network can still reach the gateway address
# of the network, which is an address of the host. The risk is accepted, so the
# script only logs the result.
HOST_BRIDGE_IP=$(docker network inspect "bn-$BOX_ID" \
  -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
if [ -n "$HOST_BRIDGE_IP" ]; then
  note "host per-bridge IP $HOST_BRIDGE_IP:22" nc -w3 -z "$HOST_BRIDGE_IP" 22
fi

echo
echo "== token translation: the box holds placeholders, not credentials =="
if [ -z "$REAL_GH" ] && [ -z "$REAL_CLAUDE" ] && [ -z "$REAL_OPENAI" ]; then
  grey "skipped: no credential was seeded, so this deployment translates none"
else
  absent_from_box "GH_TOKEN is nowhere in the box" "$REAL_GH"
  absent_from_box "CLAUDE_CODE_OAUTH_TOKEN is nowhere in the box" "$REAL_CLAUDE"
  absent_from_box "CODEX_API_KEY is nowhere in the box" "$REAL_OPENAI"

  if [ -n "$REAL_GH" ]; then
    # The placeholder authenticates as the bot only if the proxy swapped it.
    must_output "curl api.github.com/user with the placeholder is the bot" '"login"' \
      sh -c 'curl -fsS -m 15 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
    # The proxy sends a value without a placeholder unchanged, so the error comes from GitHub.
    must_output "an invented GitHub token reaches GitHub unchanged" 'Bad credentials' \
      sh -c 'curl -sS -m 15 -H "Authorization: Bearer ghp_notTheDeploymentsToken" https://api.github.com/user'
  fi
  if [ -n "$REAL_CLAUDE" ]; then
    must_output "an invented Anthropic token reaches Anthropic unchanged" '"type": ?"error"' \
      sh -c 'curl -sS -m 15 -H "Authorization: Bearer sk-ant-oat01-notTheDeploymentsToken" https://api.anthropic.com/v1/messages'
  fi
  if [ -n "$REAL_OPENAI" ]; then
    # An answer from OpenAI proves the proxy swapped the placeholder.
    must_output "the OpenAI placeholder is swapped and OpenAI answers" '"object"' \
      sh -c 'curl -sS -m 15 -H "Authorization: Bearer $CODEX_API_KEY" https://api.openai.com/v1/models'
    must_output "an invented OpenAI key reaches OpenAI unchanged" 'invalid_api_key' \
      sh -c 'curl -sS -m 15 -H "Authorization: Bearer sk-notTheDeploymentsKey" https://api.openai.com/v1/models'
    # The proxy never intercepts the host where Codex logs in.
    must_output "the login host presents its own certificate chain" 'issuer:' \
      sh -c 'curl -sS -m 15 -v https://auth.openai.com/ 2>&1 | grep -i "issuer:" | grep -v "Boxes egress proxy CA"'
  fi

  # The deployment CA appears for a translated host and for no other host. The
  # proxy translates only the hosts of the seeded credentials, so the probe
  # goes to one of those.
  if [ -n "$REAL_GH" ]; then
    INJECTION_HOST=api.github.com
  elif [ -n "$REAL_CLAUDE" ]; then
    INJECTION_HOST=api.anthropic.com
  else
    INJECTION_HOST=api.openai.com
  fi
  must_output "an injection host presents the deployment CA" 'Boxes egress proxy CA' \
    sh -c "curl -sS -m 15 -v https://$INJECTION_HOST/ 2>&1 | grep -i 'issuer:'"
  must_output "a passthrough host presents its own certificate chain" 'issuer:' \
    sh -c 'curl -sS -m 15 -v https://registry.npmjs.org/ 2>&1 | grep -i "issuer:" | grep -v "Boxes egress proxy CA"'
fi

echo
echo "== egress allowlist =="
ALLOWLIST=$(docker exec boxes-orchestrator printenv EGRESS_ALLOWED_HOSTS 2>/dev/null || true)
if [ -z "$ALLOWLIST" ]; then
  # Unset allows any public host, and private ranges stay denied.
  must_pass "allowlist unset: https://example.com is reachable" \
    curl -fsS -m 15 https://example.com
  grey "note (allowlist off):          set EGRESS_ALLOWED_HOSTS to exercise the deny probes"
  noted=$((noted+1))
else
  grey "allowlist: $ALLOWLIST"
  must_fail "an unlisted host is denied" \
    curl -fsS -m 15 https://example.com
  must_fail "an unlisted address literal is denied" \
    curl -fsS -m 15 https://1.1.1.1
  must_pass "a listed host is still reachable" \
    curl -fsS -m 15 https://registry.npmjs.org/
  # A narrow allowlist must never sever the credential hosts. No -f, as
  # above: a rate limited 403 is still GitHub answering.
  must_pass "a credential host is implied by the allowlist" \
    curl -sS -m 15 -o /dev/null https://api.github.com
  if [ -n "$REAL_OPENAI" ]; then
    # No -f: an unauthenticated call to OpenAI is a 401, which is the host
    # answering. The check fails only when the proxy refuses the CONNECT.
    must_pass "the OpenAI key host is implied by the allowlist" \
      curl -sS -m 15 -o /dev/null https://api.openai.com/v1/models
    # Codex logs in at this host. The alsoAllow list of the OpenAI credential
    # keeps it reachable with a narrow allowlist.
    must_pass "Codex's login host comes with the OpenAI credential" \
      curl -sS -m 15 -o /dev/null https://auth.openai.com/
  fi
fi

echo
echo "== egress policy is live in the proxy =="
if api "$API_BASE/healthz" | jq -e '.egress.inSync == true' >/dev/null; then
  green "ok   proxy is running the policy the orchestrator composed"; pass=$((pass+1))
elif api "$API_BASE/healthz" | jq -e '.egress == null' >/dev/null; then
  grey "note (no policy pushed yet):   /healthz reports no egress state"
  noted=$((noted+1))
else
  red   "FAIL: the proxy is not running the composed policy"; fail=$((fail+1))
  api "$API_BASE/healthz" | jq -c '.egress' | sed 's/^/     /'
fi

echo
echo "== proxy attachment =="
if api "$API_BASE/api/boxes/$BOX_ID" | jq -e '.isolated' >/dev/null; then
  green "ok   proxy attached to box network"; pass=$((pass+1))
else
  red   "FAIL: egress proxy is not attached to the box network"; fail=$((fail+1))
fi

echo
echo "=================================="
echo "passed: $pass   failed: $fail   noted: $noted"
[ "$fail" -eq 0 ] || exit 1
green "smoke test green"
