/** The most bytes of a file the file endpoint returns. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The most bytes read of REVIEW.md. */
export const MAX_REVIEW_BYTES = 8 * 1024 * 1024;

/** Splits file content into lines without terminators, tolerating CRLF. */
export function fileLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
