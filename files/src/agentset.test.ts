import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, test } from 'vitest';
import { installAgentSet, MANAGED_FILE, unitOf } from './agentset.ts';
import { FileError } from './ops.ts';

let dir: string;
let home: string;
let imageSkills: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-agentset-'));
  home = join(dir, 'home');
  imageSkills = join(dir, 'image-skills');
  mkdirSync(home);
  mkdirSync(imageSkills);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One file of a set: its content, and its mode when it is not 0644. */
type Entry = string | { content: string; mode?: number; type?: 'file' | 'symlink' | 'directory' };

/** A tar stream of the given files, relative to the home. */
function tar(files: Record<string, Entry>): Readable {
  const p = pack();
  for (const [name, entry] of Object.entries(files)) {
    const e = typeof entry === 'string' ? { content: entry } : entry;
    p.entry({ name, mode: e.mode ?? 0o644, type: e.type ?? 'file', size: e.content.length }, e.content);
  }
  p.finalize();
  return Readable.from(p);
}

/** Writes files under `root`, creating the directories on the way. */
function files(root: string, contents: Record<string, string>): void {
  for (const [rel, content] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

/** The content of one file of the home. */
function inHome(rel: string): string {
  return readFileSync(join(home, rel), 'utf8');
}

/** The managed file, as lines. */
function managed(): string[] {
  return inHome(MANAGED_FILE).split('\n').filter((line) => line !== '');
}

test('a path maps to its unit: the instructions file, or the skill directory', () => {
  assert.equal(unitOf('.claude/CLAUDE.md'), '.claude/CLAUDE.md');
  assert.equal(unitOf('.codex/AGENTS.md'), '.codex/AGENTS.md');
  assert.equal(unitOf('.claude/skills/pdf/SKILL.md'), '.claude/skills/pdf');
  assert.equal(unitOf('.agents/skills/pdf/scripts/run.sh'), '.agents/skills/pdf');
  assert.equal(unitOf('.claude/skills/pdf'), '.claude/skills/pdf');
  // What the layouts do not name is refused, including the layouts as a whole.
  assert.equal(unitOf('.claude'), null);
  assert.equal(unitOf('.claude/skills'), null);
  assert.equal(unitOf('.claude/settings.json'), null);
  assert.equal(unitOf('.ssh/authorized_keys'), null);
  assert.equal(unitOf('.claude/skills/../../.ssh'), null);
  assert.equal(unitOf('/etc/passwd'), null);
  assert.equal(unitOf(''), null);
});

test('installs the set into the home and records its units', async () => {
  await installAgentSet(
    home,
    undefined,
    tar({
      '.claude/CLAUDE.md': 'rules',
      '.claude/skills/pdf/SKILL.md': 'pdf',
      '.claude/skills/pdf/scripts/run.sh': { content: '#!/bin/sh\n', mode: 0o755 },
      '.agents/skills/pdf/SKILL.md': 'pdf',
    }),
  );
  assert.equal(inHome('.claude/CLAUDE.md'), 'rules');
  assert.equal(inHome('.claude/skills/pdf/SKILL.md'), 'pdf');
  assert.equal(inHome('.agents/skills/pdf/SKILL.md'), 'pdf');
  // The mode travels with the file, so a script stays executable.
  assert.equal(statSync(join(home, '.claude/skills/pdf/scripts/run.sh')).mode & 0o111, 0o111);
  assert.deepEqual(managed(), ['.agents/skills/pdf', '.claude/CLAUDE.md', '.claude/skills/pdf']);
  assert.equal(existsSync(join(home, '.boxes/agent-set.new')), false);
});

test('the next install removes what the last one put there, and nothing else', async () => {
  files(home, { '.claude/settings.json': 'mine', '.claude/skills/own/SKILL.md': 'mine too' });
  await installAgentSet(
    home,
    undefined,
    tar({ '.claude/CLAUDE.md': 'rules', '.claude/skills/pdf/SKILL.md': 'pdf' }),
  );
  await installAgentSet(home, undefined, tar({ '.claude/skills/review/SKILL.md': 'review' }));

  assert.equal(existsSync(join(home, '.claude/CLAUDE.md')), false);
  assert.equal(existsSync(join(home, '.claude/skills/pdf')), false);
  assert.equal(inHome('.claude/skills/review/SKILL.md'), 'review');
  assert.equal(inHome('.claude/settings.json'), 'mine');
  assert.equal(inHome('.claude/skills/own/SKILL.md'), 'mine too');
  assert.deepEqual(managed(), ['.claude/skills/review']);
});

test('an empty set removes the last install', async () => {
  await installAgentSet(home, undefined, tar({ '.claude/CLAUDE.md': 'rules' }));
  await installAgentSet(home, undefined, tar({}));
  assert.equal(existsSync(join(home, '.claude/CLAUDE.md')), false);
  assert.deepEqual(managed(), []);
});

test('a skill that the agent changed is replaced whole', async () => {
  await installAgentSet(home, undefined, tar({ '.claude/skills/pdf/SKILL.md': 'pdf' }));
  files(home, { '.claude/skills/pdf/notes.md': 'added by the agent' });
  await installAgentSet(home, undefined, tar({ '.claude/skills/pdf/SKILL.md': 'pdf v2' }));
  assert.deepEqual(readdirSync(join(home, '.claude/skills/pdf')), ['SKILL.md']);
  assert.equal(inHome('.claude/skills/pdf/SKILL.md'), 'pdf v2');
});

test('a managed line outside the layouts removes nothing', async () => {
  files(home, { '.ssh/id': 'key', [MANAGED_FILE]: '.ssh\n.claude\n..\n.claude/skills/old\n' });
  files(home, { '.claude/skills/old/SKILL.md': 'old' });
  await installAgentSet(home, undefined, tar({}));
  assert.equal(inHome('.ssh/id'), 'key');
  assert.equal(existsSync(join(home, '.claude')), true);
  assert.equal(existsSync(join(home, '.claude/skills/old')), false);
});

test('an entry outside the layouts is refused, and nothing changes', async () => {
  await installAgentSet(home, undefined, tar({ '.claude/CLAUDE.md': 'rules' }));
  await assert.rejects(
    installAgentSet(
      home,
      undefined,
      tar({ '.claude/skills/pdf/SKILL.md': 'pdf', '.ssh/authorized_keys': 'key' }),
    ),
    (err: FileError) => err.status === 400 && /\.ssh\/authorized_keys/.test(err.message),
  );
  assert.equal(inHome('.claude/CLAUDE.md'), 'rules');
  assert.equal(existsSync(join(home, '.ssh')), false);
  assert.equal(existsSync(join(home, '.claude/skills/pdf')), false);
  assert.equal(existsSync(join(home, '.boxes/agent-set.new')), false);
});

test('an entry that is not a plain file is refused', async () => {
  await assert.rejects(
    installAgentSet(
      home,
      undefined,
      tar({ '.claude/skills/pdf/link': { content: '', type: 'symlink' } }),
    ),
    (err: FileError) => err.status === 400,
  );
  assert.equal(existsSync(join(home, '.claude')), false);
});

test('the skills of the image go into both layouts, unless the set has the skill', async () => {
  files(imageSkills, { 'nix/SKILL.md': 'image nix', 'share-app/SKILL.md': 'image share-app' });
  await installAgentSet(home, imageSkills, tar({ '.claude/skills/nix/SKILL.md': 'own nix' }));
  assert.equal(inHome('.claude/skills/nix/SKILL.md'), 'own nix');
  assert.equal(inHome('.claude/skills/share-app/SKILL.md'), 'image share-app');
  assert.equal(inHome('.agents/skills/share-app/SKILL.md'), 'image share-app');
  // The image skills are not recorded: they are put there again at each install.
  assert.deepEqual(managed(), ['.claude/skills/nix']);

  // Without the own skill, the image's copy comes back.
  await installAgentSet(home, imageSkills, tar({}));
  assert.equal(inHome('.claude/skills/nix/SKILL.md'), 'image nix');
  assert.equal(inHome('.agents/skills/nix/SKILL.md'), 'image nix');
});

test('a missing image skills directory is the same as none', async () => {
  await installAgentSet(home, join(dir, 'nowhere'), tar({}));
  assert.equal(existsSync(join(home, '.claude/skills')), false);
});
