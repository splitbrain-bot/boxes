import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { openDb, type Db } from './db.ts';
import { DEFAULT_GIT_EMAIL, DEFAULT_GIT_NAME, patchSettings, readSettings } from './settings.ts';

/**
 * The plain settings: the git identity every box commits as, and what each
 * dialog last chose. Everything here has a default, so a deployment that has
 * never opened the settings page is fully configured.
 */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-settings-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a deployment that has set nothing gets the defaults', () => {
  assert.deepEqual(readSettings(db), {
    gitName: DEFAULT_GIT_NAME,
    gitEmail: DEFAULT_GIT_EMAIL,
    dialogs: {},
  });
  assert.equal(DEFAULT_GIT_NAME, 'boxes-bot');
  assert.equal(DEFAULT_GIT_EMAIL, 'boxes-bot@users.noreply.github.com');
});

test('a patch writes what it names and leaves the rest alone', () => {
  patchSettings(db, { gitName: 'Release bot' });
  assert.deepEqual(readSettings(db), {
    gitName: 'Release bot',
    gitEmail: DEFAULT_GIT_EMAIL,
    dialogs: {},
  });

  const both = patchSettings(db, { gitEmail: 'bot@example.com' });
  assert.equal(both.gitName, 'Release bot');
  assert.equal(both.gitEmail, 'bot@example.com');
});

test('clearing a field puts the default back rather than leaving nobody there', () => {
  patchSettings(db, { gitName: 'Release bot' });
  // An emptied field is a field cleared, not a box that commits as nobody —
  // and the stored row goes, so a later release moving the default moves this
  // deployment with it.
  assert.equal(patchSettings(db, { gitName: '  ' }).gitName, DEFAULT_GIT_NAME);
});

test('a dialog is stored per harness and merged rather than replaced', () => {
  patchSettings(db, { dialogs: { claude: { modeId: 'plan', config: { model: 'opus' } } } });
  patchSettings(db, { dialogs: { codex: { modeId: 'agent-full-access' } } });

  assert.deepEqual(readSettings(db).dialogs, {
    claude: { modeId: 'plan', config: { model: 'opus' } },
    codex: { modeId: 'agent-full-access' },
  });

  // One dialog's answer is replaced whole: it is one screen's state.
  patchSettings(db, { dialogs: { claude: { modeId: 'auto' } } });
  assert.deepEqual(readSettings(db).dialogs['claude'], { modeId: 'auto' });
});

test('a stored value that is not a dialog is ignored rather than fatal', () => {
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'dialog.claude',
    'not json at all',
    0,
  );
  assert.deepEqual(readSettings(db).dialogs, {});
});
