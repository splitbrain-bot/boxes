import { duplexPair } from 'node:stream';
import { type Roots, serveFiles } from '../../files/src/server.ts';
import type { FileServiceSpawner } from './files.ts';

/**
 * A spawner for tests: it runs the real file service in this process, on
 * directories of this machine, and needs no runtime.
 *
 * `rootsOf` names the directories for a box id.
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
