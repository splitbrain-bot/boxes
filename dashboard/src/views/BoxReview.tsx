import { ArrowLeft, ExternalLink, FilePlus2, Send } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ReviewDiffHunk, ReviewRepo } from '../../../shared/types.ts';
import { Notice } from '@/components/Notice';
import { Shelf } from '@/components/Shelf';
import { BasePicker } from '@/components/review/BasePicker';
import { CodePane, type ScrollTarget } from '@/components/review/CodePane';
import { CommentCard } from '@/components/review/CommentCard';
import { ComposerSheet, InlineComposer } from '@/components/review/CommentComposer';
import { HunkSheet } from '@/components/review/HunkSheet';
import { ReviewToolbar } from '@/components/review/ReviewToolbar';
import { ReviewTree } from '@/components/review/ReviewTree';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useCodeEdit } from '@/hooks/use-code-edit';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useScrollAway } from '@/hooks/use-scroll-away';
import { useBox } from '@/hooks/use-box';
import { useUp } from '@/hooks/use-up';
import { useViewportLock } from '@/hooks/use-viewport-lock';
import { anchorAt, rowOffsets, scrollForAnchor, type ScrollAnchor } from '@/lib/anchor';
import { withinLineLimit } from '@/lib/highlight';
import { historyIndex } from '@/lib/history';
import { stagePrompt } from '@/lib/staged-prompt';
import { cn } from '@/lib/utils';
import {
  closeFile,
  compose,
  deleteComment,
  loadFile,
  loadTree,
  newReview,
  open as openReview,
  refreshOnReturn,
  saveComment,
  saveFile,
  setBase,
  setDirty,
  toggleDir,
  useReview,
} from '../stores/review.ts';

/**
 * The prompt "Hand to agent" stages in the thread's composer.
 *
 * The workspace holds one REVIEW.md at its root, so the prompt stays the same
 * for any number of repositories.
 */
const HANDOFF_PROMPT = 'Read REVIEW.md and address the comments in it.';

/**
 * Page that reviews a box's code, at `/boxes/:id/review`.
 *
 * The open file is in the search string, so a file is linkable. On a phone the
 * stack is boxes, thread, file list, file. From `md` up the tree and the file
 * share one view, so the stack is one step shorter.
 */
export function BoxReview() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const path = params.get('path');

  const { facts, dirs, expanded, file, loadingTree, loadingFile, error, composing, saving } =
    useReview();
  // Polls this one box for the name in the header.
  const { box } = useBox(id);

  /**
   * Whether long lines wrap. On by default, because a phone is narrower than
   * most source files. A wrapped line is still one row with one number.
   */
  const [wrap, setWrap] = useState(true);
  const [hunk, setHunk] = useState<ReviewDiffHunk | null>(null);
  /** The line the prev/next toolbar last asked for, or null. */
  const [scrollTo, setScrollTo] = useState<ScrollTarget | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  /** The comment a tap on a bin is asking to remove, or null. */
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  /** The edit-mode buffer and its syntax tokens. */
  const edit = useCodeEdit(file);
  /**
   * True from a save refused because the file changed on disk until the
   * reviewer picks a version. The buffer stays meanwhile.
   */
  const [conflict, setConflict] = useState(false);
  /**
   * The exit waiting for the reviewer to agree to lose unsaved edits, or null.
   */
  const [leaving, setLeaving] = useState<{ go: () => void } | null>(null);
  /** The agreed exit, waiting for the dialog's history entry to go. */
  const agreed = useRef<(() => void) | null>(null);
  /** The pane's scroller, for holding the reader's line across a mode switch. */
  const paneRef = useRef<HTMLDivElement>(null);
  /** An anchor taken before a switch, to be put back after it. */
  const held = useRef<ScrollAnchor | null>(null);
  /**
   * The thread this review was opened from, or null. A box can hold several
   * threads on one checkout, and leaving goes back to this one.
   *
   * Read once, because opening a file navigates within this route and carries
   * no state. A review opened from the box list, or reloaded, has no origin.
   */
  const [origin] = useState<string | null>(
    () => (location.state as { threadId?: string } | null)?.threadId ?? null,
  );
  const name = box?.name ?? id;
  /** The parent route: the origin thread, or the box list without one. */
  const threadPath = origin ? `/boxes/${id}/threads/${origin}` : '/';
  const up = useUp(threadPath);
  const navigate = useNavigate();
  /**
   * Whether the tree and the pane are side by side. It decides what back steps
   * out to and which composer is mounted.
   *
   * A query in script, because a Sheet renders into a portal that a
   * `md:hidden` wrapper cannot reach.
   */
  const wide = useMediaQuery('(min-width: 768px)');

  // The store is a singleton, so re-entering the same box paints from what it
  // holds and updates when the fetch lands. Nothing polls the workspace.
  useEffect(() => {
    openReview(id);
    void loadTree();
    return refreshOnReturn();
  }, [id]);

  // The URL decides which file is open. The hunk sheet closes with its file.
  useEffect(() => {
    setHunk(null);
    if (path) void loadFile(path);
    else closeFile();
  }, [path]);

  /**
   * Runs an exit from the open file, asking first when it would lose unsaved
   * edits.
   *
   * The mode toggle, another file, the step back to the list and leaving the
   * review all go through this.
   */
  const guard = useCallback(
    (go: () => void) => {
      if (edit.dirty) setLeaving({ go });
      else go();
    },
    [edit.dirty],
  );

  /**
   * Runs the agreed exit once the dialog's history entry is gone.
   *
   * A navigation made while that entry is on top would act on the dialog's
   * entry instead of the file's.
   */
  useEffect(() => {
    const go = agreed.current;
    if (!go || leaving !== null) return;
    if ((location.state as { overlay?: boolean } | null)?.overlay) return;
    agreed.current = null;
    go();
  }, [leaving, location]);

  /**
   * Opens a file.
   *
   * Below md this pushes an entry, because the file replaces the tree on
   * screen. From md up it replaces the entry, so back leaves the review, as
   * the header's button does.
   */
  const openPath = useCallback(
    (next: string) => {
      guard(() => {
        setParams(
          (current) => {
            const params = new URLSearchParams(current);
            params.set('path', next);
            return params;
          },
          { replace: wide },
        );
        setScrollTo(null);
      });
    },
    [guard, setParams, wide],
  );

  /**
   * Closes the open file and returns to the tree.
   *
   * Pops the entry that opened the file. Without one, as after a pasted link
   * or a file opened from md up, it rewrites the search string in place.
   */
  const closeOpenFile = useCallback(() => {
    guard(() => {
      if (historyIndex() > up.entry) navigate(-1);
      else
        setParams(
          (current) => {
            const params = new URLSearchParams(current);
            params.delete('path');
            return params;
          },
          { replace: true },
        );
      // Closing a file does not remount the view, so the tree refetches here.
      void loadTree();
    });
  }, [guard, up.entry, navigate, setParams]);

  /**
   * Switches between commenting and editing, and keeps the reader's line in
   * place.
   *
   * Edit mode hides the comment cards and deletion markers, which moves the
   * rows. The anchor is taken here, because after the new mode paints the old
   * layout is gone.
   *
   * @param next True to enter edit mode.
   */
  const switchMode = useCallback(
    (next: boolean) => {
      const element = paneRef.current;
      held.current = element ? anchorAt(rowOffsets(element), element.scrollTop) : null;
      if (next) {
        // A composer standing open over the file belongs to the other mode.
        compose(null);
        edit.start();
      } else {
        setConflict(false);
        edit.stop();
      }
    },
    [edit],
  );

  const editing = edit.text !== null;
  /**
   * Whether the file is past the line limit. The pane then shows one plain
   * block without rows to step to, comment on or edit.
   */
  const tooLong = file !== null && !withinLineLimit(file.content);
  /**
   * Whether this file can be edited. A save of a truncated file would delete
   * everything past where the read stopped.
   */
  const editable = file !== null && !file.deleted && !file.binary && !file.truncated && !tooLong;

  // Restores the reader's line before the new mode paints.
  useLayoutEffect(() => {
    const element = paneRef.current;
    const anchor = held.current;
    held.current = null;
    if (!element || !anchor) return;
    const top = scrollForAnchor(rowOffsets(element), anchor);
    if (top !== null) element.scrollTop = top;
  }, [editing]);

  /**
   * Writes the buffer to the workspace.
   *
   * @param force Overwrites the file even when it changed on disk since it was
   *   read.
   */
  const save = useCallback(
    (force: boolean) => {
      if (!file || edit.text === null) return;
      void saveFile(file.path, edit.text, force ? null : file.hash).then((result) => {
        setConflict(!result.ok && result.conflict);
      });
    },
    [file, edit.text],
  );

  // Tells the store about unsaved edits, so a refetch on return to the tab
  // does not replace them.
  useEffect(() => {
    setDirty(edit.dirty);
  }, [edit.dirty]);
  useEffect(() => () => setDirty(false), []);

  /**
   * Opens or closes the composer on a line. Its identity is stable, because the
   * pane's rows are memoized against typing.
   */
  const selectLine = useCallback((line: number) => {
    compose(useReview.getState().composing === line ? null : line);
  }, []);

  /** Opens the hunk sheet for a hunk index of the open file. */
  const showHunk = useCallback(
    (index: number) => setHunk(file?.diff.hunks[index] ?? null),
    [file?.diff.hunks],
  );

  /** Deletion markers by the line they sit after, for the pane. */
  const deletions = useMemo(
    () => new Map((file?.diff.deletions ?? []).map((d) => [d.afterLine, d.hunkIndex])),
    [file?.diff.deletions],
  );
  /** Comments of the open file by line, for the pane. */
  const annotations = useMemo(
    () => new Map((file?.annotations ?? []).map((a) => [a.line, a])),
    [file?.annotations],
  );
  /**
   * The hunk index of each line, which a tap on the gutter opens.
   *
   * A hunk's range includes its context lines, which gives a phone a larger
   * target. A hunk that only removed lines covers no line, so its deletion
   * marker opens it.
   */
  const hunkByLine = useMemo(() => {
    const map = new Map<number, number>();
    (file?.diff.hunks ?? []).forEach((hunk, index) => {
      for (let line = hunk.startLine; line <= hunk.endLine; line++) map.set(line, index);
    });
    return map;
  }, [file?.diff.hunks]);
  /**
   * The changed lines in order, for counting and stepping through them.
   *
   * A deletion counts as the line its marker follows, so a file whose only
   * change is a deletion still has a changed line.
   */
  const changedLines = useMemo(() => {
    const lines = new Set(Object.keys(file?.diff.lines ?? {}).map(Number));
    for (const deletion of file?.diff.deletions ?? []) {
      lines.add(Math.max(1, deletion.afterLine));
    }
    return [...lines].sort((a, b) => a - b);
  }, [file?.diff.lines, file?.diff.deletions]);
  /** The commented lines in order, for counting and stepping through them. */
  const commentedLines = useMemo(
    () => (file?.annotations ?? []).map((a) => a.line).sort((a, b) => a - b),
    [file?.annotations],
  );

  /**
   * Renders the comment card and the inline composer under a line.
   *
   * The pane calls this for every rendered line. It returns null for a line
   * without either.
   */
  const underLine = useCallback(
    (line: number) => {
      if (!file) return null;
      const annotation = annotations.get(line);
      const open = composing === line;
      if (!annotation && !open) return null;
      return (
        <div className="flex flex-col gap-1.5">
          {annotation && !open ? (
            <CommentCard
              annotation={annotation}
              busy={saving}
              onEdit={() => compose(line)}
              // Asks first, because a deleted comment has no undo and the bin
              // sits close to the pencil.
              onDelete={() => setConfirmDelete(line)}
            />
          ) : null}
          {/* Below md the composer is a bottom sheet, because the keyboard
              would hide a textarea in the scrolling pane. */}
          {open && wide ? (
            <InlineComposer
              line={line}
              initial={annotation?.comment ?? ''}
              busy={saving}
              onSave={(comment) => void saveComment(file.path, line, comment)}
              onCancel={() => compose(null)}
            />
          ) : null}
        </div>
      );
    },
    [file, annotations, composing, saving, wide],
  );

  /**
   * Stages the handoff prompt and goes back to the thread the review was
   * opened from.
   */
  const handoff = useCallback((): void => {
    stagePrompt(id, HANDOFF_PROMPT);
    up.go();
  }, [id, up]);

  /** Steps to the next or previous entry of a sorted line list. */
  const step = (lines: number[], direction: -1 | 1): void => {
    if (lines.length === 0) return;
    const from = scrollTo?.line ?? (direction === 1 ? 0 : Number.MAX_SAFE_INTEGER);
    const next =
      direction === 1
        ? (lines.find((line) => line > from) ?? lines[0]!)
        : ([...lines].reverse().find((line) => line < from) ?? lines.at(-1)!);
    // The nonce makes every press a new request, so the pane scrolls even when
    // the target line has not changed.
    setScrollTo((current) => ({ line: next, nonce: (current?.nonce ?? 0) + 1 }));
  };

  // The code pane is the scroller, so the document must not scroll.
  useViewportLock();

  // Hides the header while reading down and shows it on a scroll back up.
  const { away, container, reset } = useScrollAway('[data-slot="review-code-pane"]');

  // Shows the header again when the open file changes. Below md, the list's
  // only way out is the button in that header.
  useEffect(reset, [reset, path]);

  useDocumentTitle(
    [file ? shortPath(file.path) : null, 'Review', name].filter(Boolean).join(' · '),
  );

  return (
    <div ref={container} className="flex h-dvh flex-col">
      {/* The header stays while editing, because the toolbar under it holds Save. */}
      <Shelf away={away && !editing}>
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          {/* Below md with a file open, back returns to the file list.
              Otherwise it leaves the review. */}
          {file && !wide ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 px-2"
              onClick={closeOpenFile}
              aria-label="Back to the file list"
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : (
            <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
              <a
                href={up.href}
                onClick={(event) => {
                  // Stops the link before the step out when there are unsaved edits.
                  if (edit.dirty && plainClick(event)) {
                    event.preventDefault();
                    setLeaving({ go: up.go });
                    return;
                  }
                  up.onClick(event);
                }}
                aria-label={origin ? 'Back to the thread' : 'Back to boxes'}
              >
                <ArrowLeft className="size-4" />
              </a>
            </Button>
          )}

          <div className="flex min-w-16 flex-1 flex-col">
            <span className="truncate text-sm font-medium">
              {file ? shortPath(file.path) : 'Review'}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {name}
              {/* The repository of the open file. */}
              {file ? ` · ${whichRepo(file.repo, facts?.repos ?? [])}` : ''}
              {facts && !facts.hasGit ? ' · no git' : ''}
              {/* The active base, with the share of repositories it resolved in. */}
              {facts?.base.rev
                ? ` · vs ${facts.base.rev}${resolvedIn(facts.repos)}`
                : facts?.hasGit
                  ? ' · vs working tree'
                  : ''}
            </span>
          </div>

          {facts?.hasGit ? (
            <BasePicker
              base={facts.base}
              repos={facts.repos}
              busy={saving}
              onSet={(rev) => void setBase(rev)}
            />
          ) : null}

          {/* Stages the prompt in the thread's composer without sending it. */}
          {origin && facts && facts.commentCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              // Guarded, because this leaves the review like any other exit.
              onClick={() => guard(handoff)}
              title="Open the thread with a prompt to address these comments"
            >
              <Send className="size-3.5" />
              <span className="hidden sm:inline">Hand to agent</span>
            </Button>
          ) : null}

          {facts?.hasReview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              disabled={saving}
              onClick={() => setConfirmNew(true)}
              aria-label="Start a new review"
              title="Start a new review, discarding these comments"
            >
              <FilePlus2 />
            </Button>
          ) : null}
        </header>
      </Shelf>

      {error ? <Notice className="shrink-0 border-b px-3 py-2">{error}</Notice> : null}

      <div className="flex min-h-0 flex-1">
        {/* One tree for both layouts. From md up it is the left column. Below
            md it fills the screen until a file is open. */}
        <aside
          className={cn(
            'shrink-0 overflow-auto md:block md:w-72 md:border-r lg:w-80',
            file ? 'hidden' : 'w-full',
          )}
        >
          {dirs[''] ? (
            <ReviewTree
              dirs={dirs}
              expanded={expanded}
              activePath={file?.path ?? null}
              onOpen={openPath}
              onToggle={toggleDir}
            />
          ) : loadingTree ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>
          ) : error ? null : (
            // A failed fetch shows the error banner instead.
            <p className="px-3 py-4 text-sm text-muted-foreground">Nothing to show.</p>
          )}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {file ? (
            <>
              <ReviewToolbar
                changeCount={changedLines.length}
                commentCount={commentedLines.length}
                // A file shown as one block has no rows to step to.
                steppable={!tooLong}
                wrap={wrap}
                editable={editable}
                editing={editing}
                dirty={edit.dirty}
                busy={saving}
                onWrap={() => setWrap((w) => !w)}
                onStepChange={(direction) => step(changedLines, direction)}
                onStepComment={(direction) => step(commentedLines, direction)}
                onEdit={() => (editing ? guard(() => switchMode(false)) : switchMode(true))}
                onSave={() => save(false)}
                onRevert={edit.revert}
              />
              {file.deleted ? (
                <Empty>This file was deleted, so there is nothing left to read.</Empty>
              ) : file.binary ? (
                <Empty>
                  <p>This file is binary, so it cannot be shown here.</p>
                  {/* A plain link, so the browser handles the file by its type. */}
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`/api/boxes/${encodeURIComponent(id)}/review/raw?path=${encodeURIComponent(file.path)}`}
                      target="_blank"
                      rel="noopener"
                    >
                      <ExternalLink />
                      Open in a new tab
                    </a>
                  </Button>
                </Empty>
              ) : (
                <>
                  {file.truncated ? (
                    <Notice tone="warn" className="shrink-0 border-b px-3 py-1.5 text-xs">
                      This file is larger than the display limit. Only the first part is shown, and
                      it cannot be edited.
                    </Notice>
                  ) : null}
                  {/* The agent works while the review is open, so a save can hit a
                      file that changed on disk. The reviewer picks a version. */}
                  {conflict ? (
                    <Notice tone="warn" className="shrink-0 border-b px-3 py-1.5 text-xs">
                      <span className="flex flex-wrap items-center gap-2">
                        <span>The agent changed this file while you were editing it.</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={saving}
                          onClick={() => save(true)}
                        >
                          Save anyway
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={saving}
                          onClick={() => {
                            // No second question. The reload shows the file on disk.
                            switchMode(false);
                            void loadFile(file.path);
                          }}
                        >
                          Drop my changes
                        </Button>
                      </span>
                    </Notice>
                  ) : null}
                  <CodePane
                    scrollRef={paneRef}
                    path={file.path}
                    content={file.content}
                    tokens={edit.tokens}
                    tokensFor={edit.tokensFor}
                    diffLines={file.diff.lines}
                    deletions={deletions}
                    hunkByLine={hunkByLine}
                    annotations={annotations}
                    composing={composing}
                    wrap={wrap}
                    scrollTo={scrollTo}
                    edit={edit.text === null ? null : { text: edit.text, onChange: edit.change }}
                    onSelectLine={selectLine}
                    onShowHunk={showHunk}
                    renderUnderLine={underLine}
                  />
                </>
              )}
            </>
          ) : (
            // Below md the tree fills the screen, so this shows from md up only.
            <div className="hidden min-h-0 flex-1 md:flex">
              <Empty>
                {loadingFile ? 'Loading…' : 'Pick a file from the tree to start reading.'}
              </Empty>
            </div>
          )}
        </main>
      </div>

      <HunkSheet hunk={hunk} onClose={() => setHunk(null)} />

      {/* Below md, writing a comment happens here rather than inline. */}
      <ComposerSheet
        line={!wide && file && !tooLong ? composing : null}
        initial={composing === null ? '' : (annotations.get(composing)?.comment ?? '')}
        busy={saving}
        onSave={(comment) => {
          if (file && composing !== null) void saveComment(file.path, composing, comment);
        }}
        onCancel={() => compose(null)}
      />

      {confirmDelete !== null && file ? (
        <ConfirmDialog
          title={`Delete the comment on line ${confirmDelete}?`}
          description="It is removed from REVIEW.md. The code itself is untouched."
          confirmLabel="Delete"
          danger
          busy={saving}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const line = confirmDelete;
            setConfirmDelete(null);
            void deleteComment(file.path, line);
          }}
        />
      ) : null}

      {leaving ? (
        <ConfirmDialog
          title="Leave without saving?"
          description="The edits in this file are lost. The file on disk is untouched."
          confirmLabel="Discard the edits"
          danger
          busy={saving}
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            // Leaves edit mode now. The exit waits for the dialog's history entry to go.
            agreed.current = leaving.go;
            edit.stop();
            setConflict(false);
            setLeaving(null);
          }}
        />
      ) : null}

      {confirmNew ? (
        <ConfirmDialog
          title="Start a new review?"
          description="REVIEW.md is deleted, so every comment in this review goes with it. The code itself is untouched."
          confirmLabel="Delete the review"
          danger
          busy={saving}
          onCancel={() => setConfirmNew(false)}
          onConfirm={() => {
            setConfirmNew(false);
            void newReview();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Whether a click is a plain left click. A modified click opens a tab or a
 * window and leaves the buffer here untouched.
 *
 * @param event The click.
 * @returns True for a plain click.
 */
function plainClick(event: React.MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Centred message for a pane without content. */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Names the repository an open file belongs to.
 *
 * A file outside every repository gets "no repository", which explains a pane
 * without gutter markers.
 *
 * @param repo The repository path of the file, or null.
 * @param repos Every repository of the workspace.
 * @returns The repository name, or its path when no repository matches.
 */
function whichRepo(repo: string | null, repos: ReviewRepo[]): string {
  if (repo === null) return 'no repository';
  return repos.find((r) => r.path === repo)?.name ?? repo;
}

/**
 * Formats in how many repositories the base resolved, for example " (2 of 3)".
 *
 * @param repos Every repository of the workspace.
 * @returns The note, or an empty string for one repository or when the base
 *   resolved in all of them.
 */
function resolvedIn(repos: ReviewRepo[]): string {
  if (repos.length <= 1) return '';
  const landed = repos.filter((repo) => repo.baseCommit !== '').length;
  return landed === repos.length ? '' : ` (${landed} of ${repos.length})`;
}

/**
 * Shortens a path from the left to its last two parts, so the filename fits a
 * narrow header.
 *
 * @param path The workspace path.
 * @returns The path, or "…/" and its last two parts.
 */
function shortPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}
