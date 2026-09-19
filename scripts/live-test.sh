#!/usr/bin/env bash
# Live tests that need a real credential to run a turn on.
#
# These are the checks only a real inference call can prove, so they are kept
# apart from the credential-free scripts/smoke-test.sh and never run by
# default.
#
# The deployment needs a Claude token from `claude setup-token`. It is
# normally entered on the settings page; pass it here and this script seeds it
# through the API before it creates anything:
#
#   docker compose up -d
#   PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
#     API_BASE=http://localhost:3000 ./scripts/live-test.sh
#
# Without it, the deployment has to already hold one, and the two checks that
# compare the box's placeholder against the real token are skipped.
#
# Pass an OpenAI API key as well and the box also gets a Codex thread beside
# the Claude one, and runs a turn on it:
#
#   PROFILE_DEFAULT_OPENAI_API_KEY=sk-... ./scripts/live-test.sh
#
# Without one the Codex half is skipped entirely. Both threads live in the
# same box, on the same checkout, which is the point of a per-thread harness.
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

# Read under the name the deployment used to take, for the convenience of
# whoever already exports it, and seeded into the store rather than read back
# out of the orchestrator's environment, where it no longer is.
REAL_CLAUDE="${PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN:-}"
REAL_OPENAI="${PROFILE_DEFAULT_OPENAI_API_KEY:-}"

# The method is how the secret was obtained, which is what the settings page
# would have recorded: a pasted OpenAI key is an `api_key`.
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
seed_credential claude "$REAL_CLAUDE"
seed_credential openai "$REAL_OPENAI" api_key

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
CLAUDE_REPLY=$(docker exec -u agent "$CONTAINER" claude -p 'reply ok' 2>&1)
printf '%s\n' "$CLAUDE_REPLY" >&2
if grep -qiw ok <<<"$CLAUDE_REPLY"; then
  ok "claude -p 'reply ok' answered via the subscription"
else
  no "claude -p 'reply ok' produced no answer - check the Claude credential in Settings"
fi

echo
echo "== the turn above ran on a placeholder, not on the real token =="
# The same turn, seen from the credential's side: the container holds something
# that is not the stored token, and the proxy is what made it work.
IN_SESSION=$(docker exec "$CONTAINER" printenv CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true)
if [ -z "$REAL_CLAUDE" ]; then
  grey "skipped: this run was passed no token, so there is nothing to compare against"
elif [ -z "$IN_SESSION" ]; then
  no "the session has no CLAUDE_CODE_OAUTH_TOKEN at all"
elif [ "$IN_SESSION" = "$REAL_CLAUDE" ]; then
  no "the session holds the real Claude token - translation is not in effect"
else
  ok "the session holds a placeholder; the proxy swapped it for the real token"
fi

echo
echo "== a Codex thread beside the Claude one, in the same box =="
# The per-thread harness, end to end: a second conversation in the box that
# already holds a Claude one, running the other agent on the same checkout,
# authenticated by the key the settings page holds and swapped by the proxy.
if [ -z "$REAL_OPENAI" ]; then
  grey "skipped: no OpenAI key was passed, so nothing can run a Codex turn"
else
  CODEX_THREAD=$(api -X POST "$API_BASE/api/sessions/$SESSION_ID/threads" \
    -H 'Content-Type: application/json' \
    -d '{"options":{"harness":"codex"}}' | jq -r '.id')
  CODEX_HARNESS=$(api "$API_BASE/api/sessions/$SESSION_ID/threads" \
    | jq -r --arg t "$CODEX_THREAD" '.[] | select(.id==$t) | .harness')
  if [ "$CODEX_HARNESS" = "codex" ]; then
    ok "the box took a Codex thread beside its Claude one"
  else
    no "the box would not take a Codex thread"
  fi

  # The box holds a placeholder, never the key. Same proof as the Claude one
  # above, on the variable the Codex adapter logs itself in with.
  IN_SESSION_KEY=$(docker exec "$CONTAINER" printenv CODEX_API_KEY 2>/dev/null || true)
  if [ -z "$IN_SESSION_KEY" ]; then
    no "the session has no CODEX_API_KEY at all"
  elif [ "$IN_SESSION_KEY" = "$REAL_OPENAI" ]; then
    no "the session holds the real OpenAI key - translation is not in effect"
  else
    ok "the session holds a placeholder for the OpenAI key"
  fi

  CODEX_WS="${API_BASE/http/ws}/ws/sessions/$SESSION_ID/threads/$CODEX_THREAD/acp"
  grey "codex thread=$CODEX_THREAD"
  # One turn on the other adapter. `session/new` hands back the pinned
  # thread's own conversation rather than starting a second one, so this is
  # the Codex thread created above and no other.
  node --input-type=module - "$CODEX_WS" "$WS_TOKEN" <<'NODE'
const [url, token] = process.argv.slice(2);
const ws = new WebSocket(url, ['acp.v1', `bearer.${token}`]);
const pending = new Map();
const said = [];
let id = 0;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk') {
    said.push(m.params.update.content?.text ?? '');
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('websocket failed')));
});
const rpc = (method, params) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }));
    setTimeout(() => { if (pending.delete(i)) rej(new Error(`timeout: ${method}`)); }, 300000);
  });
await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await rpc('session/new', { cwd: '/workspace', mcpServers: [] });
await rpc('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: 'reply with the word ok and nothing else' }],
});
ws.close();
const answer = said.join('');
console.log(`the Codex thread said: ${answer.slice(0, 120)}`);
process.exit(/ok/i.test(answer) ? 0 : 1);
NODE
  if [ $? -eq 0 ]; then
    ok "a Codex turn ran on the key the settings page holds, through the proxy"
  else
    no "the Codex turn produced no answer - check the OpenAI credential in Settings"
  fi

  # And the real key is still nowhere in the box after a turn has carried it.
  if docker exec "$CONTAINER" env 2>/dev/null | grep -qF -- "$REAL_OPENAI"; then
    no "the real OpenAI key is in the session's environment"
  else
    ok "the real OpenAI key is nowhere in the session after a Codex turn"
  fi
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
