import type { Settings, ThreadDialogDefaults } from '../../shared/types.ts';
import type { Db } from './db.ts';

/**
 * The deployment's settings that are not secrets, stored as key/value rows in
 * the `settings` table. A new setting needs a key, not a migration.
 */

/** The git author name a box commits as when none is set. */
export const DEFAULT_GIT_NAME = 'boxes-bot';

/** The git author email a box commits as when none is set. */
export const DEFAULT_GIT_EMAIL = 'boxes-bot@users.noreply.github.com';

/** Settings key of the git author name. */
const GIT_NAME = 'git.name';

/** Settings key of the git author email. */
const GIT_EMAIL = 'git.email';

/** Returns the settings key that holds one harness's last dialog choice. */
function dialogKey(harnessId: string): string {
  return `dialog.${harnessId}`;
}

/** Returns every setting, with the default filled in for each unset one. */
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
 * Writes the settings the patch names, leaves the rest alone, and returns all
 * settings.
 *
 * An empty git name or email deletes the row, so the setting falls back to
 * the current default.
 *
 * Dialogs are merged per harness, so two browsers that configure different
 * agents do not overwrite each other. Each harness entry is replaced whole.
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

/** Returns every stored row as a map of key to value. */
function readAll(db: Db): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Parses one stored dialog choice, or returns null when the value is not a
 * JSON object. A bad row is skipped, so it cannot fail the whole read.
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
