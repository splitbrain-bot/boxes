/**
 * Names a line or a block of lines, for a label.
 *
 * @param line The line, or the first line of the block.
 * @param endLine The last line of the block, or 0 for one line.
 * @returns "line 12" for one line, or "lines 10 to 14" for a block.
 */
export function lineRange(line: number, endLine: number): string {
  return endLine > 0 ? `lines ${line} to ${endLine}` : `line ${line}`;
}
