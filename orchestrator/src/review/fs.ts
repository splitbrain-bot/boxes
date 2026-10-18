/** The most bytes of a workspace file that the review reads or saves. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The most bytes of REVIEW.md that the review reads. */
export const MAX_REVIEW_BYTES = 8 * 1024 * 1024;

/**
 * Splits file content into lines without terminators, tolerating CRLF. A final
 * newline adds no empty last line.
 *
 * @param content The content of the file.
 * @returns The lines.
 */
export function fileLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
