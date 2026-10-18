/** The character every escape sequence starts with. */
const ESC = '\u001b';

/** The bell an operating-system command may be closed with. */
const BEL = '\u0007';

/**
 * A model of the cells a terminal shows, rebuilt from the output written to it.
 *
 * A UI that redraws itself sends only the changed cells and moves the cursor
 * over the rest. Stripping the escape sequences would lose every character it
 * did not resend, so the class keeps the cells. It understands the cursor
 * movements and erases that the login CLIs use, and skips other sequences.
 */
export class Screen {
  /** The cells, by row. Short rows end where they end rather than in spaces. */
  private readonly rows: string[][] = [];
  /** The cursor row, from 0. */
  private row = 0;
  /** The cursor column, from 0. */
  private col = 0;
  /** A partial escape sequence, held until the rest of it arrives. */
  private pending = '';

  /**
   * Writes a chunk to the screen, and moves the cursor as the chunk says.
   *
   * @param chunk The output of the terminal program.
   */
  write(chunk: string): void {
    const text = this.pending + chunk;
    this.pending = '';
    let i = 0;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === ESC) {
        const taken = this.escape(text, i);
        // The chunk ended mid-sequence, so the class keeps it for the next one
        // rather than printing its letters as text.
        if (taken === null) {
          this.pending = text.slice(i);
          return;
        }
        i += taken;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
      } else if (ch === '\n') {
        this.row += 1;
      } else if (ch === '\b') {
        this.col = Math.max(0, this.col - 1);
      } else if (ch === BEL) {
        // A bell shows nothing.
      } else {
        this.put(ch);
      }
      i += 1;
    }
  }

  /**
   * The text on the screen, one line per row, with trailing blanks dropped.
   * Rows never written to are empty lines.
   *
   * @returns The text.
   */
  get text(): string {
    return this.rows
      .map((cells) =>
        cells
          .map((c) => c ?? ' ')
          .join('')
          .replace(/\s+$/, ''),
      )
      .join('\n');
  }

  /**
   * Puts one character where the cursor is, and steps over it.
   *
   * @param ch The character.
   */
  private put(ch: string): void {
    const cells = this.rows[this.row] ?? [];
    this.rows[this.row] = cells;
    for (let c = cells.length; c < this.col; c++) cells[c] = ' ';
    cells[this.col] = ch;
    this.col += 1;
  }

  /**
   * Reads one escape sequence and acts on it.
   *
   * @param text The text that holds the sequence.
   * @param at The index of the escape character.
   * @returns The length of the sequence, or null when the rest of the sequence has not arrived yet.
   */
  private escape(text: string, at: number): number | null {
    const next = text[at + 1];
    if (next === undefined) return null;

    // An operating-system command runs to a bell or a string terminator, and
    // draws nothing. Hyperlinks arrive as these.
    if (next === ']') {
      const bel = text.indexOf(BEL, at);
      const st = text.indexOf(`${ESC}\\`, at + 2);
      if (bel === -1 && st === -1) return null;
      const end = bel === -1 ? st + 2 : bel + 1;
      return end - at;
    }

    if (next !== '[') return 2;

    // A control sequence: parameters, then one letter that says what it does.
    let i = at + 2;
    while (i < text.length && /[0-9;?>]/.test(text.charAt(i))) i++;
    if (i >= text.length) return null;
    const final = text.charAt(i);
    const params = text.slice(at + 2, i).replace(/^[?>]/, '');
    const n = (fallback: number): number => {
      const first = Number.parseInt(params.split(';')[0] ?? '', 10);
      return Number.isNaN(first) ? fallback : first;
    };

    switch (final) {
      case 'G': // to an absolute column
        this.col = Math.max(0, n(1) - 1);
        break;
      case 'H': // to a row and a column
      case 'f': {
        const [r, c] = params.split(';');
        this.row = Math.max(0, (Number.parseInt(r ?? '', 10) || 1) - 1);
        this.col = Math.max(0, (Number.parseInt(c ?? '', 10) || 1) - 1);
        break;
      }
      case 'A':
        this.row = Math.max(0, this.row - n(1));
        break;
      case 'B':
        this.row += n(1);
        break;
      case 'C':
        this.col += n(1);
        break;
      case 'D':
        this.col = Math.max(0, this.col - n(1));
        break;
      case 'E':
        this.row += n(1);
        this.col = 0;
        break;
      case 'F':
        this.row = Math.max(0, this.row - n(1));
        this.col = 0;
        break;
      case 'J': // erase the display
        if (n(0) === 2) {
          this.rows.length = 0;
          this.row = 0;
          this.col = 0;
        } else if (n(0) === 0) {
          this.rows.length = this.row + 1;
          this.clearLine(0);
        }
        break;
      case 'K': // erase in the line
        this.clearLine(n(0));
        break;
      default:
        // Colour, cursor visibility and queries to the terminal change no cell.
        break;
    }
    return i - at + 1;
  }

  /**
   * Erases part of the cursor's row.
   *
   * @param mode 0 erases from the cursor to the end, 1 from the start to the cursor, 2 the whole row.
   */
  private clearLine(mode: number): void {
    const cells = this.rows[this.row];
    if (!cells) return;
    if (mode === 0) cells.length = Math.min(cells.length, this.col);
    else if (mode === 1) for (let c = 0; c <= this.col && c < cells.length; c++) cells[c] = ' ';
    else if (mode === 2) cells.length = 0;
  }
}
