/**
 * The setup of a box after it started. The start and this setup make a box
 * ready.
 */

import { Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { fileService, NOT_IN_IMAGE, OutdatedImageError } from './files.ts';
import type { Logger } from './log.ts';
import { runtime } from './runtime/runtime.ts';

/** The command in the box image that sets up the home for the tools of the image. */
export const SETUP_COMMAND = 'boxes-setup';

/** How long the setup in the box may run, in milliseconds. */
const SETUP_TIMEOUT_MS = 60_000;

/** How many bytes of the setup output are kept, for the warnings and the error message. */
const SETUP_OUTPUT_BYTES = 16 * 1024;

/** Where the orchestrator writes the CA of the egress proxy, relative to the home. */
const CA_FILE = '.boxes/proxy-ca.crt';

/**
 * Where the orchestrator writes the git configuration, relative to the home.
 * Git reads it as global configuration, and `~/.gitconfig` of the agent wins
 * over it.
 */
const GIT_CONFIG_FILE = '.config/git/config';

/** What the orchestrator writes into the home of a box. */
export interface SetupInputs {
  /** PEM of the deployment CA, or empty when there is none. */
  caCertificate: string;
  /** The git identity from the settings. */
  identity: { gitName: string; gitEmail: string };
  /** The agent set, as a tar stream of files relative to the home. */
  agentSet: Readable;
}

/**
 * Sets up a started box: the files of the orchestrator, then `boxes-setup`,
 * then the agent set.
 *
 * Each warning of the setup goes to the log, because the exec output does
 * not reach the container log.
 *
 * @param boxId The id of the box.
 * @param inputs The CA, the git identity and the agent set.
 * @param slog The logger of the box.
 * @throws OutdatedImageError when the image has no setup command or no current file service.
 * @throws Error when a step fails, with the output of `boxes-setup` when that step fails.
 */
export async function setUpBox(boxId: string, inputs: SetupInputs, slog: Logger): Promise<void> {
  const files = fileService(boxId);
  await files.installSetupFiles(setupFiles(inputs));

  const result = await runtime().run(boxId, [SETUP_COMMAND], {
    timeoutMs: SETUP_TIMEOUT_MS,
    maxOutput: SETUP_OUTPUT_BYTES,
  });
  for (const line of result.stderr.split('\n')) {
    if (line.includes('WARNING')) slog.warn('box setup', { message: line.trim() });
  }
  if (result.code !== 0) {
    if (result.code !== null && NOT_IN_IMAGE.has(result.code)) {
      throw new OutdatedImageError(
        `This box has no ${SETUP_COMMAND}. The box needs an image with the current setup.`,
      );
    }
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(`${SETUP_COMMAND} exited ${result.code ?? 'without a code'}: ${output}`);
  }

  await files.installAgentSet(inputs.agentSet);
}

/**
 * Returns the files of the orchestrator as a tar stream: the CA, when there is one, and the git configuration.
 *
 * @param inputs The CA and the git identity.
 * @returns The tar stream, with paths relative to the home.
 */
export function setupFiles(inputs: Pick<SetupInputs, 'caCertificate' | 'identity'>): Readable {
  const tar = pack();
  if (inputs.caCertificate !== '') {
    tar.entry(
      { name: CA_FILE, mode: 0o644, size: Buffer.byteLength(inputs.caCertificate) },
      inputs.caCertificate,
    );
  }
  const config = gitConfig(inputs.identity);
  tar.entry({ name: GIT_CONFIG_FILE, mode: 0o644, size: Buffer.byteLength(config) }, config);
  tar.finalize();
  return Readable.from(tar);
}

/**
 * Returns the git configuration of a box: the identity, `main` as the default
 * branch, no advice on a detached HEAD, and every directory as safe, so git does
 * not refuse a checkout whose owner differs from the agent, for example after a restore.
 *
 * @param identity The git name and email.
 * @returns The content of the configuration file.
 */
function gitConfig(identity: SetupInputs['identity']): string {
  return [
    '[user]',
    `\tname = ${quoted(identity.gitName)}`,
    `\temail = ${quoted(identity.gitEmail)}`,
    '[init]',
    '\tdefaultBranch = main',
    '[advice]',
    '\tdetachedHead = false',
    '[safe]',
    '\tdirectory = *',
    '',
  ].join('\n');
}

/**
 * Returns a git configuration value in quotes, with the characters escaped that git reads as syntax.
 *
 * @param value The value.
 * @returns The quoted value.
 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
