import { duplexPair } from 'node:stream';
import { serveFiles, type Roots } from '../../files/src/server.ts';
import type { FileServiceSpawner } from './files.ts';

/**
 * A spawner for tests: it runs the real file service in this process, on
 * directories of this machine, and needs no Docker.
 *
 * `rootsOf` names the directories for a container id. A test that uses the
 * box id as the container id can derive them from the box.
 */
export function inProcessFileService(rootsOf: (containerId: string) => Roots): FileServiceSpawner {
  return async (containerId) => {
    const [server, client] = duplexPair();
    serveFiles(server, rootsOf(containerId));
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
