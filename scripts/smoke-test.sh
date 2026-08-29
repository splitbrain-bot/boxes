#!/usr/bin/env bash
# Security smoke test (plan §10).
#
# Run on the Docker host after `docker compose up -d`. Creates a throwaway
# session via the API, asserts the isolation properties from inside its
# container, then cleans up.
#
#   API_BASE=http://localhost:3000 ./scripts/smoke-test.sh
#
# Every MUST-FAIL case is a property an agent must not be able to violate;
# a pass here is the difference between "isolated" and "hopefully isolated".
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
CURL_AUTH=()
if [ -n "${API_USER:-}" ]; then CURL_AUTH=(-u "${API_USER}:${API_PASS:-}"); fi

pass=0; fail=0; noted=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[90m%s\033[0m\n' "$*"; }

# Asserts a command run inside the session container FAILS.
must_fail() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    red   "FAIL (succeeded but must not): $desc"; fail=$((fail+1))
  else
    green "ok   (correctly denied):       $desc"; pass=$((pass+1))
  fi
}

# Asserts a command run inside the session container SUCCEEDS.
must_pass() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    green "ok   (allowed as intended):    $desc"; pass=$((pass+1))
  else
    red   "FAIL (denied but must work):  $desc"; fail=$((fail+1))
  fi
}

# Documented-but-accepted: assert and log, never fail the run (plan §10, §8.4).
note() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    grey "note (reachable, accepted):    $desc"
  else
    grey "note (not reachable):          $desc"
  fi
  noted=$((noted+1))
}

cleanup() {
  if [ -n "${SESSION_ID:-}" ]; then
    grey "cleaning up session $SESSION_ID"
    curl -sS "${CURL_AUTH[@]}" -X DELETE "$API_BASE/api/sessions/$SESSION_ID?purge=true" >/dev/null || true
  fi
  if [ -n "${SIBLING_ID:-}" ]; then
    curl -sS "${CURL_AUTH[@]}" -X DELETE "$API_BASE/api/sessions/$SIBLING_ID?purge=true" >/dev/null || true
  fi
}
trap cleanup EXIT

echo "== creating throwaway sessions =="
SESSION_ID=$(curl -sS "${CURL_AUTH[@]}" -X POST "$API_BASE/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test"}' | jq -r '.id')
[ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ] || { red "could not create session"; exit 1; }

SIBLING_ID=$(curl -sS "${CURL_AUTH[@]}" -X POST "$API_BASE/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test-sibling"}' | jq -r '.id')

CONTAINER="session-$SESSION_ID"
SIBLING_CONTAINER="session-$SIBLING_ID"
SIBLING_IP=$(docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SIBLING_CONTAINER" 2>/dev/null)
grey "session=$SESSION_ID sibling=$SIBLING_ID sibling_ip=${SIBLING_IP:-unknown}"

echo
echo "== MUST FAIL: direct (proxy-bypassing) egress =="
# The session network is `internal`: no NAT, no default route (plan §8.4).
must_fail "curl --noproxy '*' https://api.github.com" \
  curl --noproxy '*' -sS -m 3 https://api.github.com
must_fail "nc -w3 1.1.1.1 443" \
  nc -w3 -z 1.1.1.1 443

echo
echo "== MUST FAIL: private space via the proxy (resolved-IP vetting) =="
must_fail "curl http://192.168.1.1" \
  curl -sS -m 3 http://192.168.1.1
must_fail "curl http://10.0.0.1" \
  curl -sS -m 3 http://10.0.0.1
must_fail "curl http://169.254.169.254 (cloud metadata)" \
  curl -sS -m 3 http://169.254.169.254/latest/meta-data/
# DNS-rebind shape: a public hostname whose A record is private.
must_fail "curl http://localtest.me (hostname -> private IP)" \
  curl -sS -m 3 http://localtest.me
must_fail "curl http://[::ffff:192.168.1.1] (v4-mapped bypass)" \
  curl -sS -m 3 'http://[::ffff:192.168.1.1]'

echo
echo "== MUST FAIL: cross-session reachability =="
if [ -n "${SIBLING_IP:-}" ]; then
  must_fail "nc -w3 <sibling> 22 (distinct internal networks)" \
    nc -w3 -z "$SIBLING_IP" 22
  must_fail "curl http://<sibling>:8080 via proxy" \
    curl -sS -m 3 "http://$SIBLING_IP:8080"
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
must_pass "curl https://api.github.com" \
  curl -sS -m 15 https://api.github.com
must_pass "write to /workspace" \
  sh -c 'echo ok > /workspace/.smoke && rm /workspace/.smoke'
must_pass "write to /home/agent" \
  sh -c 'echo ok > /home/agent/.smoke && rm /home/agent/.smoke'
must_pass "write to /tmp (tmpfs)" \
  sh -c 'echo ok > /tmp/.smoke && rm /tmp/.smoke'

if [ -n "${SMOKE_BOT_FORK:-}" ]; then
  must_pass "git ls-remote \$SMOKE_BOT_FORK" \
    git ls-remote "$SMOKE_BOT_FORK"
fi
if [ "${SMOKE_CLAUDE:-0}" = "1" ]; then
  # Costs a real inference call, so opt-in.
  must_pass "claude -p 'reply ok' (subscription auth)" \
    claude -p 'reply ok'
fi

echo
echo "== pids limit containment =="
# A fork bomb must be contained by PidsLimit without affecting the host or
# the sibling session. Bounded so the test itself cannot hang.
docker exec -u agent "$CONTAINER" sh -c \
  ':(){ :|:& };: & sleep 5; kill %1 2>/dev/null' >/dev/null 2>&1
if docker exec -u agent "$SIBLING_CONTAINER" true >/dev/null 2>&1; then
  green "ok   (sibling unaffected):      fork bomb contained by pids-limit"; pass=$((pass+1))
else
  red   "FAIL: sibling session affected by fork bomb"; fail=$((fail+1))
fi

echo
echo "== documented-but-accepted residual surface (plan §8.4) =="
# Docker's internal-network isolation filters forwarded traffic only, so the
# host stays addressable at its per-bridge IP. The owner accepted this; we
# assert and log it rather than failing.
HOST_BRIDGE_IP=$(docker network inspect "sn-$SESSION_ID" \
  -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
if [ -n "$HOST_BRIDGE_IP" ]; then
  note "host per-bridge IP $HOST_BRIDGE_IP:22" nc -w3 -z "$HOST_BRIDGE_IP" 22
fi

echo
echo "== proxy attachment =="
if curl -sS "${CURL_AUTH[@]}" "$API_BASE/api/sessions/$SESSION_ID" | jq -e '.proxyAttached' >/dev/null; then
  green "ok   proxy attached to session network"; pass=$((pass+1))
else
  red   "FAIL: egress proxy is not attached to the session network"; fail=$((fail+1))
fi

echo
echo "=================================="
echo "passed: $pass   failed: $fail   noted: $noted"
[ "$fail" -eq 0 ] || exit 1
green "smoke test green"
