import type { ExecLogPage, ExecRecord } from '../../../../shared/types.ts';

/**
 * Local commands: the `!bang` escape hatch.
 *
 * A composer line starting with `!` runs in the session container and never
 * reaches the model, so it costs no tokens and cannot be misread as an
 * instruction. The orchestrator streams the combined output back as chunked
 * text, ending with a trailer line carrying the exit code.
 */

/** The trailer the orchestrator ends an exec response with. */
const TRAILER = /\n\[exit (\d+|null)(?: (truncated|timed out|truncated, timed out))?\]\n?$/;

/** The prefix that makes a composer line a local command. */
export const BANG = '!';

/** The command in a bang line, or null when it is not one. */
export function bangCommand(text: string): string | null {
  if (!text.startsWith(BANG)) return null;
  const command = text.slice(BANG.length).trim();
  return command || null;
}

/** What a finished run reports back. */
export interface ExecOutcome {
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Runs one command and streams its output.
 *
 * `onChunk` is called with the output so far, so a caller can render it
 * growing; the promise resolves once the trailer has been read.
 */
export async function runExec(
  sessionId: string,
  command: string,
  onChunk: (outputSoFar: string) => void,
  signal?: AbortSignal,
): Promise<ExecOutcome> {
  const res = await fetch(`/api/sessions/${sessionId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    const message = await res.text().catch(() => '');
    throw new Error(message || `${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // The trailer is only meaningful once the stream ends, so what is shown
    // mid-run is the output with any partial trailer left off.
    onChunk(stripTrailer(buffer));
  }
  buffer += decoder.decode();

  const outcome = readTrailer(buffer);
  onChunk(stripTrailer(buffer));
  return outcome;
}

/** The output without its trailer line. */
function stripTrailer(text: string): string {
  return text.replace(TRAILER, '');
}

/** The exit code and flags a finished response ends with. */
function readTrailer(text: string): ExecOutcome {
  const match = TRAILER.exec(text);
  if (!match) return { exitCode: null, truncated: false, timedOut: false };
  const flags = match[2] ?? '';
  return {
    exitCode: match[1] === 'null' ? null : Number(match[1]),
    truncated: flags.includes('truncated'),
    timedOut: flags.includes('timed out'),
  };
}

/**
 * Every command already run in this session.
 *
 * ACP replay carries no timestamps, so these are appended after the replayed
 * transcript rather than interleaved into it.
 */
export async function listExec(sessionId: string): Promise<ExecRecord[]> {
  const res = await fetch(`/api/sessions/${sessionId}/exec`);
  if (!res.ok) return [];
  const page = (await res.json()) as ExecLogPage;
  return page.records ?? [];
}
