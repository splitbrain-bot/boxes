import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { unpackTar } from './unpack.ts';

/**
 * The files of the orchestrator in the home: the CA of the egress proxy, and
 * the git configuration with the identity.
 */

/** The paths the orchestrator may write, relative to the home. */
export const SETUP_FILES = ['.boxes/proxy-ca.crt', '.config/git/config'];

/** Where the files are unpacked before they replace the old ones, relative to the home. */
const STAGE_DIR = '.boxes/setup-files.new';

/**
 * Writes the files of a tar stream into the home. A path outside
 * {@link SETUP_FILES} is refused, and then nothing changes.
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
