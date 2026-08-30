#!/usr/bin/env bash
# Live tests that need a real Claude subscription token.
#
# These are the checks only a real inference call can prove, so they are kept
# apart from the credential-free scripts/smoke-test.sh and never run by
# default.
#
# The orchestrator needs PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN from
# `claude setup-token` before these can pass. It can live outside the repo:
#
#   BOXES_ENV=~/.config/boxes.env docker compose up -d
#   API_BASE=http://localhost:3000 ./scripts/live-test.sh
#
# Needs: curl, jq, docker, and node 22 or newer (for the WebSocket client).
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
CURL_AUTH=()
if [ -n "${API_USER:-}" ]; then CURL_AUTH=(-u "${API_USER}:${API_PASS:-}"); fi

pass=0; fail=0
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[90m%s\033[0m\n' "$*"; }
ok()    { green "ok   $*"; pass=$((pass+1)); }
no()    { red   "FAIL $*"; fail=$((fail+1)); }

api() { curl -sS "${CURL_AUTH[@]}" "$@"; }

cleanup() {
  if [ -n "${SESSION_ID:-}" ]; then
    grey "cleaning up session $SESSION_ID"
    api -X DELETE "$API_BASE/api/sessions/$SESSION_ID" >/dev/null || true
  fi
}
trap cleanup EXIT

echo "== creating a session =="
SESSION_ID=$(api -X POST "$API_BASE/api/sessions" \
  -H 'Content-Type: application/json' -d '{"name":"live-test"}' | jq -r '.id')
[ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ] || { red "could not create session"; exit 1; }
CONTAINER="session-$SESSION_ID"
WS_TOKEN=$(api "$API_BASE/api/sessions/$SESSION_ID" | jq -r '.wsToken')
# Same origin as the API, the way the dashboard derives it.
LOCAL_WS="${API_BASE/http/ws}/ws/sessions/$SESSION_ID/acp"
grey "session=$SESSION_ID  ws=$LOCAL_WS"

echo
echo "== M1: the subscription token works inside the container =="
# No API key is present, so a reply here proves the OAuth token is in use.
if docker exec -u agent "$CONTAINER" claude -p 'reply ok' 2>&1 | tee /dev/stderr | grep -qi ok; then
  ok "claude -p 'reply ok' answered via the subscription"
else
  no "claude -p 'reply ok' produced no answer - check PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN"
fi

echo
echo "== the turn above ran on a placeholder, not on the real token =="
# The same turn, seen from the credential's side: the container holds something
# that is not the configured token, and the proxy is what made it work.
REAL_CLAUDE=$(docker exec boxes-orchestrator printenv PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true)
IN_SESSION=$(docker exec "$CONTAINER" printenv CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true)
if [ -z "$REAL_CLAUDE" ]; then
  grey "skipped: no Claude token is configured, so nothing is translated"
elif [ -z "$IN_SESSION" ]; then
  no "the session has no CLAUDE_CODE_OAUTH_TOKEN at all"
elif [ "$IN_SESSION" = "$REAL_CLAUDE" ]; then
  no "the session holds the real Claude token - translation is not in effect"
else
  ok "the session holds a placeholder; the proxy swapped it for the real token"
fi

echo
echo "== M3/M4: a turn survives the browser leaving, and the thread replays =="
node --input-type=module - "$LOCAL_WS" "$WS_TOKEN" <<'NODE'
const [url, token] = process.argv.slice(2);

/** Opens a socket and returns its JSON-RPC helpers, the way a browser connects. */
function connect() {
  const ws = new WebSocket(url, ['acp.v1', `bearer.${token}`]);
  const pending = new Map();
  const updates = [];
  let id = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method === 'session/update') {
      updates.push(m.params);
    }
  });
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('websocket failed')));
  });
  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }));
      setTimeout(() => { if (pending.delete(i)) rej(new Error(`timeout: ${method}`)); }, 600000);
    });
  return { ws, rpc, open, updates };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (good, text) => { results.push([good, text]); };

// --- first browser: start a turn, then walk away mid-turn ------------------
const a = connect();
await a.open;
await a.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await a.rpc('session/new', { cwd: '/workspace', mcpServers: [] });

// Long enough that the socket is certainly closed before the turn ends.
const prompt = 'Count slowly from 1 to 20, one number per line, then say DONE.';
const turn = a.rpc('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: prompt }],
});
turn.catch(() => {}); // this browser will not be around to see the answer

await sleep(2000);
a.ws.close();          // phone locked, tab closed, network dropped
record(true, 'browser disconnected mid-turn');

// --- nobody is watching: the turn must keep running -----------------------
await sleep(20000);

// --- second browser: reattach and replay ----------------------------------
const b = connect();
await b.open;
await b.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
// A reattaching browser clears its messages and calls session/load, expecting the replay to
// arrive as session/update notifications.
await b.rpc('session/load', { sessionId, cwd: '/workspace', mcpServers: [] });
await sleep(5000);

// Only the agent's own messages count: the replay also carries the prompt,
// which quotes the words being matched.
const agentText = b.updates
  .filter((u) => u?.update?.sessionUpdate === 'agent_message_chunk')
  .map((u) => u.update?.content?.text ?? '')
  .join('');
const kinds = [...new Set(b.updates.map((u) => u?.update?.sessionUpdate))].join(', ');

record(b.updates.length > 0, `session/load replayed ${b.updates.length} update(s) [${kinds}]`);
record(agentText.length > 0, 'the replay includes the agent\'s own messages');
record(/DONE/.test(agentText) && /\b20\b/.test(agentText),
  'the agent finished the count while nobody was attached');

b.ws.close();
for (const [good, text] of results) console.log(`${good ? 'PASS' : 'FAIL'}\t${text}`);
process.exit(results.every(([g]) => g) ? 0 : 1);
NODE
if [ $? -eq 0 ]; then
  ok "turn ran to completion unattended and the thread replayed on reattach"
else
  no "the disconnect/replay flow did not complete"
fi

echo
echo "== M4: a permission request with no browser attached is held =="
# A prompt that must ask before acting, sent by a browser that leaves at once.
node --input-type=module - "$LOCAL_WS" "$WS_TOKEN" <<'NODE'
const [url, token] = process.argv.slice(2);
const ws = new WebSocket(url, ['acp.v1', `bearer.${token}`]);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const rpc = (method, params) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }));
});
await new Promise((r) => ws.addEventListener('open', r));
await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await rpc('session/new', { cwd: '/workspace', mcpServers: [] });
rpc('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: 'Create a file /workspace/permission-probe.txt containing the word hello.' }],
}).catch(() => {});
await new Promise((r) => setTimeout(r, 3000));
ws.close();
NODE

grey "waiting up to 60s for the request to be queued"
held=0
for _ in $(seq 1 20); do
  n=$(api "$API_BASE/api/sessions/$SESSION_ID" | jq -r '.pendingCount')
  if [ "$n" != "0" ] && [ "$n" != "null" ]; then held=1; break; fi
  sleep 3
done
if [ "$held" = "1" ]; then
  ok "permission request queued while no browser was attached (dashboard shows the badge)"
else
  no "no permission request was queued - the prompt may not have needed one"
fi

echo
echo "=================================="
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
green "live test green"
