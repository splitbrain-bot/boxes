import { create } from 'zustand';
import type {
  ReviewAnnotation,
  ReviewDirEntry,
  ReviewDirResponse,
  ReviewFacts,
  ReviewFileResponse,
} from '../../../shared/types.ts';
import { ApiError, api } from '../api.ts';
import { tokenizeLines, type Token } from '../lib/highlight.ts';
import { refetchOnVisible } from '../lib/poll.ts';

/**
 * The review view's whole state: the tree, folder by folder, and the open file.
 *
 * The tree is fetched a directory at a time, so opening a folder is one small
 * request and a workspace with a dependency tree in it costs nothing until
 * somebody opens that. Each answer carries the review-wide facts with it, so
 * the first screen is one request.
 *
 * Freshness is the fetch, and there is no poll. What matters is being fresh on
 * arrival, and arrival is three moments: the view mounting, a file closing back
 * to the tree, and the tab becoming visible again. Each of them calls
 * {@link loadTree}, which is what tells the orchestrator to ask git again.
 *
 * The store is a singleton keyed by box id rather than one per mount, so
 * navigating between files does not lose the tree, and remounting the route
 * does not refetch what has not changed.
 */

/** The file the pane is showing, with its tokens once they arrive. */
export interface OpenFile extends ReviewFileResponse {
  /**
   * One token list per line, or null when the file is rendered plain: no
   * grammar for its language, or lines too long to tokenize without janking.
   */
  tokens: Token[][] | null;
}

export interface ReviewState {
  boxId: string | null;
  /**
   * What the review is, apart from its files. Carried by every directory
   * answer, so it is whatever the last one said.
   */
  facts: ReviewFacts | null;
  /** Each loaded directory by its path; the workspace root is ''. */
  dirs: Record<string, ReviewDirResponse>;
  /** The folders standing open, by path. */
  expanded: string[];
  file: OpenFile | null;
  /** True while the root of the tree is being fetched for the first time. */
  loadingTree: boolean;
  /** True while a file fetch is in flight. */
  loadingFile: boolean;
  /** What went wrong last, or null. Shown in place of the pane. */
  error: string | null;
  /** A line whose composer is open, or null. */
  composing: number | null;
  /** True while an annotation write is in flight. */
  saving: boolean;
  /**
   * True while the pane holds edits nobody has saved.
   *
   * The buffer itself is the view's, but freshness is the store's, and a
   * refetch landing on top of half-typed work would throw it away. Switching
   * tabs is the common way that happens on a phone.
   */
  dirty: boolean;
}

const EMPTY: ReviewState = {
  boxId: null,
  facts: null,
  dirs: {},
  expanded: [],
  file: null,
  loadingTree: false,
  loadingFile: false,
  error: null,
  composing: null,
  saving: false,
  dirty: false,
};

export const useReview = create<ReviewState>(() => EMPTY);

/**
 * How far down each file was read, by path.
 *
 * Outside the store's state because nothing renders from it: the pane writes
 * it on scroll and reads it once when a file opens, and putting it in the
 * state would re-render the whole view on every scroll frame. Cleared with
 * the rest when the store points at another box, so "not opened in this
 * review" and "opened at the top" stay different answers.
 */
const scrollOffsets = new Map<string, number>();

/** Records how far down a file is scrolled. */
export function rememberScroll(path: string, offset: number): void {
  scrollOffsets.set(path, offset);
}

/** How far down a file was left, or 0 for one this review has not opened. */
export function recallScroll(path: string): number {
  return scrollOffsets.get(path) ?? 0;
}

/** Replaces part of the state. */
function set(next: Partial<ReviewState>): void {
  useReview.setState(next);
}

/** The state right now, for the async functions below. */
function get(): ReviewState {
  return useReview.getState();
}

/**
 * Points the store at a box, discarding another box's state.
 *
 * Called on every mount. Re-entering the same box keeps what is loaded,
 * which is what makes the back button from a file to the tree instant.
 */
export function open(boxId: string): void {
  if (get().boxId === boxId) return;
  scrollOffsets.clear();
  set({ ...EMPTY, boxId });
}

/**
 * Fetches one directory: its children, their statuses and their comment
 * counts, and the review-wide facts around them.
 *
 * `fresh` says the browser has arrived rather than opened a folder, which is
 * what makes the orchestrator ask git about the workspace again. An answer for
 * a box the store has since left is dropped: a slow directory landing after
 * the route moved on would paint another box's files.
 */
export async function loadDir(path: string, fresh = false): Promise<void> {
  const { boxId } = get();
  if (!boxId) return;
  if (path === '' && !get().dirs['']) set({ loadingTree: true });
  try {
    const dir = await api.reviewDir(boxId, path, fresh);
    if (get().boxId !== boxId) return;
    const first = get().dirs[path] === undefined;
    set({
      dirs: { ...get().dirs, [path]: dir },
      facts: factsOf(dir),
      error: null,
      loadingTree: false,
    });
    if (first) unwrap(dir);
  } catch (err) {
    if (get().boxId !== boxId) return;
    set({ error: (err as Error).message, loadingTree: false });
  }
}

/**
 * Loads the root of the tree and every folder standing open, with git's answer
 * for the workspace taken again.
 *
 * What the three arrivals call. The root asks for that fresh answer and the
 * folders under it are slices of the one it leaves behind, so this is one run
 * of git however many folders are open.
 */
export async function loadTree(): Promise<void> {
  const open = get().expanded;
  await loadDir('', true);
  await Promise.all(open.map((path) => loadDir(path)));
}

/** The review-wide part of a directory answer. */
function factsOf(dir: ReviewDirResponse): ReviewFacts {
  const { repos, hasGit, base, hasReview, started, commentCount } = dir;
  return { repos, hasGit, base, hasReview, started, commentCount };
}

/**
 * Follows a chain of single-child folders open, loading each.
 *
 * A `src/main/java/com/…` prefix is noise rather than structure, and opening it
 * saves four taps on a phone. Only on a directory's first answer, so a folder
 * the reviewer closed stays closed when the tree is refetched.
 */
function unwrap(dir: ReviewDirResponse): void {
  if (dir.entries.length !== 1) return;
  const only = dir.entries[0]!;
  if (!only.isDir || get().expanded.includes(only.path)) return;
  set({ expanded: [...get().expanded, only.path] });
  void loadDir(only.path);
}

/**
 * Opens or closes one folder of the tree, fetching it the first time.
 *
 * A folder that has been loaded keeps what it holds when it is closed and
 * opened again: what it says is as fresh as the last arrival, and asking again
 * for every tap is the cost this view is built to avoid.
 */
export function toggleDir(path: string): void {
  const { expanded, dirs } = get();
  if (expanded.includes(path)) {
    set({ expanded: expanded.filter((open) => open !== path) });
    return;
  }
  set({ expanded: [...expanded, path] });
  if (!dirs[path]) void loadDir(path);
}

/**
 * What the last loadFile call asked for, so an answer something else has
 * overtaken can be dropped.
 *
 * Outside the state because nothing renders from it: it says what was asked
 * for rather than what the pane is showing.
 */
let requestedPath: string | null = null;

/** Whether a fetch's answer is still the one the store is waiting for. */
function stillWanted(boxId: string, path: string): boolean {
  return get().boxId === boxId && requestedPath === path;
}

/**
 * Opens one file: content, diff markers and comments in one request, then the
 * tokens once the grammar has loaded.
 *
 * The content is shown before the tokens arrive rather than after, so a slow
 * grammar import never delays reading the code. The token pass then checks the
 * file is still the open one, because a fast tap through the tree can outrun
 * it — and so does the content itself, because two taps whose answers land
 * out of order would otherwise leave the pane on the first file while the URL
 * and the tree both say the second.
 */
export async function loadFile(path: string): Promise<void> {
  const { boxId } = get();
  if (!boxId) return;
  requestedPath = path;
  set({ loadingFile: true, composing: null });
  try {
    const file = await api.reviewFile(boxId, path);
    if (!stillWanted(boxId, path)) return;
    set({ error: null, loadingFile: false });
    await show(file);
  } catch (err) {
    if (!stillWanted(boxId, path)) return;
    set({ error: (err as Error).message, loadingFile: false, file: null });
  }
}

/** Puts a file in the pane, and its colours there once they arrive. */
async function show(file: ReviewFileResponse): Promise<void> {
  set({ file: { ...file, tokens: null } });
  if (file.binary || file.content === '') return;
  const tokens = await tokenizeLines(file.content, file.language);
  if (tokens && get().file?.path === file.path) {
    set({ file: { ...file, tokens } });
  }
}

/** Closes the open file, back to the tree on a phone. */
export function closeFile(): void {
  requestedPath = null;
  set({ file: null, composing: null, dirty: false });
}

/** Records whether the pane is holding unsaved edits. */
export function setDirty(dirty: boolean): void {
  if (get().dirty !== dirty) set({ dirty });
}

/** Opens or closes the composer on one line. */
export function compose(line: number | null): void {
  set({ composing: line });
}

// --- editing ----------------------------------------------------------------

/** What came of a save. A conflict is the one failure the reviewer can answer. */
export type SaveResult = { ok: true } | { ok: false; conflict: boolean };

/**
 * Writes the edited file back to the workspace.
 *
 * `hash` is what the pane was opened against, and the server refuses a save
 * when the file has moved past it — which is the agent having written the same
 * file while the reviewer was typing. Passing null instead asks for whatever is
 * on disk now, which is how the reviewer overrules that refusal once they have
 * been told about it.
 *
 * The answer is the whole file view, so the pane repaints from the save alone:
 * new content, new diff, and the comments where drift has moved them to. The
 * tree follows separately, because an edit changes a file's status and its
 * colour in the list.
 */
export async function saveFile(
  path: string,
  content: string,
  hash: string | null,
): Promise<SaveResult> {
  const { boxId } = get();
  if (!boxId) return { ok: false, conflict: false };
  set({ saving: true });
  try {
    const against = hash ?? (await api.reviewFile(boxId, path)).hash;
    const saved = await api.saveReviewFile(boxId, { path, content, hash: against });
    set({ saving: false, error: null });
    await show(saved);
    void loadTree();
    return { ok: true };
  } catch (err) {
    const conflict = err instanceof ApiError && err.status === 412;
    // A conflict is the view's to explain, because it comes with a choice.
    // Anything else is a plain failure and belongs in the error line.
    set({ saving: false, error: conflict ? null : (err as Error).message });
    return { ok: false, conflict };
  }
}

// --- annotations ------------------------------------------------------------

/**
 * Writes a comment, showing it before the server has confirmed it.
 *
 * Optimistic because the alternative is a spinner on every comment over a
 * phone connection, and the rollback is cheap: the annotation list is replaced
 * by whatever the server answers with, and by the previous list on a failure.
 */
export async function saveComment(path: string, line: number, comment: string): Promise<void> {
  const { boxId, file } = get();
  if (!boxId) return;
  const previous = file?.annotations ?? [];
  set({ saving: true });

  if (file && file.path === path) {
    const optimistic = [
      ...previous.filter((a) => a.line !== line),
      { line, comment: comment.trim(), outdated: false },
    ].sort((a, b) => a.line - b.line);
    set({ file: { ...file, annotations: optimistic }, composing: null });
  }

  try {
    const answer = await api.setAnnotation(boxId, { path, line, comment });
    applyAnnotations(path, answer.annotations, countDelta(previous, answer.annotations));
    set({ saving: false, error: null });
  } catch (err) {
    applyAnnotations(path, previous, 0);
    set({ saving: false, error: (err as Error).message });
  }
}

/** Deletes a comment, likewise optimistically. */
export async function deleteComment(path: string, line: number): Promise<void> {
  const { boxId, file } = get();
  if (!boxId) return;
  const previous = file?.annotations ?? [];
  set({ saving: true });

  if (file && file.path === path) {
    set({
      file: { ...file, annotations: previous.filter((a) => a.line !== line) },
      composing: null,
    });
  }

  try {
    const answer = await api.deleteAnnotation(boxId, path, line);
    applyAnnotations(path, answer.annotations, countDelta(previous, answer.annotations));
    set({ saving: false, error: null });
  } catch (err) {
    applyAnnotations(path, previous, 0);
    set({ saving: false, error: (err as Error).message });
  }
}

/** Deletes REVIEW.md — every comment of the box at once. */
export async function newReview(): Promise<void> {
  const { boxId, file } = get();
  if (!boxId) return;
  set({ saving: true });
  try {
    await api.deleteReview(boxId);
    if (file) set({ file: { ...file, annotations: [] } });
    set({ saving: false, error: null, composing: null });
    await loadTree();
  } catch (err) {
    set({ saving: false, error: (err as Error).message });
  }
}

/**
 * Records a file's annotations, keeping the tree's badges in step.
 *
 * The tree is not refetched for a comment: the count is the one thing that
 * changed, and a round trip per badge is exactly the cost this view is trying
 * not to pay. The badge lives on the file's entry in the directory that lists
 * it, so patching it means finding that directory.
 */
function applyAnnotations(path: string, annotations: ReviewAnnotation[], delta: number): void {
  const { file, facts } = get();
  if (file && file.path === path) set({ file: { ...file, annotations } });
  if (!facts || delta === 0) return;
  const commentCount = Math.max(0, facts.commentCount + delta);
  set({
    facts: { ...facts, commentCount, hasReview: facts.hasReview || commentCount > 0 },
    dirs: patchCounts(get().dirs, path, delta),
  });
}

/**
 * Moves a file's comment count where its directory holds it, and lights the
 * folders on the way down to it.
 *
 * A folder's badge says its subtree holds a comment. It goes on as soon as one
 * is written, and comes off again when the server answers for that folder on
 * the next arrival — whether a subtree still holds a comment after a deletion
 * is a question only the whole review can answer.
 */
function patchCounts(
  dirs: Record<string, ReviewDirResponse>,
  path: string,
  delta: number,
): Record<string, ReviewDirResponse> {
  const next = { ...dirs };

  /** Replaces one entry of one loaded directory, where both are there. */
  const patch = (
    dirPath: string,
    entryPath: string,
    change: (entry: ReviewDirEntry) => ReviewDirEntry,
  ): void => {
    const dir = next[dirPath];
    if (!dir) return;
    next[dirPath] = {
      ...dir,
      entries: dir.entries.map((entry) => (entry.path === entryPath ? change(entry) : entry)),
    };
  };

  const parts = path.split('/');
  patch(parts.slice(0, -1).join('/'), path, (entry) => ({
    ...entry,
    comments: Math.max(0, (entry.comments ?? 0) + delta),
  }));
  if (delta > 0) {
    for (let i = 1; i < parts.length; i++) {
      patch(parts.slice(0, i - 1).join('/'), parts.slice(0, i).join('/'), (entry) => ({
        ...entry,
        commented: true,
      }));
    }
  }
  return next;
}

/** How much a file's comment count moved. */
function countDelta(before: ReviewAnnotation[], after: ReviewAnnotation[]): number {
  return after.length - before.length;
}

// --- the base revision ------------------------------------------------------

/**
 * Sets the revision the review is compared against, or clears it back to HEAD.
 *
 * Everything the base touches is refetched, because it changes what a status
 * and a diff mean: the tree's colours and the open file's markers are both
 * answers to "compared against what".
 */
export async function setBase(rev: string | null): Promise<void> {
  const { boxId, file } = get();
  if (!boxId) return;
  set({ saving: true });
  try {
    await api.setReviewBase(boxId, rev);
    set({ saving: false, error: null });
    await loadTree();
    if (file) await loadFile(file.path);
  } catch (err) {
    set({ saving: false, error: (err as Error).message });
  }
}

// --- freshness --------------------------------------------------------------

/**
 * Refetches what is on screen: the tree, and the open file if there is one.
 *
 * Not while a write is in flight, a composer is open, or the pane holds
 * unsaved edits — refetching would fight the optimistic annotation list, or
 * drop what is being typed. That guard is the one piece of the poll's logic
 * worth keeping, and edit mode is the case it matters most for: an edit is a
 * whole file of work, and coming back to the tab is how a phone returns.
 */
export async function refresh(): Promise<void> {
  const { boxId, file, saving, composing, dirty } = get();
  if (!boxId || saving || dirty || composing !== null) return;
  await loadTree();
  if (file) await loadFile(file.path);
}

/**
 * Refetches whenever the tab comes back to the front, and returns the
 * teardown.
 *
 * On a phone, switching apps and coming back is the dominant shape of
 * returning to a review — the browser's own back button is the other, and that
 * remounts. Nothing fires while the tab is open and still, so an idle review
 * costs nothing at all.
 *
 * The residual is that a background task can be working while the review is
 * open. Drift already covers the consequence: a comment whose code moved
 * follows it, and one whose code is gone is marked outdated.
 */
export function refreshOnReturn(): () => void {
  return refetchOnVisible(() => void refresh());
}
