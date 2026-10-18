import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { validRelativePath } from '../../shared/files.ts';
import { unpackTar } from './unpack.ts';

/**
 * The install of an agent set into the home: the instructions file and the
 * skills of each harness layout, and the skills of the box image.
 */

/** Where the install records what it put into the home, relative to the home. */
export const MANAGED_FILE = '.boxes/managed';

/** Where the set is unpacked before it replaces the last install, relative to the home. */
const STAGE_DIR = '.boxes/agent-set.new';

/** The skill directories of the harness layouts, relative to the home. */
const SKILL_DIRS = ['.claude/skills', '.agents/skills'];

/** The instructions files of the harness layouts, relative to the home. */
const INSTRUCTIONS_FILES = ['.claude/CLAUDE.md', '.codex/AGENTS.md'];

/**
 * The unit of an installed path: the path itself for an instructions file,
 * and the skill directory for a file in a skill. A unit is what the install
 * records and what the next install removes as a whole. Null for a path
 * outside the layouts.
 *
 * The layouts are fixed here, so a request or the managed file cannot name
 * `.ssh` or `.claude` as a whole.
 */
export function unitOf(path: string): string | null {
  if (!validRelativePath(path)) return null;
  if (INSTRUCTIONS_FILES.includes(path)) return path;
  for (const dir of SKILL_DIRS) {
    const match = new RegExp(`^${dir.replaceAll('.', '\\.')}/([^/]+)(?:/|$)`).exec(path);
    if (match) return `${dir}/${match[1]}`;
  }
  return null;
}

/**
 * Installs an agent set from a tar stream, and then the skills of the image.
 *
 * The tar is unpacked into a stage directory first, so a refused entry
 * changes nothing.
 *
 * @param home The home directory.
 * @param imageSkills The directory with the skills of the image, or undefined for none.
 * @param tar The set, as a tar stream of files relative to the home.
 */
export async function installAgentSet(
  home: string,
  imageSkills: string | undefined,
  tar: Readable,
): Promise<void> {
  const stage = join(home, STAGE_DIR);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  let units: Set<string>;
  try {
    units = await unpackTar(tar, stage, unitOf);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }

  removeManaged(home);
  // Recorded before the move, so an interrupted install is undone by the next one.
  writeFileSync(
    join(home, MANAGED_FILE),
    [...units]
      .sort()
      .map((u) => `${u}\n`)
      .join(''),
  );
  for (const unit of units) {
    const target = join(home, unit);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(join(stage, unit), target);
  }
  rmSync(stage, { recursive: true, force: true });

  if (imageSkills) installImageSkills(home, imageSkills, units);
}

/** Removes every unit the last install recorded, and the record. */
function removeManaged(home: string): void {
  const managed = join(home, MANAGED_FILE);
  if (!existsSync(managed)) return;
  for (const line of readFileSync(managed, 'utf8').split('\n')) {
    if (unitOf(line) !== line) continue;
    rmSync(join(home, line), { recursive: true, force: true });
  }
  rmSync(managed, { force: true });
}

/**
 * Copies each skill of the image into both skill layouts. A skill of the set
 * wins, and the set has a skill in every layout, so the check of one layout
 * is enough.
 */
function installImageSkills(home: string, imageSkills: string, units: Set<string>): void {
  if (!existsSync(imageSkills)) return;
  for (const entry of readdirSync(imageSkills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (units.has(`.claude/skills/${entry.name}`)) continue;
    for (const dir of SKILL_DIRS) {
      const target = join(home, dir, entry.name);
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { recursive: true, force: true });
      cpSync(join(imageSkills, entry.name), target, { recursive: true });
    }
  }
}
