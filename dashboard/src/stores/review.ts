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

/** Store for the review view: the tree, folder by folder, and the open file. */

/** The file the pane is showing, with its tokens once they arrive. */
export interface OpenFile extends ReviewFileResponse {
  /**
   * One token list per line, or null when the file renders plain. That
   * happens before the tokens arrive, without a grammar for the language, or
   * when the file or a line is too long to tokenize.
   */
  tokens: Token[][] | null;
}

/** What the review view renders. */
export interface ReviewState {
  /** The box the store holds, or null before the first `open`. */
  boxId: string | null;
  /**
   * What the review is, apart from its files. Every directory answer carries
   * it, so it holds what the last answer said.
   */
  facts: ReviewFacts | null;
  /** Each loaded directory by its path; the workspace root is ''. */
  dirs: Record<string, ReviewDirResponse>;
  /** The folders standing open, by path. */
  expanded: string[];
  /** The open file, or null. */
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
   * True while the pane holds unsaved edits.
   *
   * The view holds the buffer. The store reads this flag so that a refetch
   * does not throw half-typed work away.
   */
  dirty: boolean;
}

/** The state before any box is open. */
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

/** The review store, as a hook. */
export const useReview = create<ReviewState>(() => EMPTY);

/**
 * How far down each file was scrolled, by path.
 *
 * Kept outside the state, so a scroll does not re-render the view. Cleared
 * when the store points at another box.
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

/** Merges `next` into the state. */
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
 * The store is a singleton, so re-entering the same box keeps what is loaded
 * and paints at once.
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
 * `fresh` says the browser has arrived rather than opened a folder. It makes
 * the orchestrator ask git again and check every comment for drift. An answer
 * for a box the store has since left is dropped, so it cannot paint another
 * box's files.
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
 * Loads the root of the tree fresh, then every open folder.
 *
 * The view calls it on each arrival: on mount, when a file closes back to the
 * tree, and when the tab becomes visible. Only the root asks for a fresh git
 * snapshot, and the folders reuse it.
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
 * Opens a chain of single-child folders, loading each.
 *
 * `loadDir` calls it only on a directory's first answer, so a folder the
 * reviewer closed stays closed when the tree is refetched.
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
 * A loaded folder keeps its content when it is closed and opened again. The
 * next arrival refreshes it.
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
 * The path the last `loadFile` call asked for, or null. An answer for any
 * other path is dropped.
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
 * An answer is dropped when a later call has asked for another file, so two
 * answers that land out of order cannot leave the pane on the first file.
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

/**
 * Puts a file in the pane at once, and adds its tokens once they arrive.
 *
 * The tokens are dropped when another file has opened in the meantime.
 */
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

/** What came of a save. A conflict is the one failure the reviewer can resolve. */
export type SaveResult = { ok: true } | { ok: false; conflict: boolean };

/**
 * Writes the edited file back to the workspace.
 *
 * `hash` is the version the pane opened. The server refuses the save when the
 * file on disk has changed since. Passing null saves against the current
 * version on disk, which overrules that refusal.
 *
 * The server answers with the whole file view, so the pane repaints from it.
 * The tree reloads as well, because an edit changes the file's status.
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
    // The view explains a conflict, because it offers a choice. Other
    // failures go to the error line.
    set({ saving: false, error: conflict ? null : (err as Error).message });
    return { ok: false, conflict };
  }
}

// --- annotations ------------------------------------------------------------

/**
 * Writes a comment, showing it before the server has confirmed it.
 *
 * The server's answer then replaces the annotation list. A failure restores
 * the previous list.
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

/** Deletes a comment, removing it before the server has confirmed it. */
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

/** Deletes REVIEW.md, which removes every comment of the box. */
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
 * Records a file's annotations and patches the comment counts in the tree
 * without a refetch.
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
 * Moves a file's comment count in the directory that lists it, and marks the
 * folders above it as commented.
 *
 * A folder's mark says its subtree holds a comment. A new comment sets it at
 * once. Only the server clears it, on the next arrival, because only the whole
 * review tells whether a subtree still holds a comment.
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
 * Sets the revision the review is compared against. Null clears it, so each
 * repository compares against its own HEAD.
 *
 * The tree and the open file reload, because the base changes their statuses
 * and diff markers.
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
 * Skips while a write is in flight, a composer is open, or the pane holds
 * unsaved edits. A refetch then would overwrite the optimistic annotation
 * list or drop what is being typed.
 */
export async function refresh(): Promise<void> {
  const { boxId, file, saving, composing, dirty } = get();
  if (!boxId || saving || dirty || composing !== null) return;
  await loadTree();
  if (file) await loadFile(file.path);
}

/**
 * Refetches whenever the tab becomes visible again, and returns the teardown.
 *
 * Nothing fires while the tab stays visible. An agent may change files in
 * that time, and the drift check on the next arrival moves or outdates the
 * comments it affects.
 */
export function refreshOnReturn(): () => void {
  return refetchOnVisible(() => void refresh());
}
