import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, test } from 'vitest';
import { FileError } from './ops.ts';
import { installSetupFiles } from './setupfiles.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'boxes-setupfiles-'));
  mkdirSync(join(home, '.boxes'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A tar stream of the given files, relative to the home. */
function tar(files: Record<string, string>): Readable {
  const p = pack();
  for (const [name, content] of Object.entries(files)) p.entry({ name, size: content.length }, content);
  p.finalize();
  return Readable.from(p);
}

test('writes the CA and the git configuration into the home', async () => {
  await installSetupFiles(home, tar({ '.boxes/proxy-ca.crt': 'PEM', '.config/git/config': '[user]\n' }));
  assert.equal(readFileSync(join(home, '.boxes/proxy-ca.crt'), 'utf8'), 'PEM');
  assert.equal(readFileSync(join(home, '.config/git/config'), 'utf8'), '[user]\n');
  assert.equal(existsSync(join(home, '.boxes/setup-files.new')), false);
});

test('replaces the files of the last start', async () => {
  await installSetupFiles(home, tar({ '.config/git/config': 'old' }));
  await installSetupFiles(home, tar({ '.config/git/config': 'new' }));
  assert.equal(readFileSync(join(home, '.config/git/config'), 'utf8'), 'new');
});

test('any other path is refused, and nothing changes', async () => {
  await assert.rejects(
    installSetupFiles(home, tar({ '.config/git/config': 'x', '.bashrc': 'rm -rf /' })),
    (err: FileError) => err.status === 400 && /\.bashrc/.test(err.message),
  );
  assert.equal(existsSync(join(home, '.config')), false);
  assert.equal(existsSync(join(home, '.bashrc')), false);
  assert.equal(existsSync(join(home, '.boxes/setup-files.new')), false);
});
