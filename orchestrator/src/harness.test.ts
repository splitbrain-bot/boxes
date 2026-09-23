import { test } from 'vitest';
import assert from 'node:assert/strict';
import { HARNESS_IDS, HARNESSES, harness, type Harness } from './harness.ts';

const all: Harness[] = HARNESS_IDS.map((id) => HARNESSES[id]);

test('HARNESS_IDS matches the keys of HARNESSES', () => {
  assert.deepEqual([...HARNESS_IDS].sort(), Object.keys(HARNESSES).sort());
  for (const id of HARNESS_IDS) assert.equal(HARNESSES[id].id, id);
});

test('every harness fills in every field, in the right shape', () => {
  for (const h of all) {
    assert.ok(h.label.length > 0, `${h.id}: label`);
    assert.ok(h.cmd.length > 0, `${h.id}: cmd`);
    // The reading and the spawn are different questions, but today's answer is
    // the same one, and a registry where they had drifted would read a process
    // table for a token nothing in the box is running under.
    assert.equal(h.processToken, h.cmd[0], `${h.id}: processToken`);
    assert.ok(Array.isArray(h.residentProcesses), `${h.id}: residentProcesses`);
    for (const re of h.residentProcesses) assert.ok(re instanceof RegExp, `${h.id}: resident entry`);
    assert.ok(h.defaultModeId.length > 0, `${h.id}: defaultModeId`);
    assert.ok(h.forkModeId.length > 0, `${h.id}: forkModeId`);
    // A fork exists to ask questions about work the original is still doing,
    // so it never starts in the mode the original is in.
    assert.notEqual(h.forkModeId, h.defaultModeId, `${h.id}: fork mode differs`);
    for (const [option, value] of Object.entries(h.defaultConfig)) {
      assert.equal(typeof option, 'string');
      assert.equal(typeof value, 'string', `${h.id}: defaultConfig.${option}`);
    }
    if (h.threadMeta !== undefined) {
      assert.equal(typeof h.threadMeta, 'object', `${h.id}: threadMeta`);
      assert.notEqual(h.threadMeta, null, `${h.id}: threadMeta`);
    }
    assert.ok(['claude', 'openai', 'github'].includes(h.credentialId), `${h.id}: credentialId`);
    assert.equal(typeof h.env, 'function', `${h.id}: env`);
    assert.ok(h.layout.agentsMd.length > 0, `${h.id}: layout.agentsMd`);
    assert.ok(h.layout.skills.length > 0, `${h.id}: layout.skills`);
    assert.ok(h.layout.commands.length > 0, `${h.id}: layout.commands`);
    assert.ok(h.alwaysBackground instanceof Set, `${h.id}: alwaysBackground`);
  }
});

test('every layout path is relative, so it can be resolved against a home', () => {
  for (const h of all) {
    for (const path of Object.values(h.layout)) {
      assert.ok(!path.startsWith('/'), `${h.id}: ${path} is absolute`);
      assert.ok(!path.includes('..'), `${h.id}: ${path} climbs`);
    }
  }
});

test('env() puts the placeholder in one of its values', () => {
  for (const h of all) {
    const env = h.env('placeholder-value');
    const values = Object.values(env);
    assert.ok(values.includes('placeholder-value'), `${h.id}: placeholder unused`);
    // Exactly one variable carries the credential; the rest are fixed.
    assert.equal(
      values.filter((v) => v === 'placeholder-value').length,
      1,
      `${h.id}: placeholder used more than once`,
    );
    for (const [name, value] of Object.entries(env)) {
      assert.equal(typeof value, 'string', `${h.id}: ${name}`);
      assert.ok(value.length > 0, `${h.id}: ${name} is empty`);
    }
  }
});

test('env() is a fresh object each call, so a caller can edit what it gets', () => {
  const first = HARNESSES.claude.env('a');
  const second = HARNESSES.claude.env('b');
  assert.notEqual(first, second);
  assert.equal(first['CLAUDE_CODE_OAUTH_TOKEN'], 'a');
  assert.equal(second['CLAUDE_CODE_OAUTH_TOKEN'], 'b');
});

test('the CA variables stay out of the registry: they belong to the deployment', () => {
  for (const h of all) {
    const names = Object.keys(h.env('placeholder-value'));
    assert.ok(!names.includes('CODEX_CA_CERTIFICATE'), `${h.id}: CA in the registry`);
    assert.ok(!names.includes('SSL_CERT_FILE'), `${h.id}: CA in the registry`);
  }
});

test('no two harnesses share a layout path', () => {
  // Both layouts are installed into the same home, and a shared path would
  // have one harness's agent set overwrite the other's.
  const seen = new Map<string, string>();
  for (const h of all) {
    for (const path of Object.values(h.layout)) {
      const owner = seen.get(path);
      assert.equal(owner, undefined, `${path} is claimed by both ${owner} and ${h.id}`);
      seen.set(path, h.id);
    }
  }
});

test('the Claude entry says what the orchestrator does today', () => {
  const h = HARNESSES.claude;
  assert.deepEqual([...h.cmd], ['claude-agent-acp']);
  assert.equal(h.defaultModeId, 'auto');
  assert.equal(h.forkModeId, 'plan');
  assert.deepEqual(h.defaultConfig, { model: 'opus' });
  assert.deepEqual(h.threadMeta, {
    claudeCode: {
      options: {
        model: 'fable',
        thinking: { type: 'enabled', budgetTokens: 10_000, display: 'summarized' },
      },
    },
  });
  assert.deepEqual(h.env('tok'), {
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    CLAUDE_CONFIG_DIR: '/home/agent/.claude',
  });
  assert.deepEqual([...h.alwaysBackground].sort(), ['Monitor', 'Workflow']);
});

test('the Codex entry matches what codex-acp reads', () => {
  const h = HARNESSES.codex;
  assert.deepEqual([...h.cmd], ['codex-acp']);
  assert.equal(h.defaultModeId, 'agent-full-access');
  assert.equal(h.forkModeId, 'read-only');
  assert.deepEqual(h.defaultConfig, {});
  assert.equal(h.threadMeta, undefined);
  assert.deepEqual(h.env('key'), {
    CODEX_API_KEY: 'key',
    CODEX_HOME: '/home/agent/.codex',
    NO_BROWSER: '1',
    INITIAL_AGENT_MODE: 'agent-full-access',
    DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}',
  });
  // The mode the adapter is told to start every box in is the same one a
  // fresh thread is switched into; two answers here would fight each other.
  assert.equal(h.env('key')['INITIAL_AGENT_MODE'], h.defaultModeId);
  assert.equal(h.alwaysBackground.size, 0);
});

test('residentProcesses match the adapter each was read from', () => {
  const matches = (h: Harness, line: string) => h.residentProcesses.some((re) => re.test(line));
  assert.ok(matches(HARNESSES.claude, 'node /usr/local/bin/claude --print'));
  assert.ok(!matches(HARNESSES.claude, 'bash -lc grep -r claude-adjacent /workspace'));
  assert.ok(matches(HARNESSES.codex, '/usr/local/bin/codex app-server'));
  assert.ok(!matches(HARNESSES.codex, 'bash -lc npm run build'));
});

test('harness() resolves a known id and throws on anything else', () => {
  for (const id of HARNESS_IDS) assert.equal(harness(id), HARNESSES[id]);
  assert.throws(() => harness('nope'), /Unknown harness: nope/);
  assert.throws(() => harness(''), /Unknown harness/);
  // A key every object has is not a harness.
  assert.throws(() => harness('constructor'), /Unknown harness/);
  assert.throws(() => harness('toString'), /Unknown harness/);
});
