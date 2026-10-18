/**
 * The entry point of the file service in a box. The orchestrator starts the service and sends HTTP/2 over its
 * standard input and output. The service ends when the orchestrator closes the connection.
 *
 * Environment variables can change the roots, for tests outside a box.
 */

import { Duplex } from 'node:stream';
import { serveFiles } from './server.ts';

/** The connection to the orchestrator over standard input and output. */
const io = Duplex.from({
  readable: process.stdin,
  writable: process.stdout,
  // Node accepts a pair of Node streams here, but its type declarations know only the web stream pair.
} as unknown as Parameters<typeof Duplex.from>[0]);
/** The HTTP/2 server on the connection. */
const server = serveFiles(io, {
  workspace: process.env.BOXES_FILES_WORKSPACE ?? '/workspace',
  home: process.env.BOXES_FILES_HOME ?? '/home/agent',
  nix: process.env.BOXES_FILES_NIX ?? '/nix',
  imageSkills: process.env.BOXES_FILES_IMAGE_SKILLS ?? '/usr/local/share/boxes/skills',
});
server.on('session', (session) => session.on('close', () => process.exit(0)));
process.stdin.on('end', () => process.exit(0));
