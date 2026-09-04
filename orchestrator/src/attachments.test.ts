import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { safeAttachmentName, storeAttachment, ATTACHMENTS_DIR } from './attachments.ts';

/**
 * Uploaded files landing in a workspace: that a name cannot become a path,
 * that it cannot become a line of the prompt it is quoted into, and that
 * nothing is ever silently overwritten.
 */

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'boxes-attach-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test('an ordinary name is kept as it is', () => {
  assert.equal(safeAttachmentName('screenshot.png'), 'screenshot.png');
  assert.equal(safeAttachmentName('report-2026.final.pdf'), 'report-2026.final.pdf');
});

test('a name cannot climb out of the attachments directory', () => {
  assert.equal(safeAttachmentName('../../etc/passwd'), 'passwd');
  assert.equal(safeAttachmentName('/etc/shadow'), 'shadow');
  assert.equal(safeAttachmentName('..\\..\\windows\\system.ini'), 'system.ini');
  // Nothing but dots is nothing, rather than a name that means the parent.
  assert.equal(safeAttachmentName('..'), 'attachment');
});

test('a name cannot forge a line of the prompt it is quoted into', () => {
  // The envelope is a list of "- path (type, size)" lines. A newline in a
  // name would end the line early and let the rest be read as another entry,
  // and a bracket would break the format the dashboard parses back.
  assert.equal(safeAttachmentName('a.png\n- passwd'), 'a.png_-_passwd');
  assert.ok(!safeAttachmentName('a.png\r\n- passwd (text/plain, 1 B)').includes('\n'));
  assert.ok(!safeAttachmentName('x (1).png').includes('('));
  assert.ok(!/\s/.test(safeAttachmentName('two words.txt')));
});

test('a leading dot is dropped, so an upload cannot become the ignore file', () => {
  assert.equal(safeAttachmentName('.gitignore'), 'gitignore');
  assert.equal(safeAttachmentName('.hidden.txt'), 'hidden.txt');
});

test('unicode letters survive; the extension survives a long name', () => {
  assert.equal(safeAttachmentName('Größe.png'), 'Größe.png');
  const long = safeAttachmentName(`${'a'.repeat(400)}.png`);
  assert.ok(long.length <= 100);
  assert.ok(long.endsWith('.png'));
});

test('an empty or nameless upload still gets a name', () => {
  assert.equal(safeAttachmentName(''), 'attachment');
  assert.equal(safeAttachmentName('???'), 'attachment');
});

test('storing writes the file and reports a workspace-relative path', () => {
  const stored = storeAttachment(workspace, 'shot.png', Buffer.from('hello'));

  assert.equal(stored.name, 'shot.png');
  assert.equal(stored.path, `${ATTACHMENTS_DIR}/shot.png`);
  assert.equal(stored.size, 5);
  assert.equal(readFileSync(join(workspace, stored.path), 'utf8'), 'hello');
  assert.ok(statSync(join(workspace, ATTACHMENTS_DIR)).isDirectory());
});

test('the attachments directory carries a gitignore that hides it whole', () => {
  storeAttachment(workspace, 'shot.png', Buffer.from('x'));
  // Inside .boxes rather than in the repository's own .gitignore, which is a
  // file the user owns; `*` covers this file too, so nothing shows up in a
  // git status the user reads.
  assert.equal(readFileSync(join(workspace, '.boxes', '.gitignore'), 'utf8'), '*\n');
});

test('a second file of the same name is suffixed, not overwritten', () => {
  const first = storeAttachment(workspace, 'shot.png', Buffer.from('one'));
  const second = storeAttachment(workspace, 'shot.png', Buffer.from('two'));

  assert.equal(first.name, 'shot.png');
  assert.equal(second.name, 'shot-2.png');
  assert.equal(readFileSync(join(workspace, first.path), 'utf8'), 'one');
  assert.equal(readFileSync(join(workspace, second.path), 'utf8'), 'two');
});
