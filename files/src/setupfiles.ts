/** Installation of the setup files that the orchestrator sends into the home. */

import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { unpackTar } from './unpack.ts';

/** The paths that the orchestrator can write, relative to the home. */
export const SETUP_FILES = ['.boxes/proxy-ca.crt', '.config/git/config'];

/** The directory for the unpacked files before they replace the old files, relative to the home. */
const STAGE_DIR = '.boxes/setup-files.new';

/**
 * Writes the files of a tar stream into the home. The function unpacks the tar into a stage directory first, so a
 * refused entry changes no file in the home.
 *
 * @param home The home directory.
 * @param tar The files, as a tar stream of files relative to the home.
 * @throws {FileError} A 400 when an entry is outside {@link SETUP_FILES} or is not a plain file.
 */
export async function installSetupFiles(home: string, tar: Readable): Promise<void> {
  const stage = join(home, STAGE_DIR);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    const files = await unpackTar(tar, stage, (name) => (SETUP_FILES.includes(name) ? name : null));
    for (const file of files) {
      const target = join(home, file);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(stage, file), target);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
