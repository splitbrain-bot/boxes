import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar-stream';
import { FileError } from './ops.ts';

/**
 * Unpacks the plain files of a tar stream into a directory.
 *
 * @param tar The tar stream.
 * @param dir The directory the files go into, with the entry name as the relative path.
 * @param accept Maps an entry name to the value to return for it, or null to refuse it.
 * @returns The values that `accept` gave for the accepted entries.
 * @throws {FileError} A 400 for an entry that `accept` refuses or that is not a plain file.
 */
export async function unpackTar(
  tar: Readable,
  dir: string,
  accept: (name: string) => string | null,
): Promise<Set<string>> {
  const accepted = new Set<string>();
  const entries = extract();
  entries.on('entry', (header, stream, next) => {
    const value = accept(header.name);
    if (value === null || header.type !== 'file') {
      // The refusal also makes the entry stream fail, and no other listener handles that error.
      stream.on('error', () => {});
      stream.resume();
      next(new FileError(400, `refused entry: ${header.name}`));
      return;
    }
    accepted.add(value);
    const path = join(dir, header.name);
    mkdirSync(dirname(path), { recursive: true });
    pipeline(stream, createWriteStream(path, { mode: header.mode & 0o777 })).then(
      () => next(),
      (err: Error) => next(err),
    );
  });
  // `pipe` leaves the tar stream open after a refused entry, because the server sends the refusal as the reply on it.
  await new Promise<void>((resolve, reject) => {
    entries.on('finish', resolve);
    entries.on('error', reject);
    tar.on('error', reject);
    tar.pipe(entries);
  });
  return accepted;
}
