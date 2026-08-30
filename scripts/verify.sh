#!/usr/bin/env bash
# Everything about the egress proxy, the allowlist and the token translation
# that only a real Docker deployment can prove.
#
# It builds the three images, brings the stack up on an env file of its own,
# asserts, and takes the stack down again. Your own .env is never read and
# never written.
#
#   PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... ./scripts/verify.sh
#
# The Claude token is what pays for the one real inference turn. Without it
# the run still covers everything else and says which checks it skipped.
#
# Optional:
#   PROFILE_DEFAULT_GH_TOKEN=ghp_...  a real PAT; a fake one is used otherwise,
#                                     which still exercises interception
#   SKIP_BUILD=1                      reuse the images already built
#   SKIP_UNIT=1                       skip the two vitest suites
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

# A fake PAT still proves the GitHub half: it is intercepted and swapped, and
# then rejected by GitHub rather than by the proxy, which is a different answer
# from the one a foreign token gets.
GH_IS_FAKE=0
if [ -z "$REAL_GH" ]; then
  REAL_GH="ghp_verifyFake$(openssl rand -hex 12)"
  GH_IS_FAKE=1
fi

ALLOWLIST='github.com,*.github.com,*.githubusercontent.com,api.anthropic.com,registry.npmjs.org'

# ---------------------------------------------------------------- reporting --

pass=0; fail=0; skip=0; note=0
FAILED_IDS=()

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[90m%s\033[0m\n' "$*"; }
head1() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# Keeps a real credential out of anything this script prints. Both tokens are
# replaced wherever they appear, whatever produced the text.
redact() {
  sed -e "s|$REAL_GH|<GH_TOKEN>|g" \
      ${REAL_CLAUDE:+-e "s|$REAL_CLAUDE|<CLAUDE_TOKEN>|g"}
}

# Drops the escapes a coloured suite writes, so its summary can be read.
uncolour() { sed -e 's/\x1b\[[0-9;]*m//g'; }

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

# The same, run as the agent inside the session container.
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
[ "$GH_IS_FAKE" = 1 ] && \
  grey "PROFILE_DEFAULT_GH_TOKEN is unset: using a fake PAT, which still exercises interception"

if curl -fsS -m 2 "$API_BASE/healthz" >/dev/null 2>&1; then
  red "something already answers on $API_BASE - stop it, or set HOST_PORT to a free port"
  exit 1
fi

ENV_FILE="$(mktemp -t boxes-verify-env.XXXXXX)"
LOG_DIR="$(mktemp -d -t boxes-verify-logs.XXXXXX)"
chmod 600 "$ENV_FILE"
write_env() {
  cat > "$ENV_FILE" <<ENV
PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=$REAL_CLAUDE
PROFILE_DEFAULT_GH_TOKEN=$REAL_GH
EGRESS_ALLOWED_HOSTS=$1
IDLE_STOP_MINUTES=60
ENV
}
write_env "$ALLOWLIST"

# Everything compose is run with, so no invocation can forget one of them.
up() { BOXES_ENV="$ENV_FILE" HOST_PORT="$HOST_PORT" BIND_ADDR=127.0.0.1 "${COMPOSE[@]}" "$@"; }

SESSION_ID=""
CONTAINER=""
STACK_UP=0

dump_logs() {
  head1 "container logs (tail)"
  for c in boxes-egress-proxy boxes-orchestrator; do
    grey "--- $c ---"
    docker logs --tail 60 "$c" 2>&1 | redact | sed 's/^/  /'
  done
}

cleanup() {
  local status=$?
  [ -n "$SESSION_ID" ] && \
    curl -sS -m 15 -X DELETE "$API_BASE/api/sessions/$SESSION_ID" >/dev/null 2>&1
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

# Asserts a string appears nowhere in a session's environment or volumes. The
# needle is a real credential, so only its absence is ever printed.
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

# The same, against a container's log stream.
absent_from_log() {
  local id="$1" desc="$2" container="$3" hits=0
  docker logs "$container" 2>&1 | grep -qF -- "$REAL_GH" && hits=1
  [ -n "$REAL_CLAUDE" ] && docker logs "$container" 2>&1 | grep -qF -- "$REAL_CLAUDE" && hits=1
  if [ "$hits" = 1 ]; then bad "$id" "$desc"; else ok "$id" "$desc"; fi
}

# ---------------------------------------------------------------- unit suites --

if [ "${SKIP_UNIT:-0}" != 1 ]; then
  head1 "unit suites"
  # Run in the image the build uses, with node_modules on a throwaway volume.
  # better-sqlite3 needs its install script, which npm on a host may refuse to
  # run, and nothing here should write into the checkout.
  for pkg in proxy orchestrator dashboard; do
    # The dashboard's e2e project drives a real Chromium, which this image has
    # not got. Its unit project is the half that covers the stores; run the
    # whole suite with `npm test` in dashboard/ to get the browser half too.
    project=''
    [ "$pkg" = dashboard ] && project='-- --project unit'
    out=$(docker run --rm \
            -v "$REPO:/repo" -v "/repo/$pkg/node_modules" \
            -w "/repo/$pkg" node:22-bookworm \
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
  if docker build -q -t boxes-session:latest "$REPO/session-image/" > "$LOG_DIR/session.log" 2>&1; then
    ok "build-session" "boxes-session:latest"
  else
    bad "build-session" "session image build failed"
    tail -20 "$LOG_DIR/session.log" | sed 's/^/          | /'
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

# ------------------------------------------------------------ A. the policy ---

head1 "A. the policy the proxy is running"

# The first push can lose a race with the proxy's own boot, and the reconciler
# is what fixes that, so allow it the minute it is designed to take.
if wait_insync; then ok "A1" "/healthz reports the proxy is running the composed policy"
else bad "A1" "/healthz never reported inSync"; why "$(curl -sS -m 5 "$API_BASE/healthz" | jq -c '.egress')"; fi

matches "A2" "the allowlist is reported active" '^true$' \
  bash -c "curl -fsS -m 5 '$API_BASE/healthz' | jq -r '.egress.allowlistActive'"

WANT_CREDS="github"
[ -n "$REAL_CLAUDE" ] && WANT_CREDS="claude github"
matches "A3" "the proxy holds exactly the configured credentials ($WANT_CREDS)" "^$WANT_CREDS\$" \
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

# ----------------------------------------------------------- B. the session ---

head1 "B. a session, and what it holds"

SESSION_ID=$(curl -sS -m 60 -X POST "$API_BASE/api/sessions" \
  -H 'Content-Type: application/json' -d '{"name":"verify"}' | jq -r '.id')
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = null ]; then
  bad "B0" "could not create a session"; dump_logs; exit 1
fi
CONTAINER="session-$SESSION_ID"
ok "B0" "session $SESSION_ID created"

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

for var in NODE_EXTRA_CA_CERTS SSL_CERT_FILE GIT_SSL_CAINFO CURL_CA_BUNDLE; do
  matches "B4-$var" "$var points at the CA file" '^/home/agent/\.boxes/proxy-ca\.crt$' \
    sx printenv "$var"
done

if [ -n "$REAL_CLAUDE" ]; then
  matches "B5" "the session holds a Claude-shaped value" '^sk-ant-oat01-' \
    sx printenv CLAUDE_CODE_OAUTH_TOKEN
  lacks "B6" "that value is not the deployment's own token" "^$(printf '%s' "$REAL_CLAUDE" | sed 's/[][\.*^$+?(){}|/]/\\&/g')\$" \
    sx printenv CLAUDE_CODE_OAUTH_TOKEN
else
  skipped "B5" "no Claude token configured"
  skipped "B6" "no Claude token configured"
fi
matches "B7" "the session holds a GitHub-shaped value" '^ghp_' \
  sx printenv GH_TOKEN
lacks "B8" "that value is not the deployment's own PAT" "^$(printf '%s' "$REAL_GH" | sed 's/[][\.*^$+?(){}|/]/\\&/g')\$" \
  sx printenv GH_TOKEN

absent "B9"  "the real Claude token is nowhere in the session" "$REAL_CLAUDE"
absent "B10" "the real GitHub token is nowhere in the session" "$REAL_GH"

matches "B11" "the proxy is attached to the session network" '^true$' \
  bash -c "curl -fsS -m 5 '$API_BASE/api/sessions/$SESSION_ID' | jq -r '.proxyAttached'"

# --------------------------------------------------------------- C. TLS trust --

head1 "C. TLS trust, both sides of the boundary"

matches "C1" "an intercepted host presents the deployment CA" 'Boxes egress proxy CA' \
  sxs 'curl -sS -m 25 -o /dev/null -v https://api.github.com/ 2>&1 | grep -i "issuer:"'

matches "C2" "a passthrough host presents its own chain, not ours" 'issuer:' \
  sxs 'curl -sS -m 25 -o /dev/null -v https://registry.npmjs.org/ 2>&1 | grep -i "issuer:" | grep -vi "Boxes egress proxy CA"'

must "C3" "curl reaches a passthrough host, so public CAs still verify" \
  sxs 'curl -fsS -m 25 -o /dev/null https://registry.npmjs.org/'
# Node's own fetch ignores HTTP_PROXY, so this drives the tunnel by hand: it is
# node's trust store that is under test, which is what NODE_EXTRA_CA_CERTS sets
# and what the ACP adapter depends on.
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

# The proxy authenticates; it does not require authentication.
matches "D3" "an unauthenticated request still reaches the intercepted host" 'current_user_url' \
  sxs 'curl -sS -m 25 https://api.github.com/'

if [ "$GH_IS_FAKE" = 1 ]; then
  # GitHub answering at all is the proof: the placeholder was swapped and
  # forwarded, rather than refused here as a foreign credential would be.
  matches "D4" "the placeholder is swapped and GitHub answers (fake PAT, so 401)" 'Bad credentials|"login"' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
  skipped "D5" "gh api user needs a real PAT"
else
  matches "D4" "the placeholder authenticates as the bot at api.github.com" '"login"' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
  matches "D5" "gh authenticates with the placeholder" '"login"' \
    sxs 'gh api user'
fi

# git offers its credential only after a 401, and sends it as Basic. The proxy
# must swap that framing rather than read it as a foreign credential, so what
# matters is that the refusal never comes from the proxy.
lacks "D6" "git's Basic-auth framing is swapped, not refused by the proxy" 'egress denied|error: 403' \
  sxs 'git ls-remote https://github.com/boxes-verify/no-such-repo.git 2>&1 | head -3'

if [ -n "$REAL_CLAUDE" ]; then
  # x-api-key is the second header the Claude credential may travel in, so the
  # placeholder must be swapped there too rather than read as foreign.
  lacks "D7" "the placeholder is swapped in x-api-key too, not refused" 'egress denied' \
    sxs 'curl -sS -m 25 -H "x-api-key: $CLAUDE_CODE_OAUTH_TOKEN" https://api.anthropic.com/v1/messages'
  # One host's placeholder is a foreign credential at another host.
  matches "D8" "a placeholder for another host is refused" 'egress denied' \
    sxs 'curl -sS -m 25 -H "Authorization: Bearer $GH_TOKEN" https://api.anthropic.com/v1/messages'
else
  skipped "D7" "api.anthropic.com is not intercepted without a Claude token"
  skipped "D8" "api.anthropic.com is not intercepted without a Claude token"
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
mustnot "E6" "a credential host may not be reached in the clear" \
  sxs 'curl -fsS -m 25 -o /dev/null http://api.github.com/'
mustnot "E7" "private space is still denied" \
  sxs 'curl -fsS -m 8 -o /dev/null http://192.168.1.1'
mustnot "E8" "cloud metadata is still denied" \
  sxs 'curl -fsS -m 8 -o /dev/null http://169.254.169.254/latest/meta-data/'
mustnot "E9" "a public name that resolves into private space is denied" \
  sxs 'curl -fsS -m 8 -o /dev/null http://localtest.me'

# -------------------------------------------------------- F. control channel --

head1 "F. the control channel is out of a session's reach"

PROXY_SESSION_IP=$(docker inspect \
  -f "{{with index .NetworkSettings.Networks \"sn-$SESSION_ID\"}}{{.IPAddress}}{{end}}" \
  boxes-egress-proxy 2>/dev/null)
if [ -n "$PROXY_SESSION_IP" ]; then
  grey "the proxy is $PROXY_SESSION_IP on this session's network"
  mustnot "F1" "the control port is closed on the session network" \
    sx nc -w5 -z "$PROXY_SESSION_IP" 3129
else
  skipped "F1" "could not read the proxy's address on the session network"
fi
mustnot "F2" "the control port is closed on the proxy alias" \
  sx nc -w5 -z proxy 3129
mustnot "F3" "the proxy will not forward a session to its own control port" \
  sxs 'curl -fsS -m 8 -o /dev/null http://proxy:3129/status'
matches "F4" "the control channel refuses a wrong bearer" '^401$' \
  docker exec boxes-orchestrator node -e \
    'fetch("http://boxes-egress-proxy:3129/status",{headers:{authorization:"Bearer wrong"}}).then(r=>console.log(r.status)).catch(e=>console.log(e.message))'

# The compose network is an ordinary bridge, so the host can address the proxy
# directly. That is a smaller surface than a session's, but not an empty one.
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

# One real turn, and everything the proxy refused while it ran. A turn that
# fails under a narrow allowlist and succeeds without one is a list that is too
# narrow, not a broken translation, and phase I settles which it was.
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
  absent "G2" "the real Claude token is still nowhere in the session after a turn" "$REAL_CLAUDE"
fi

# ------------------------------------------------------------- H. restarts ----

if [ "${SKIP_RESTART:-0}" = 1 ]; then
  head1 "H. restart resilience (skipped)"
  for id in H1 H2 H3 H4 H5; do skipped "$id" "SKIP_RESTART=1"; done
else
  head1 "H. what a restart does to the policy"

  docker restart boxes-egress-proxy >/dev/null 2>&1
  sleep 6
  # The proxy holds nothing at rest, so straight after a restart it runs the
  # empty policy: no allowlist and nothing intercepted. This measures that
  # window rather than asserting it away.
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

  # A running session already trusts the CA, so it must not change under it.
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
  matches "H5" "the running session still trusts the CA after both restarts" 'Boxes egress proxy CA' \
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

# Put the allowlist back for the suites below.
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
