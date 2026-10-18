import { duplexPair } from 'node:stream';
import { type Roots, serveFiles } from '../../files/src/server.ts';
import type { FileServiceSpawner } from './files.ts';

/**
 * Makes a spawner for tests. The spawner runs the real file service in the orchestrator process, on
 * local directories, and needs no runtime.
 *
 * @param rootsOf Returns the directories that the file service serves for a box id.
 * @returns The spawner.
 */
export function inProcessFileService(rootsOf: (boxId: string) => Roots): FileServiceSpawner {
  return async (boxId) => {
    const [server, client] = duplexPair();
    serveFiles(server, rootsOf(boxId));
    let end: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      end = resolve;
    });
    client.on('close', () => end(0));
    return {
      io: client,
      exited,
      kill: () => {
        client.destroy();
        server.destroy();
      },
    };
  };
}
