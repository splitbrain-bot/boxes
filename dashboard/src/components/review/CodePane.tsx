import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReviewAnnotation, ReviewLineChange } from '../../../../shared/types.ts';
import { Notice } from '@/components/Notice';
import { withinLineLimit, type Token } from '@/lib/highlight';
import { cn } from '@/lib/utils';
import { recallScroll, rememberScroll } from '../../stores/review.ts';

/** What a changed line gets in its gutter and behind its code. */
const CHANGE: Record<ReviewLineChange, { bar: string; row: string; label: string }> = {
  added: { bar: 'bg-ok', row: 'bg-ok/8', label: 'added' },
  modified: { bar: 'bg-warn', row: 'bg-warn/8', label: 'modified' },
};

/**
 * How wide the gutter is: the line numbers, the two marker bars, and the
 * padding around them, with room to spare.
 *
 * One width for every row rather than each row sizing to its own content,
 * because the editing overlay starts where the code cells do and has to agree
 * with them to the pixel. A gutter that grew by a few pixels at line 100 would
 * put every character of the rows past it out by those pixels. It is also what
 * a comment card indents by, so the cards line up with the code too.
 */
function gutterWidth(digits: number): string {
  return `calc(${digits}ch + 2.75rem)`;
}

/** The gutter's width, wherever something has to agree with it. */
const GUTTER = 'var(--review-gutter)';

/**
 * A line to bring into view, and which request asked for it.
 *
 * The nonce is what makes each request its own. Prev/next lands on the line
 * that is already the target whenever a file holds one change, and whenever a
 * step wraps round to where it started — and both of those have to scroll.
 */
export interface ScrollTarget {
  line: number;
  nonce: number;
}

/** A buffer being edited, and the way to change it. */
interface CodeEdit {
  text: string;
  onChange: (text: string) => void;
}

export interface CodePaneProps {
  /**
   * The pane's scroller, held by the view because holding the reader's place
   * across a mode switch means measuring it before the switch and putting it
   * back after — neither of which is this component's moment.
   */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /**
   * The open file's path, which is what the remembered scroll position is
   * keyed by — and which file this is, when one replaces another in the same
   * pane.
   */
  path: string;
  content: string;
  /** One token list per line, or null to render the file plain. */
  tokens: Token[][] | null;
  /**
   * The text those tokens were made from, which typing outruns: a line the
   * tokens no longer describe is rendered plain until they catch up, rather
   * than painted with the colours of what used to be there.
   */
  tokensFor: string;
  /** Changed lines, keyed by line number as the API sends them. */
  diffLines: Record<string, ReviewLineChange>;
  /** Deletion markers, by the line they sit after. */
  deletions: Map<number, number>;
  /**
   * The hunk each line sits in, by line number, for the gutter to open.
   * Context lines count: standing next to a change and asking what happened
   * here has one answer.
   */
  hunkByLine: Map<number, number>;
  annotations: Map<number, ReviewAnnotation>;
  /** The line whose composer is open, or null. */
  composing: number | null;
  /** Wrap long lines instead of scrolling them. */
  wrap: boolean;
  /** A line to scroll to once, when prev/next asks for it. */
  scrollTo: ScrollTarget | null;
  /** The buffer being edited, or null when the file is being read. */
  edit: CodeEdit | null;
  onSelectLine: (line: number) => void;
  onShowHunk: (hunkIndex: number) => void;
  /** Renders the card and composer that sit under a line. */
  renderUnderLine?: (line: number) => React.ReactNode;
}

/**
 * The file, one addressable row per line.
 *
 * A CSS grid rather than a `<pre>`: the line-number gutter is sticky against
 * the pane's horizontal scroll, the code cell scrolls as one block so the
 * numbers stay put, and every line is its own element — which is what makes
 * tapping one to comment possible at all.
 *
 * Tap replaces hover throughout, and the row is split between the two things
 * a reader does to a line. The gutter is the change: tapping it opens the hunk
 * around that line, which is where the desktop tool's hover tooltip went and
 * the only place deleted lines exist. The code is the comment: tapping it
 * opens the composer, and comments are inline cards under their line on every
 * screen size.
 *
 * That way round because the code cell is the larger target by far and
 * commenting is the frequent act, while a gutter with no hunk behind it —
 * every line of a file git does not track yet — is not a target at all.
 *
 * These same rows are also the editor. Edit mode floats a transparent
 * textarea over the code column and leaves the rows behind it to do the
 * highlighting: same font, same wrapping, same gutter, so a switch between
 * reading and editing changes no measurement on the screen. An editor
 * component would have brought its own highlighter, its own gutter and its own
 * line heights, and moved the code out from under the reader on the way in.
 *
 * What a switch does move is the comment cards, the composer and the deletion
 * markers, which fold away: the textarea is one run of text and nothing can
 * sit between its lines. The view holds the reader's line across that, with
 * `lib/anchor.ts`.
 *
 * A file past the line limit gets none of this. It is shown as one block of
 * plain text under a notice saying so, because tens of thousands of rows are
 * more than a phone can lay out — and with no rows there is no gutter, no line
 * to tap and nothing to edit.
 *
 * File content and comments are agent-influenced and hostile by assumption, so
 * both are rendered as text nodes only. Highlight tokens become React
 * elements; nothing here goes near `dangerouslySetInnerHTML`.
 */
export function CodePane({
  scrollRef,
  path,
  content,
  tokens,
  tokensFor,
  diffLines,
  deletions,
  hunkByLine,
  annotations,
  composing,
  wrap,
  scrollTo,
  edit,
  onSelectLine,
  onShowHunk,
  renderUnderLine,
}: CodePaneProps) {
  /** The path this pane has already positioned, so a poll does not re-do it. */
  const positioned = useRef<string | null>(null);
  const editing = edit !== null;
  /** What the pane is showing: the buffer while editing, the file otherwise. */
  const source = edit ? edit.text : content;
  /** Whether this file is too long to be read a line at a time. */
  const tooLong = !withinLineLimit(source);

  /**
   * Puts each file back where it was left, and every file this review has not
   * opened at the top.
   *
   * One pane serves every file, so the scroll offset survives the swap unless
   * something says otherwise, and a 40-line file would open half way down
   * after a long one. Before paint, so the reader never sees the wrong
   * position; keyed on the path, so the poll refetching the open file does
   * not throw away where they had got to.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || positioned.current === path) return;
    positioned.current = path;
    element.scrollTop = recallScroll(path);
  }, [scrollRef, path, content]);

  /**
   * Brings the line prev/next asked for into the middle of the pane.
   *
   * Every line of the file is a row of its own, so the row is in the document
   * by the time this runs; what it waits for is the request, which is a new
   * object each time even where the line is the one already showing.
   */
  useEffect(() => {
    if (!scrollTo) return;
    scrollRef.current
      ?.querySelector(`[data-line="${scrollTo.line}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [scrollRef, scrollTo]);

  /** Records where the reader is, for the next time they open this file. */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = (): void => rememberScroll(path, element.scrollTop);
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [scrollRef, path]);

  const lines = useMemo(() => (tooLong ? [] : splitLines(source)), [source, tooLong]);
  /** The lines the tokens describe, which is the file itself until it is typed in. */
  const tokenLines = useMemo(
    () => (tokensFor === source ? lines : splitLines(tokensFor)),
    [tokensFor, source, lines],
  );
  // The gutter's width follows the file's size rather than being fixed, so a
  // 30-line file does not reserve room for five digits.
  const digits = Math.max(String(lines.length).length, 2);
  // Editing always wraps. A textarea that scrolls sideways scrolls
  // independently of the rows behind it, and the two would part company on the
  // first long line.
  const wrapped = wrap || editing;

  return (
    <div
      ref={scrollRef}
      data-slot="review-code-pane"
      className={cn(
        // 16px on a phone, because Safari zooms the page when a control below
        // that takes focus — which is the one thing edit mode cannot afford.
        // The same size in both modes, so switching moves nothing.
        'min-h-0 flex-1 overflow-auto font-mono text-[16px] leading-[1.55] md:text-[13px]',
        // The pane scrolls, not the page: the header and the toolbar stay put.
        wrapped || tooLong ? 'overflow-x-hidden' : 'overflow-x-auto',
      )}
    >
      {tooLong ? (
        <>
          <Notice tone="warn" className="border-b px-3 py-1.5 text-xs">
            This file is too long to review line by line. It is shown as plain text, so it has no
            line numbers, no comments and no edit mode.
          </Notice>
          <pre className="px-2 py-1 whitespace-pre-wrap break-words">{source}</pre>
        </>
      ) : (
        <div
          className={cn('relative min-w-full', editing && 'pb-[1.55em]')}
          style={{ '--review-gutter': gutterWidth(digits) } as React.CSSProperties}
        >
          {deletions.has(0) && !editing ? (
            <DeletionMarker hunkIndex={deletions.get(0)!} onShowHunk={onShowHunk} />
          ) : null}

          {lines.map((text, index) => (
            <Row
              key={index + 1}
              line={index + 1}
              text={text}
              tokens={tokenLines[index] === text ? (tokens?.[index] ?? null) : null}
              change={diffLines[String(index + 1)]}
              annotation={annotations.get(index + 1)}
              composing={composing === index + 1}
              hunkIndex={hunkByLine.get(index + 1)}
              deletionHunk={deletions.get(index + 1)}
              wrap={wrapped}
              editing={editing}
              under={editing ? null : (renderUnderLine?.(index + 1) ?? null)}
              onSelectLine={onSelectLine}
              onShowHunk={onShowHunk}
            />
          ))}

          {edit ? <Editor text={edit.text} onChange={edit.onChange} /> : null}
        </div>
      )}
    </div>
  );
}

/**
 * One line: its row, whatever was deleted after it, and whatever sits under it.
 *
 * Memoized because typing re-renders the whole file on every keystroke, and a
 * long file is thousands of rows. Unchanged lines then cost a comparison each
 * rather than a render, which is the difference between a pane that keeps up
 * with a thumb and one that does not.
 */
const Row = memo(function Row({
  line,
  text,
  tokens,
  change,
  annotation,
  composing,
  hunkIndex,
  deletionHunk,
  wrap,
  editing,
  under,
  onSelectLine,
  onShowHunk,
}: {
  line: number;
  text: string;
  /** This line's colours, or null while it is rendered plain. */
  tokens: Token[] | null;
  change: ReviewLineChange | undefined;
  annotation: ReviewAnnotation | undefined;
  /** The composer is open on this line. */
  composing: boolean;
  hunkIndex: number | undefined;
  /** The hunk of the lines deleted after this one, or undefined for none. */
  deletionHunk: number | undefined;
  wrap: boolean;
  editing: boolean;
  under: React.ReactNode;
  onSelectLine: (line: number) => void;
  onShowHunk: (hunkIndex: number) => void;
}) {
  return (
    <Fragment>
      <div
        data-line={line}
        className={cn(
          'group grid grid-cols-[auto_1fr] items-start',
          change && CHANGE[change].row,
          (composing || annotation) && 'bg-primary/8',
        )}
      >
        <Gutter
          line={line}
          change={change}
          annotated={annotation !== undefined}
          outdated={annotation?.outdated ?? false}
          active={composing || annotation !== undefined}
          // While editing, the gutter is a label rather than a target: the
          // hunk sheet would take the keyboard away mid-sentence, and the
          // markers behind it are the last save's rather than this keystroke's.
          hunkIndex={editing ? undefined : hunkIndex}
          onShowHunk={onShowHunk}
        />

        {/* Tapping the code is how a comment starts.
            Not a <button>: WebKit and Firefox make text inside one
            unselectable, and a line of a review is a line somebody
            copies out. So a tap and the end of a drag share this
            element and are told apart below.
            And no aria-label: a button names itself from what is
            inside it, so labelling this one would replace the line of
            code with the word "comment" for anybody listening to the
            file rather than looking at it. The name is the line.
            While editing it is none of that — the textarea over it is what
            takes the taps, and a row behind one must not take the focus. */}
        <code
          role={editing ? undefined : 'button'}
          tabIndex={editing ? undefined : 0}
          onClick={
            editing
              ? undefined
              : (event) => {
                  if (!selecting(event)) onSelectLine(line);
                }
          }
          onKeyDown={
            editing
              ? undefined
              : (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectLine(line);
                  }
                }
          }
          className={cn(
            'block pr-3 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            // Wrapping: `min-w-0` is what makes it wrap at the pane's width.
            // A grid item is at least as wide as its longest unbreakable run
            // unless it is told otherwise, and `break-word` does not count as
            // breakable for that measurement — so one long URL in a line makes
            // the cell wider than the pane, and the line wraps later than the
            // textarea over it does, or not at all.
            wrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre',
          )}
        >
          {tokens ? <Tokens tokens={tokens} /> : text}
          {/* A zero-width space keeps an empty line the height of a
              full one, so the gutter and the code never drift apart. */}
          {text === '' ? '​' : null}
        </code>
      </div>

      {deletionHunk !== undefined && !editing ? (
        <DeletionMarker hunkIndex={deletionHunk} onShowHunk={onShowHunk} />
      ) : null}

      {under ? (
        <div className="grid grid-cols-[auto_1fr]">
          <span aria-hidden style={{ width: GUTTER }} />
          <div className="min-w-0 px-2 py-1.5">{under}</div>
        </div>
      ) : null}
    </Fragment>
  );
});

/**
 * Edit mode: a textarea over the code, with the rows behind it showing
 * through.
 *
 * Transparent text and a visible caret, so what is read is the highlighted
 * rows and what is typed into is the textarea. Everything that decides where a
 * character lands — the font, the size, the line height, the padding, the
 * wrapping — is inherited or matched, because the two have to agree to the
 * pixel or the caret drifts away from the letters.
 *
 * A plain textarea is also what makes the phone's own keyboard, selection
 * handles and undo work, none of which a rewritten editing surface gets for
 * free. Spelling and autocorrect are off: this is code, and a phone keyboard
 * left to itself will capitalize it.
 *
 * It does not take the focus by itself. The keyboard would come up over the
 * file before the reviewer had picked the line they came to fix, and picking
 * it is the tap that puts the caret there.
 */
function Editor({ text, onChange }: CodeEdit) {
  return (
    <textarea
      value={text}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      aria-label="File contents"
      className="absolute inset-y-0 right-0 resize-none overflow-hidden border-0 bg-transparent py-0 pr-3 pl-2 text-transparent caret-primary outline-none"
      style={{ left: GUTTER }}
    />
  );
}

/**
 * One line's numbers and markers, and the way into its hunk.
 *
 * A button only where there is a hunk to open: a file git does not track yet
 * has every line marked added and no hunk anywhere, and a gutter that lights
 * up under the thumb and then does nothing is worse than one that does not.
 */
function Gutter({
  line,
  change,
  annotated,
  outdated,
  active,
  hunkIndex,
  onShowHunk,
}: {
  line: number;
  change: ReviewLineChange | undefined;
  annotated: boolean;
  outdated: boolean;
  /** The line is being commented on, or already carries a comment. */
  active: boolean;
  /** The hunk this line sits in, or undefined when it sits in none. */
  hunkIndex: number | undefined;
  onShowHunk: (hunkIndex: number) => void;
}) {
  const className = cn(
    'sticky left-0 z-10 flex select-none items-stretch gap-1 overflow-hidden border-r bg-background pr-1.5 pl-2 text-right text-muted-foreground',
    // 44px of tap target on touch. The line height is smaller than that, so
    // the padding does the work.
    'min-h-[1.55em] py-0',
    hunkIndex !== undefined && 'hover:bg-accent hover:text-accent-foreground',
    change && CHANGE[change].row,
    active && 'bg-primary/8',
  );
  const style = { width: GUTTER };
  const inside = (
    <>
      <span
        aria-hidden
        className={cn('w-1 shrink-0 rounded-sm', change ? CHANGE[change].bar : '')}
      />
      <span className="flex-1 tabular-nums">{line}</span>
      {annotated ? (
        <span
          aria-hidden
          className={cn('w-1 shrink-0 rounded-sm', outdated ? 'bg-idle' : 'bg-primary')}
        />
      ) : (
        <span aria-hidden className="w-1 shrink-0" />
      )}
    </>
  );

  if (hunkIndex === undefined) {
    return (
      <span className={className} style={style}>
        {inside}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onShowHunk(hunkIndex)}
      aria-label={`Show the change at line ${line}`}
      title="Show the change here"
      className={className}
      style={style}
    >
      {inside}
    </button>
  );
}

/**
 * Whether a click was the end of selecting text rather than a tap on the line.
 *
 * A drag leaves a selection behind, and a double click is the browser taking a
 * word — neither is somebody asking for the comment box, and opening it would
 * take the focus off what they were selecting.
 */
function selecting(event: React.MouseEvent): boolean {
  if (event.detail > 1) return true;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/** One line's coloured spans. */
function Tokens({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, i) => (
        // Both themes travel as custom properties on the span, and globals.css
        // picks which one paints. Switching theme needs no re-tokenize.
        <span key={i} style={token.style as React.CSSProperties}>
          {token.content}
        </span>
      ))}
    </>
  );
}

/**
 * A block of lines removed between two that survived.
 *
 * Tapping it opens the hunk, which is the only place the removed lines exist:
 * the marker deliberately does not say how many there were, because the number
 * without the content is not information anybody acts on.
 */
function DeletionMarker({
  hunkIndex,
  onShowHunk,
}: {
  hunkIndex: number;
  onShowHunk: (hunkIndex: number) => void;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center">
      <button
        type="button"
        onClick={() => onShowHunk(hunkIndex)}
        aria-label="Show the lines deleted here"
        className="sticky left-0 z-10 flex min-h-6 items-center justify-end gap-1 border-r bg-background pr-1.5 pl-2 text-danger hover:bg-accent"
        style={{ width: GUTTER }}
      >
        <span aria-hidden className="text-xs">
          ⋯
        </span>
      </button>
      <button
        type="button"
        onClick={() => onShowHunk(hunkIndex)}
        className="flex min-h-6 items-center px-2 text-left text-xs text-danger hover:underline"
      >
        lines deleted here — tap to see them
      </button>
    </div>
  );
}

/** Splits content into the lines the pane renders. */
function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

