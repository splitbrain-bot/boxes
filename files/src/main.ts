import { Duplex } from 'node:stream';
import { serveFiles } from './server.ts';

/**
 * The file service of a box. The orchestrator starts it in the box and
 * speaks HTTP/2 with it over its standard input and output. It ends when the
 * orchestrator closes the connection.
 *
 * The roots can be moved with environment variables, for tests outside a
 * box.
 */
// Node accepts a pair of Node streams here. Its type declarations know only
// the web stream pair.
const io = Duplex.from({
  readable: process.stdin,
  writable: process.stdout,
} as unknown as Parameters<typeof Duplex.from>[0]);
const server = serveFiles(io, {
  workspace: process.env.BOXES_FILES_WORKSPACE ?? '/workspace',
  home: process.env.BOXES_FILES_HOME ?? '/home/agent',
  nix: process.env.BOXES_FILES_NIX ?? '/nix',
  imageSkills: process.env.BOXES_FILES_IMAGE_SKILLS ?? '/usr/local/share/boxes/skills',
});
server.on('session', (session) => session.on('close', () => process.exit(0)));
process.stdin.on('end', () => process.exit(0));
