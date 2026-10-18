import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Notice } from '@/components/Notice';
import { type Token, withinLineLimit } from '@/lib/highlight';
import { cn } from '@/lib/utils';
import type { ReviewAnnotation, ReviewLineChange } from '../../../../shared/types.ts';
import { recallScroll, rememberScroll } from '../../stores/review.ts';

/** The gutter bar class and row background class for each kind of changed line. */
const CHANGE: Record<ReviewLineChange, { bar: string; row: string }> = {
  added: { bar: 'bg-ok', row: 'bg-ok/8' },
  modified: { bar: 'bg-warn', row: 'bg-warn/8' },
};

/**
 * Computes the gutter width: the line numbers, the two marker bars and their padding.
 *
 * Every row uses the same width, because the edit textarea and the comment
 * cards start where the code cells do and must line up with them to the pixel.
 *
 * @param digits The number of digits the line numbers need.
 * @returns A CSS length.
 */
function gutterWidth(digits: number): string {
  return `calc(${digits}ch + 2.75rem)`;
}

/** The gutter width, as the CSS variable the pane sets from {@link gutterWidth}. */
const GUTTER = 'var(--review-gutter)';

/** A line to bring into view, and which request asked for it. */
export interface ScrollTarget {
  /** The line to scroll to, counted from 1. */
  line: number;
  /** Makes each request distinct, so a repeated step to the same line still scrolls. */
  nonce: number;
}

/** A buffer being edited, and the way to change it. */
interface CodeEdit {
  /** The text of the buffer. */
  text: string;
  /** Called with the new text on every change. */
  onChange: (text: string) => void;
}

/** The props of {@link CodePane}. */
export interface CodePaneProps {
  /**
   * The scroller of the pane. The view holds it, so it can measure the reader's
   * place before a mode switch and restore it after.
   */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The path of the open file. It keys the remembered scroll position. */
  path: string;
  /** The content of the file as last loaded. */
  content: string;
  /** One token list per line, or null to render the file plain. */
  tokens: Token[][] | null;
  /**
   * The text that the tokens were made from. A line that differs from its line
   * in this text renders plain until new tokens arrive.
   */
  tokensFor: string;
  /** Changed lines, keyed by line number as the API sends them. */
  diffLines: Record<string, ReviewLineChange>;
  /** The hunk index of each deletion marker, by the line it sits after. 0 is the top. */
  deletions: Map<number, number>;
  /** The hunk index of each line, by line number, for the gutter to open. */
  hunkByLine: Map<number, number>;
  /** The comments, by line number. */
  annotations: Map<number, ReviewAnnotation>;
  /** The line whose composer is open, or null. */
  composing: number | null;
  /** True to wrap long lines, false to scroll them sideways. */
  wrap: boolean;
  /** A line to scroll to once, when prev/next asks for it. */
  scrollTo: ScrollTarget | null;
  /** The buffer being edited, or null when the file is being read. */
  edit: CodeEdit | null;
  /** Called with the line number when the user taps the code of a line. */
  onSelectLine: (line: number) => void;
  /** Called with the hunk index when the user taps a gutter or a deletion marker. */
  onShowHunk: (hunkIndex: number) => void;
  /** Renders the card and the composer below a line. */
  renderUnderLine?: (line: number) => React.ReactNode;
}

/**
 * The file, one addressable row per line, and the editor over it.
 *
 * Every line is its own grid row, so a tap can address it and the line-number
 * gutter stays sticky during horizontal scroll. In edit mode a textarea lies
 * over the same rows, so a switch between reading and editing moves no code.
 * The comment cards, the composer and the deletion markers fold away while
 * editing, because nothing can sit between the lines of a textarea.
 *
 * A file past the line limit renders as one block of plain text, because a
 * phone cannot lay out tens of thousands of rows.
 *
 * The agent can change the file content and the comments, so both render as
 * text nodes only.
 *
 * @param props The props of the pane.
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
  /** The shown text, which is the buffer while editing and the file otherwise. */
  const source = edit ? edit.text : content;
  /** True when this file is too long to be read a line at a time. */
  const tooLong = !withinLineLimit(source);

  /**
   * Puts each file back where it was left, and every file this review has not
   * opened at the top.
   *
   * It runs before paint, so the reader never sees the offset of the previous file.
   * It positions each path once, so a poll that refetches the open file keeps
   * the place of the reader.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || positioned.current === path) return;
    positioned.current = path;
    element.scrollTop = recallScroll(path);
  }, [scrollRef, path, content]);

  /** Brings the line that prev/next asked for into the middle of the pane. */
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
  /** The lines that the tokens describe. They are the lines of the file until the user types. */
  const tokenLines = useMemo(
    () => (tokensFor === source ? lines : splitLines(tokensFor)),
    [tokensFor, source, lines],
  );
  // The gutter fits the highest line number, with room for at least two digits.
  const digits = Math.max(String(lines.length).length, 2);
  // Editing always wraps, because a textarea that scrolls sideways would move
  // apart from the rows behind it.
  const wrapped = wrap || editing;
  // Lines removed at the top sit after no row, so their marker comes before the rows.
  const firstDeletion = deletions.get(0);

  return (
    <div
      ref={scrollRef}
      data-slot="review-code-pane"
      className={cn(
        // 16px on a phone, because Safari zooms the page when a smaller control
        // takes focus. Both modes use the same size, so a switch moves nothing.
        'min-h-0 flex-1 overflow-auto font-mono text-[16px] leading-[1.55] md:text-[13px]',
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
          {firstDeletion !== undefined && !editing ? (
            <DeletionMarker hunkIndex={firstDeletion} onShowHunk={onShowHunk} />
          ) : null}

          {lines.map((text, index) => (
            <Row
              // biome-ignore lint/suspicious/noArrayIndexKey: the line number is the identity
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
 * One line: its row, the deletion marker after it, and whatever sits under it.
 *
 * Memoized, because typing re-renders the whole file on every keystroke.
 * An unchanged line then costs a comparison and no render.
 *
 * @param line The line number, counted from 1.
 * @param text The text of the line.
 * @param tokens The colours of the line, or null while it renders plain.
 * @param change The kind of change on the line, or undefined when the line did not change.
 * @param annotation The comment on the line, if any.
 * @param composing True while the composer is open on the line.
 * @param hunkIndex The hunk of the line, or undefined when the line is in no hunk.
 * @param deletionHunk The hunk of the lines deleted after this line, or undefined for none.
 * @param wrap True to wrap the line, false to scroll it sideways.
 * @param editing True while the pane is in edit mode.
 * @param under The content below the line, such as its comment card.
 * @param onSelectLine Called with the line number when the user taps the code.
 * @param onShowHunk Called with the hunk index when the user taps the gutter or the deletion marker.
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
  /** The line number, counted from 1. */
  line: number;
  /** The text of the line. */
  text: string;
  /** The colours of the line, or null while it renders plain. */
  tokens: Token[] | null;
  /** The kind of change on the line, or undefined when the line did not change. */
  change: ReviewLineChange | undefined;
  /** The comment on the line, if any. */
  annotation: ReviewAnnotation | undefined;
  /** True while the composer is open on the line. */
  composing: boolean;
  /** The hunk of the line, or undefined when the line is in no hunk. */
  hunkIndex: number | undefined;
  /** The hunk of the lines deleted after this line, or undefined for none. */
  deletionHunk: number | undefined;
  /** True to wrap the line, false to scroll it sideways. */
  wrap: boolean;
  /** True while the pane is in edit mode. */
  editing: boolean;
  /** The content below the line, such as its comment card. */
  under: React.ReactNode;
  /** Called with the line number when the user taps the code. */
  onSelectLine: (line: number) => void;
  /** Called with the hunk index when the user taps the gutter or the deletion marker. */
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
          // While editing, the gutter opens no hunk. The sheet would close the
          // keyboard, and the markers show the last save, not the current text.
          hunkIndex={editing ? undefined : hunkIndex}
          onShowHunk={onShowHunk}
        />

        {/* Tapping the code starts a comment. A button element would make the
            text unselectable in WebKit and Firefox, so selecting() tells a tap
            from the end of a drag. The line of code is the accessible name.
            While editing, the textarea on top takes the taps. */}
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
            // `min-w-0` lets the cell shrink to the pane width. Otherwise one
            // long unbroken run widens it, and the line wraps later than the
            // textarea over it.
            wrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre',
          )}
        >
          {tokens ? <Tokens tokens={tokens} /> : text}
          {/* A zero-width space gives an empty line its full height. */}
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
 * The edit mode textarea, laid over the code column.
 *
 * Its text is transparent, so the reader sees the highlighted rows behind it
 * and the caret. The font, size, line height, padding and wrapping match the
 * rows, or the caret would drift away from the letters. It takes no focus on
 * mount, so the keyboard stays down until the reviewer taps a line.
 *
 * @param text The text of the buffer.
 * @param onChange Called with the new text on every change.
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
 * The number and the markers of one line, and the way into its hunk.
 *
 * It is a button only where there is a hunk to open. A file that git does not track
 * has every line marked added, but no hunks.
 *
 * @param line The line number, counted from 1.
 * @param change The kind of change on the line, or undefined when the line did not change.
 * @param annotated True when the line has a comment.
 * @param outdated True when the comment on the line is outdated.
 * @param active True when the line is being commented on or has a comment.
 * @param hunkIndex The hunk of the line, or undefined when the line is in no hunk.
 * @param onShowHunk Called with the hunk index when the user taps the gutter.
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
  /** The line number, counted from 1. */
  line: number;
  /** The kind of change on the line, or undefined when the line did not change. */
  change: ReviewLineChange | undefined;
  /** True when the line has a comment. */
  annotated: boolean;
  /** True when the comment on the line is outdated. */
  outdated: boolean;
  /** True when the line is being commented on or has a comment. */
  active: boolean;
  /** The hunk of the line, or undefined when the line is in no hunk. */
  hunkIndex: number | undefined;
  /** Called with the hunk index when the user taps the gutter. */
  onShowHunk: (hunkIndex: number) => void;
}) {
  const className = cn(
    'sticky left-0 z-10 flex select-none items-stretch gap-1 overflow-hidden border-r bg-background pr-1.5 pl-2 text-right text-muted-foreground',
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
 * Checks if a click ended a text selection and was not a tap on the line.
 *
 * A drag leaves a selection behind, and a double click selects a word. Opening
 * the composer then would take the focus off the selection.
 *
 * @param event The click on the code of the line.
 * @returns True when the click selected text.
 */
function selecting(event: React.MouseEvent): boolean {
  if (event.detail > 1) return true;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/**
 * The coloured spans of one line.
 *
 * @param tokens The tokens of the line.
 */
function Tokens({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, i) => (
        // The span carries both theme colours, and the stylesheet picks one.
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no id, and a line is replaced whole
        <span key={i} style={token.style as React.CSSProperties}>
          {token.content}
        </span>
      ))}
    </>
  );
}

/**
 * A marker for lines removed between two lines. Tapping it opens the hunk that holds them.
 *
 * @param hunkIndex The hunk that holds the removed lines.
 * @param onShowHunk Called with the hunk index when the user taps the marker.
 */
function DeletionMarker({
  hunkIndex,
  onShowHunk,
}: {
  /** The hunk that holds the removed lines. */
  hunkIndex: number;
  /** Called with the hunk index when the user taps the marker. */
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

/**
 * Splits content into the lines that the pane renders.
 *
 * @param content The file text.
 * @returns One string per line, without the empty line after a final newline.
 */
function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
