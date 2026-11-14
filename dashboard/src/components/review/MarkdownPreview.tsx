import { TextMessagePartProvider } from '@assistant-ui/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MarkdownText } from '@/components/assistant-ui/elements/markdown-text';
import { anchorAt, rowOffsets, scrollNearAnchor } from '@/lib/anchor';
import { WORKSPACE_DIR } from '@/lib/files';
import { cn } from '@/lib/utils';
import type { ReviewLineChange } from '../../../../shared/types.ts';
import { type Composing, recallScroll, rememberScroll } from '../../stores/review.ts';
import { CHANGE, type ScrollTarget, selecting } from './CodePane';

/** A block of the rendered file, with its source lines. */
export interface Block {
  /** The first source line of the block. */
  line: number;
  /** The last source line of the block. */
  endLine: number;
}

/** The props of {@link MarkdownPreview}. */
export interface MarkdownPreviewProps {
  /** The scroller of the pane. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The workspace-relative path of the file. It keys the remembered scroll position. */
  path: string;
  /** The markdown text. */
  content: string;
  /** Changed lines, keyed by line number as the API sends them. */
  diffLines: Record<string, ReviewLineChange>;
  /** The hunk index of each deletion marker, by the line it sits after. 0 is the top. */
  deletions: Map<number, number>;
  /** The hunk index of each line, by line number. */
  hunkByLine: Map<number, number>;
  /** The lines that have a comment, in order. A comment on a block counts on its first line. */
  commentedLines: number[];
  /** The line or the block that the composer is open on, or null. */
  composing: Composing | null;
  /** A line to scroll to once, when prev/next asks for it. */
  scrollTo: ScrollTarget | null;
  /** Called with the lines of a block when the user taps it. */
  onSelectBlock: (line: number, endLine: number) => void;
  /** Called with the hunk index when the user taps the change marker of a block. */
  onShowHunk: (hunkIndex: number) => void;
  /** Renders the cards and the composer below a block, for the comments on its lines. */
  renderUnderBlock: (line: number, endLine: number) => React.ReactNode;
  /** Called with the blocks of the file, in order, when they are rendered. */
  onBlocks: (blocks: Block[]) => void;
}

/** What the frame of a block needs from the pane. */
interface BlockContextValue {
  /** The change in a range of lines, and the hunk of the first changed line. */
  changeIn: (line: number, endLine: number) => { change?: ReviewLineChange; hunk?: number };
  /** True when a line of the range has a comment. */
  commentedIn: (line: number, endLine: number) => boolean;
  /** True when the composer is open on a line of the range. */
  composingIn: (line: number, endLine: number) => boolean;
  /** Called with the lines of a block when the user taps it. */
  onSelectBlock: (line: number, endLine: number) => void;
  /** Called with the hunk index when the user taps the change marker of a block. */
  onShowHunk: (hunkIndex: number) => void;
  /** Renders the cards and the composer below a block. */
  renderUnder: (line: number, endLine: number) => React.ReactNode;
  /** Registers a rendered block. The returned function removes it. */
  register: (block: Block) => () => void;
}

const BlockContext = createContext<BlockContextValue | null>(null);

/** The top padding of a block by its tag. A heading gets the space that it has in a message. */
const SPACE_ABOVE: Record<string, string> = {
  h1: 'pt-5',
  h2: 'pt-5',
  h3: 'pt-4',
  h4: 'pt-3.5',
  h5: 'pt-3',
  h6: 'pt-3',
};

/** The reading column of a block. */
const COLUMN = 'mx-auto w-full max-w-[55rem] px-4';

/** The components of the renderer that the pane replaces. One object, so the renderer keeps its memo. */
const components = { div: BlockFrame };

/**
 * The pane that shows a markdown file of the review rendered, as the thread shows a message.
 *
 * Each top level block of the file knows its source lines, so the pane can mark a changed block, show the
 * comments on its lines under it and open the composer for it. The pane keeps the place of the reader like
 * the code pane does, with the line at the top of the pane.
 *
 * @param props The props of the pane.
 */
export function MarkdownPreview({
  scrollRef,
  path,
  content,
  diffLines,
  deletions,
  hunkByLine,
  commentedLines,
  composing,
  scrollTo,
  onSelectBlock,
  onShowHunk,
  renderUnderBlock,
  onBlocks,
}: MarkdownPreviewProps) {
  // A relative path in the file starts from the directory of the file.
  const baseDir = `${WORKSPACE_DIR}/${path}`.replace(/\/[^/]*$/, '');

  /** The rendered blocks, by their lines. The renderer defers its work, so they arrive after the mount. */
  const blocks = useRef(new Map<string, Block>());
  /** Counts the changes of the block set, so an effect can act on them. */
  const [generation, setGeneration] = useState(0);
  const register = useCallback((block: Block) => {
    const key = `${block.line}-${block.endLine}`;
    blocks.current.set(key, block);
    setGeneration((n) => n + 1);
    return () => {
      blocks.current.delete(key);
      setGeneration((n) => n + 1);
    };
  }, []);

  /** The blocks in order, for the toolbar. The generation stands for the block set. */
  const ordered = useMemo(
    () => [...blocks.current.values()].sort((a, b) => a.line - b.line),
    [generation],
  );
  useEffect(() => onBlocks(ordered), [onBlocks, ordered]);

  /** The scroll position that the pane set last, to tell a scroll of the reader from a layout change. */
  const placed = useRef<number | null>(null);

  /**
   * Puts the file back where the reader left it, once the blocks are rendered.
   *
   * The view mounts the pane once per file, and the pane positions the file once,
   * so a poll that refetches the open file keeps the place of the reader.
   */
  const positioned = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || positioned.current || ordered.length === 0) return;
    positioned.current = true;
    const anchor = recallScroll(path);
    element.scrollTop = anchor ? (scrollNearAnchor(rowOffsets(element), anchor) ?? 0) : 0;
    placed.current = element.scrollTop;
  }, [scrollRef, path, ordered]);

  /**
   * Records the place of the reader when the pane leaves the file. A pane that
   * has not positioned the file yet has no place to record.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    return () => {
      if (positioned.current) {
        rememberScroll(path, anchorAt(rowOffsets(element), element.scrollTop));
      }
    };
  }, [scrollRef, path]);

  /**
   * Images and diagrams get their height after the first paint, which moves the
   * blocks below them. The pane restores the place of the reader after each
   * such change, until the reader scrolls.
   */
  useEffect(() => {
    const element = scrollRef.current;
    const inner = element?.firstElementChild;
    if (!element || !inner || !positioned.current) return;
    const anchor = recallScroll(path);
    if (!anchor) return;
    const observer = new ResizeObserver(() => {
      if (placed.current === null || element.scrollTop !== placed.current) {
        observer.disconnect();
        return;
      }
      element.scrollTop = scrollNearAnchor(rowOffsets(element), anchor) ?? element.scrollTop;
      placed.current = element.scrollTop;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [scrollRef, path, ordered]);

  /** Brings the block that prev/next asked for into the middle of the pane. */
  useEffect(() => {
    if (!scrollTo) return;
    scrollRef.current
      ?.querySelector(`[data-block][data-line="${scrollTo.line}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [scrollRef, scrollTo]);

  const context = useMemo<BlockContextValue>(
    () => ({
      changeIn: (line, endLine) => {
        let change: ReviewLineChange | undefined;
        let hunk: number | undefined;
        // A deletion at the top of the file belongs to the first block.
        if (line === 1 && deletions.has(0)) {
          change = 'modified';
          hunk = deletions.get(0);
        }
        for (let at = line; at <= endLine; at++) {
          const kind = diffLines[String(at)];
          const deletion = deletions.get(at);
          if (kind) {
            change = change && change !== kind ? 'modified' : kind;
            hunk ??= hunkByLine.get(at);
          }
          if (deletion !== undefined) {
            change = 'modified';
            hunk ??= deletion;
          }
        }
        return { change, hunk };
      },
      commentedIn: (line, endLine) => commentedLines.some((at) => at >= line && at <= endLine),
      composingIn: (line, endLine) =>
        composing !== null && composing.line >= line && composing.line <= endLine,
      onSelectBlock,
      onShowHunk,
      renderUnder: renderUnderBlock,
      register,
    }),
    [
      diffLines,
      deletions,
      hunkByLine,
      commentedLines,
      composing,
      onSelectBlock,
      onShowHunk,
      renderUnderBlock,
      register,
    ],
  );

  return (
    // The container lets a wide table or code block grow to the width of the pane.
    <div
      ref={scrollRef}
      data-slot="review-preview"
      className="@container min-h-0 flex-1 overflow-auto"
    >
      <BlockContext.Provider value={context}>
        <TextMessagePartProvider text={content}>
          <MarkdownText baseDir={baseDir} blocks components={components} />
        </TextMessagePartProvider>
      </BlockContext.Provider>
    </div>
  );
}

/**
 * The frame of one top level block: the change marker, the block in the reading
 * column and the comments on its lines under it.
 *
 * The renderer gives the frame the tag and the lines of the block as data
 * attributes. A div without them is not a block and renders as it is.
 *
 * @param props The attributes of the div and the block inside it.
 */
function BlockFrame({
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  'data-block'?: string;
  'data-line'?: number | string;
  'data-line-end'?: number | string;
}) {
  const context = useContext(BlockContext);
  const tag = props['data-block'];
  const line = Number(props['data-line']);
  const endLine = Number(props['data-line-end']);
  const isBlock = context !== null && tag !== undefined && line > 0 && endLine >= line;

  useLayoutEffect(() => {
    if (!isBlock) return;
    return context.register({ line, endLine });
  }, [isBlock, context, line, endLine]);

  if (!isBlock) {
    return (
      <div className={className} {...props}>
        {children}
      </div>
    );
  }

  const { change, hunk } = context.changeIn(line, endLine);
  const active = context.commentedIn(line, endLine) || context.composingIn(line, endLine);
  const under = context.renderUnder(line, endLine);

  /** Opens the composer for the innermost block under a tap, unless the tap hit a control inside the block. */
  const select = (event: React.SyntheticEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest('a, button, [role="button"], input, textarea');
    if (control && control !== event.currentTarget) return;
    const block = target.closest<HTMLElement>('[data-line]');
    const start = Number(block?.dataset.line);
    const end = Number(block?.dataset.lineEnd);
    if (start > 0 && end >= start) context.onSelectBlock(start, end);
  };

  return (
    <div
      {...props}
      className={cn('relative', change && CHANGE[change].row, active && 'bg-primary/8', className)}
    >
      <Marker line={line} change={change} hunk={hunk} onShowHunk={context.onShowHunk} />
      {/* Tapping the block starts a comment, as tapping a line of code does. A
          button element would make the text unselectable, so a div takes the role. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a button element would make the text unselectable */}
      <div
        role="button"
        tabIndex={0}
        onClick={(event) => {
          if (!selecting(event)) select(event);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(event);
          }
        }}
        className={cn(
          COLUMN,
          'pb-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          SPACE_ABOVE[tag] ?? 'pt-1.5',
          // The frame spaces the blocks, so the block keeps no margin of its own.
          '[&>*]:my-0!',
        )}
      >
        {children}
      </div>
      {under ? <div className={cn(COLUMN, 'pb-3')}>{under}</div> : null}
    </div>
  );
}

/**
 * The change marker at the left edge of a block, which opens the hunk of the change.
 *
 * It is a button only where there is a hunk to open.
 *
 * @param line The first line of the block.
 * @param change The kind of change in the block, or undefined when the block did not change.
 * @param hunk The hunk of the first change in the block, or undefined when the block is in no hunk.
 * @param onShowHunk Called with the hunk index when the user taps the marker.
 */
function Marker({
  line,
  change,
  hunk,
  onShowHunk,
}: {
  /** The first line of the block. */
  line: number;
  /** The kind of change in the block, or undefined when the block did not change. */
  change: ReviewLineChange | undefined;
  /** The hunk of the first change in the block, or undefined when the block is in no hunk. */
  hunk: number | undefined;
  /** Called with the hunk index when the user taps the marker. */
  onShowHunk: (hunkIndex: number) => void;
}) {
  if (!change) return null;
  const bar = (
    <span
      aria-hidden
      className={cn('absolute inset-y-1 left-1 w-1 rounded-sm', CHANGE[change].bar)}
    />
  );
  if (hunk === undefined) return bar;
  return (
    <button
      type="button"
      onClick={() => onShowHunk(hunk)}
      aria-label={`Show the change at line ${line}`}
      title="Show the change here"
      className="absolute inset-y-0 left-0 w-3 hover:bg-accent"
    >
      {bar}
    </button>
  );
}
