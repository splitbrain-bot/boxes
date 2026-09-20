/** The character every escape sequence starts with. */
const ESC = '\u001b';

/** The bell an operating-system command may be closed with. */
const BEL = '\u0007';

/**
 * What a terminal would be showing, rebuilt from what was written to it.
 *
 * A UI that redraws itself sends only the cells that changed, stepping the
 * cursor over the ones it is leaving alone. Read by deleting the escape
 * sequences and joining what is left, such a stream loses every character it
 * did not resend: `Please make sure the full code was copied` arrives as
 * `Please makesure the fullcde wascopied`, a word short of its meaning and a
 * letter short of `code`. A token read the same way is a token with a
 * character missing, which is stored, delivered and refused.
 *
 * So the cells are kept instead. Writing moves a cursor over them and leaves
 * characters behind, which is what a terminal does, and {@link text} is what
 * one would be showing. Only the movements these CLIs use are understood;
 * anything else is skipped, because a sequence that draws nothing cannot
 * change what is on the screen.
 */
export class Screen {
  /** The cells, by row. Short rows end where they end rather than in spaces. */
  private readonly rows: string[][] = [];
  private row = 0;
  private col = 0;
  /** A partial escape sequence, held until the rest of it arrives. */
  private pending = '';

  /** Writes a chunk to the screen, moving the cursor as it says. */
  write(chunk: string): void {
    const text = this.pending + chunk;
    this.pending = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === ESC) {
        const taken = this.escape(text, i);
        // The chunk ended mid-sequence: keep it for the next one rather than
        // printing its letters as text.
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
   * Everything on the screen, one line per row and trailing blanks dropped.
   *
   * Rows nothing was ever written to are empty lines, which is what they look
   * like.
   */
  get text(): string {
    return this.rows
      .map((cells) => cells.map((c) => c ?? ' ').join('').replace(/\s+$/, ''))
      .join('\n');
  }

  /** Puts one character where the cursor is, and steps over it. */
  private put(ch: string): void {
    const cells = (this.rows[this.row] ??= []);
    for (let c = cells.length; c < this.col; c++) cells[c] = ' ';
    cells[this.col] = ch;
    this.col += 1;
  }

  /**
   * Reads one escape sequence and acts on it, answering how long it was.
   *
   * Null when the sequence is not all here yet, which is the caller's signal
   * to hold what is left of the chunk until the rest arrives.
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
    while (i < text.length && /[0-9;?>]/.test(text[i]!)) i++;
    if (i >= text.length) return null;
    const final = text[i]!;
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
        // Colour, cursor visibility, a query the CLI sends the terminal:
        // nothing that changes a cell.
        break;
    }
    return i - at + 1;
  }

  /** Erases part of the cursor's row: 0 to its end, 1 to its start, 2 all. */
  private clearLine(mode: number): void {
    const cells = this.rows[this.row];
    if (!cells) return;
    if (mode === 0) cells.length = Math.min(cells.length, this.col);
    else if (mode === 1) for (let c = 0; c <= this.col && c < cells.length; c++) cells[c] = ' ';
    else if (mode === 2) cells.length = 0;
  }
}
