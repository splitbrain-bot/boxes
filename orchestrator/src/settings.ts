import type { Settings, ThreadDialogDefaults } from '../../shared/types.ts';
import type { Db } from './db.ts';

/**
 * The deployment's plain settings, over the `settings` table.
 *
 * Everything here is configuration a person sets on the settings page and
 * nothing here is a secret, which is the whole difference from
 * `credentials.ts`. The git identity lived in the environment until now, and
 * only did so because the credentials it sat beside did.
 *
 * The table is a key/value store rather than a column per setting: the keys
 * are read and written whole by one page, nothing queries across them, and
 * adding one is then a constant here rather than a migration.
 */

/** Who a box commits as when nobody has said otherwise. */
export const DEFAULT_GIT_NAME = 'boxes-bot';
export const DEFAULT_GIT_EMAIL = 'boxes-bot@users.noreply.github.com';

/** The keys this module stores, spelled once. */
const GIT_NAME = 'git.name';
const GIT_EMAIL = 'git.email';

/** Where one harness's last dialog choice is kept. */
function dialogKey(harnessId: string): string {
  return `dialog.${harnessId}`;
}

/** Every setting, with the defaults filled in for whatever is unset. */
export function readSettings(db: Db): Settings {
  const stored = readAll(db);
  const dialogs: Record<string, ThreadDialogDefaults> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith('dialog.')) continue;
    const parsed = parseDialog(value);
    if (parsed) dialogs[key.slice('dialog.'.length)] = parsed;
  }
  return {
    gitName: stored[GIT_NAME] || DEFAULT_GIT_NAME,
    gitEmail: stored[GIT_EMAIL] || DEFAULT_GIT_EMAIL,
    dialogs,
  };
}

/**
 * Writes the settings a patch names and leaves the rest alone, then answers
 * with the whole of them.
 *
 * A field set to the empty string is a field cleared back to its default
 * rather than a box committing as nobody: the row is deleted, so the default
 * moving in a later release moves this deployment with it.
 *
 * The dialogs are merged one harness at a time. Two browsers configuring
 * different agents should not overwrite each other, and each entry is
 * replaced whole because it is one dialog's answer.
 */
export function patchSettings(db: Db, patch: Partial<Settings>): Settings {
  const writes: Array<[string, string | null]> = [];
  if (patch.gitName !== undefined) writes.push([GIT_NAME, patch.gitName.trim() || null]);
  if (patch.gitEmail !== undefined) writes.push([GIT_EMAIL, patch.gitEmail.trim() || null]);
  for (const [harnessId, defaults] of Object.entries(patch.dialogs ?? {})) {
    writes.push([dialogKey(harnessId), JSON.stringify(defaults)]);
  }

  const now = Date.now();
  db.transaction(() => {
    for (const [key, value] of writes) {
      if (value === null) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        continue;
      }
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(key, value, now);
    }
  })();

  return readSettings(db);
}

/** Every stored key, as strings. */
function readAll(db: Db): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * One dialog's stored answer, or null when it is not one.
 *
 * Written by the dashboard as JSON and read back here, so a row left by an
 * older release — or by anything else that has been at the table — is
 * ignored rather than allowed to fail the whole read.
 */
function parseDialog(value: string): ThreadDialogDefaults | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as ThreadDialogDefaults;
  } catch {
    return null;
  }
}
