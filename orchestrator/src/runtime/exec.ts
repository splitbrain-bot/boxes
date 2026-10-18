/** Helpers for the commands that each runtime runs in a box. */

import type { Readable } from 'node:stream';

/**
 * Reads a stream to its end.
 *
 * @param stream The stream to read.
 * @param cap The maximum number of bytes to keep. The rest is read and dropped.
 * @returns The kept bytes, decoded as UTF-8.
 */
export async function readAll(stream: Readable, cap = Infinity): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    // Drain past the cap, so the command never blocks on a full stream.
    const buf = Buffer.from(chunk as Buffer);
    if (size < cap) chunks.push(size + buf.length <= cap ? buf : buf.subarray(0, cap - size));
    size += buf.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Wraps a command in the `timeout` command of the box image. The limit is rounded up to whole
 * seconds, and a command that survives SIGTERM gets SIGKILL five seconds later.
 *
 * @param cmd The argument vector of the command.
 * @param timeoutMs The time limit in milliseconds. Without it, the command is returned unchanged.
 * @returns A new argument vector.
 */
export function withTimeout(cmd: readonly string[], timeoutMs?: number): string[] {
  if (timeoutMs === undefined) return [...cmd];
  return ['timeout', '--kill-after=5s', `${Math.ceil(timeoutMs / 1000)}s`, ...cmd];
}
