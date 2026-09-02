import { create } from 'zustand';
import type {
  ReviewAnnotation,
  ReviewFileResponse,
  ReviewStatusResponse,
  ReviewTreeResponse,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { tokenizeLines, type Token } from '../lib/highlight.ts';
import { pollWhileVisible } from '../lib/poll.ts';

/**
 * The review view's whole state: the tree, the open file, and the poll that
 * keeps both honest.
 *
 * Freshness is polling, the pattern the session list already uses. The view
 * asks for a three-hash fingerprint every few seconds while its tab is
 * visible and refetches only when one of the hashes moved, which is also what
 * makes drift show up: the refetch is what runs it.
 *
 * The store is a singleton keyed by session id rather than one per mount, so
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
  sessionId: string | null;
  tree: ReviewTreeResponse | null;
  file: OpenFile | null;
  /** True while the tree is being fetched for the first time. */
  loadingTree: boolean;
  /** True while a file fetch is in flight. */
  loadingFile: boolean;
  /** What went wrong last, or null. Shown in place of the pane. */
  error: string | null;
  /** The last fingerprint seen, so a poll can tell a change from a repeat. */
  fingerprint: ReviewStatusResponse | null;
  /** A line whose composer is open, or null. */
  composing: number | null;
  /** True while an annotation write is in flight. */
  saving: boolean;
}

const EMPTY: ReviewState = {
  sessionId: null,
  tree: null,
  file: null,
  loadingTree: false,
  loadingFile: false,
  error: null,
  fingerprint: null,
  composing: null,
  saving: false,
};

export const useReview = create<ReviewState>(() => EMPTY);

/** Replaces part of the state. */
function set(next: Partial<ReviewState>): void {
  useReview.setState(next);
}

/** The state right now, for the async functions below. */
function get(): ReviewState {
  return useReview.getState();
}

/**
 * Points the store at a session, discarding another session's state.
 *
 * Called on every mount. Re-entering the same session keeps what is loaded,
 * which is what makes the back button from a file to the tree instant.
 */
export function open(sessionId: string): void {
  if (get().sessionId === sessionId) return;
  set({ ...EMPTY, sessionId });
}

/** Fetches the tree, statuses and comment counts. */
export async function loadTree(): Promise<void> {
  const { sessionId } = get();
  if (!sessionId) return;
  set({ loadingTree: true });
  try {
    const tree = await api.reviewTree(sessionId);
    set({ tree, error: null, loadingTree: false });
  } catch (err) {
    set({ error: (err as Error).message, loadingTree: false });
  }
}

/**
 * Opens one file: content, diff markers and comments in one request, then the
 * tokens once the grammar has loaded.
 *
 * The content is shown before the tokens arrive rather than after, so a slow
 * grammar import never delays reading the code. The token pass then checks the
 * file is still the open one, because a fast tap through the tree can outrun
 * it.
 */
export async function loadFile(path: string): Promise<void> {
  const { sessionId } = get();
  if (!sessionId) return;
  set({ loadingFile: true, composing: null });
  try {
    const file = await api.reviewFile(sessionId, path);
    set({ file: { ...file, tokens: null }, error: null, loadingFile: false });

    if (!file.binary && file.content !== '') {
      const tokens = await tokenizeLines(file.content, file.language);
      if (tokens && get().file?.path === path) {
        set({ file: { ...file, tokens } });
      }
    }
  } catch (err) {
    set({ error: (err as Error).message, loadingFile: false, file: null });
  }
}

/** Closes the open file, back to the tree on a phone. */
export function closeFile(): void {
  set({ file: null, composing: null });
}

/** Opens or closes the composer on one line. */
export function compose(line: number | null): void {
  set({ composing: line });
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
  const { sessionId, file } = get();
  if (!sessionId) return;
  const previous = file?.annotations ?? [];

  if (file && file.path === path) {
    const optimistic = [
      ...previous.filter((a) => a.line !== line),
      { line, comment: comment.trim(), outdated: false },
    ].sort((a, b) => a.line - b.line);
    set({ file: { ...file, annotations: optimistic }, composing: null, saving: true });
  }

  try {
    const answer = await api.setAnnotation(sessionId, { path, line, comment });
    applyAnnotations(path, answer.annotations, countDelta(previous, answer.annotations));
    set({ saving: false, error: null });
  } catch (err) {
    applyAnnotations(path, previous, 0);
    set({ saving: false, error: (err as Error).message });
  }
}

/** Deletes a comment, likewise optimistically. */
export async function deleteComment(path: string, line: number): Promise<void> {
  const { sessionId, file } = get();
  if (!sessionId) return;
  const previous = file?.annotations ?? [];

  if (file && file.path === path) {
    set({
      file: { ...file, annotations: previous.filter((a) => a.line !== line) },
      composing: null,
      saving: true,
    });
  }

  try {
    const answer = await api.deleteAnnotation(sessionId, path, line);
    applyAnnotations(path, answer.annotations, countDelta(previous, answer.annotations));
    set({ saving: false, error: null });
  } catch (err) {
    applyAnnotations(path, previous, 0);
    set({ saving: false, error: (err as Error).message });
  }
}

/** Deletes REVIEW.md — every comment of the session at once. */
export async function newReview(): Promise<void> {
  const { sessionId, file } = get();
  if (!sessionId) return;
  set({ saving: true });
  try {
    await api.deleteReview(sessionId);
    if (file) set({ file: { ...file, annotations: [] } });
    set({ saving: false, error: null, composing: null });
    await loadTree();
  } catch (err) {
    set({ saving: false, error: (err as Error).message });
  }
}

/**
 * Records a file's annotations, keeping the tree's badge in step.
 *
 * The tree is not refetched for a comment: the count is the one thing that
 * changed, and a whole tree round trip for a badge is exactly the cost this
 * view is trying not to pay.
 */
function applyAnnotations(path: string, annotations: ReviewAnnotation[], delta: number): void {
  const { file, tree } = get();
  if (file && file.path === path) set({ file: { ...file, annotations } });
  if (tree && delta !== 0) {
    const counts = { ...tree.counts };
    const next = (counts[path] ?? 0) + delta;
    if (next > 0) counts[path] = next;
    else delete counts[path];
    set({ tree: { ...tree, counts, hasReview: Object.keys(counts).length > 0 || tree.hasReview } });
  }
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
  const { sessionId, file } = get();
  if (!sessionId) return;
  set({ saving: true });
  try {
    await api.setReviewBase(sessionId, rev);
    set({ saving: false, error: null });
    await loadTree();
    if (file) await loadFile(file.path);
  } catch (err) {
    set({ saving: false, error: (err as Error).message });
  }
}

// --- the poll ---------------------------------------------------------------

/** Time between fingerprint polls, matching the session list's cadence. */
const POLL_MS = 5000;

/** Whether two fingerprints say the same thing. */
function same(a: ReviewStatusResponse | null, b: ReviewStatusResponse): boolean {
  return (
    a !== null &&
    a.reviewHash === b.reviewHash &&
    a.headCommit === b.headCommit &&
    a.statusHash === b.statusHash &&
    a.fileHash === b.fileHash
  );
}

/**
 * Asks for the fingerprint and refetches only what moved.
 *
 * This is the whole cost of an idle review view: one request answering a few
 * local hashes. Nothing is refetched while they stand still.
 *
 * The open file is named in the request, because its own hash is one of those
 * hashes: the agent editing the file being read changes nothing else about the
 * workspace.
 */
export async function poll(): Promise<void> {
  const { sessionId, fingerprint, file, saving, composing } = get();
  if (!sessionId) return;
  // Not while a write is in flight or a composer is open: refetching would
  // fight the optimistic list, or drop what is being typed.
  if (saving || composing !== null) return;
  try {
    const next = await api.reviewStatus(sessionId, file?.path);
    if (same(fingerprint, next)) return;
    set({ fingerprint: next });
    await loadTree();
    if (file) await loadFile(file.path);
  } catch {
    // A failed poll says nothing: the next one will answer, and an error
    // banner every five seconds on a flaky link is worse than silence.
  }
}

/**
 * Starts polling for as long as the tab is visible, and returns the teardown.
 *
 * Visible-tab only, like the session list: a review left open in a background
 * tab is not worth a request every five seconds, and coming back refetches
 * immediately anyway.
 */
export function startPolling(): () => void {
  return pollWhileVisible(() => void poll(), POLL_MS);
}
