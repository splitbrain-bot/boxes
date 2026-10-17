import type { Readable } from 'node:stream';

/** Helpers for the commands that each runtime runs in a box. */

/** Everything a stream will produce, as one string, up to a cap on its bytes. */
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

/** A command wrapped in the box's own `timeout`, when it is given a limit. */
export function withTimeout(cmd: readonly string[], timeoutMs?: number): string[] {
  if (timeoutMs === undefined) return [...cmd];
  return ['timeout', '--kill-after=5s', `${Math.ceil(timeoutMs / 1000)}s`, ...cmd];
}
