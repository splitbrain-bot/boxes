/** Installation of an agent set and of the skills of the box image into the home. */

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

/** The file that records the units of the last install, relative to the home. */
export const MANAGED_FILE = '.boxes/managed';

/** The directory for the unpacked set before it replaces the last install, relative to the home. */
const STAGE_DIR = '.boxes/agent-set.new';

/** The skill directories of the harness layouts, relative to the home. */
const SKILL_DIRS = ['.claude/skills', '.agents/skills'];

/** The instructions files of the harness layouts, relative to the home. */
const INSTRUCTIONS_FILES = ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md'];

/**
 * Returns the unit of an installed path. The unit of an instructions file is the file itself. The unit of a file in a
 * skill is the skill directory. The install records units, and the next install removes each unit as a whole.
 *
 * The layouts are fixed, so a tar entry or a line of the managed file cannot name `.ssh` or `.claude` as a whole.
 *
 * @param path The path, relative to the home.
 * @returns The unit, or null for a path outside the layouts.
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
 * The function unpacks the tar into a stage directory first, so a refused entry changes nothing in the home.
 *
 * @param home The home directory.
 * @param imageSkills The directory with the skills of the image, or undefined for none.
 * @param tar The set, as a tar stream of files relative to the home.
 * @throws {FileError} A 400 when an entry is outside the layouts or is not a plain file.
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
  // The record comes before the move, so the next install removes the units of an interrupted install.
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

/**
 * Removes every unit that the last install recorded, and the record.
 *
 * @param home The home directory.
 */
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
 * Copies each skill of the image into every skill layout. A skill of the set with the same name has priority.
 *
 * The function looks for a skill of the set only in `.claude/skills`. This check is sufficient because
 * `AgentStore.pack` in the orchestrator writes each skill of the set into every harness layout.
 *
 * @param home The home directory.
 * @param imageSkills The directory with the skills of the image.
 * @param units The units of the set.
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
