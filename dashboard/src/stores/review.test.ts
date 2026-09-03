import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type {
  ReviewFileResponse,
  ReviewStatusResponse,
  ReviewTreeResponse,
} from '../../../shared/types.ts';
import {
  closeFile,
  deleteComment,
  loadFile,
  loadTree,
  newReview,
  open,
  poll,
  recallScroll,
  rememberScroll,
  saveComment,
  setBase,
  useReview,
} from './review.ts';

/**
 * The review store's fetching and polling.
 *
 * The poll is the part worth pinning down: an idle review view costs one
 * request every few seconds, and it must refetch nothing while the
 * fingerprint stands still. Getting that wrong is invisible in use and
 * expensive on a phone.
 */

/** Requests the stub answered, in order. */
let requested: string[] = [];

/** The canned answers, by URL fragment. */
let answers: Record<string, unknown>;

/** How the next matching request should fail, if at all. */
let failWith: string | null = null;

function tree(over: Partial<ReviewTreeResponse> = {}): ReviewTreeResponse {
  return {
    root: '',
    hasGit: true,
    entries: [{ name: 'a.ts', path: 'a.ts', isDir: false }],
    truncated: false,
    statuses: {},
    counts: {},
    base: { rev: '', commit: '' },
    hasReview: false,
    started: '',
    ...over,
  };
}

function file(over: Partial<ReviewFileResponse> = {}): ReviewFileResponse {
  return {
    path: 'a.ts',
    content: 'one\ntwo\n',
    truncated: false,
    binary: false,
    deleted: false,
    size: 8,
    lines: 2,
    // No language, so the store never reaches the highlighter: tokenizing is
    // not what these tests are about.
    language: '',
    status: null,
    diff: { lines: {}, hunks: [], deletions: [] },
    annotations: [],
    ...over,
  };
}

function status(over: Partial<ReviewStatusResponse> = {}): ReviewStatusResponse {
  return { reviewHash: '', headCommit: 'abc', statusHash: 'def', fileHash: 'ghi', ...over };
}

beforeEach(() => {
  requested = [];
  failWith = null;
  answers = {
    '/review/tree': tree(),
    '/review/file': file(),
    '/review/status': status(),
  };

  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    if (failWith) {
      return new Response(JSON.stringify({ error: failWith }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const key = Object.keys(answers).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? answers[key] : {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // A fresh store per test: it is a singleton keyed by session id.
  useReview.setState({ sessionId: null, tree: null, file: null, fingerprint: null });
  open('abc123');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Requests whose URL mentions a fragment. */
function hits(fragment: string): number {
  return requested.filter((url) => url.includes(fragment)).length;
}

test('the tree loads and lands in the store', async () => {
  await loadTree();
  assert.equal(useReview.getState().tree?.entries.length, 1);
  assert.equal(useReview.getState().error, null);
  assert.equal(useReview.getState().loadingTree, false);
});

test('a failed tree fetch reports itself and stops loading', async () => {
  failWith = 'workspace is gone';
  await loadTree();
  assert.equal(useReview.getState().error, 'workspace is gone');
  assert.equal(useReview.getState().loadingTree, false);
});

test('opening a file asks once, with the path encoded', async () => {
  await loadFile('src/a b.ts');
  assert.equal(hits('/review/file'), 1);
  assert.match(requested.at(-1)!, /path=src%2Fa%20b\.ts/);
  assert.equal(useReview.getState().file?.path, 'a.ts');
  // Tokens arrive separately, and a file with no language has none at all.
  assert.equal(useReview.getState().file?.tokens, null);
});

test('closing a file leaves the tree loaded', async () => {
  await loadTree();
  await loadFile('a.ts');
  closeFile();
  assert.equal(useReview.getState().file, null);
  assert.ok(useReview.getState().tree);
});

test('re-opening the same session keeps what is loaded', async () => {
  await loadTree();
  open('abc123');
  // Otherwise every remount of the route would refetch the whole tree.
  assert.ok(useReview.getState().tree);
});

test('opening a different session discards the previous one', async () => {
  await loadTree();
  open('other');
  assert.equal(useReview.getState().tree, null);
  assert.equal(useReview.getState().sessionId, 'other');
});

test('how far a file was read is remembered per file', () => {
  rememberScroll('a.ts', 420);
  assert.equal(recallScroll('a.ts'), 420);
  // A file this review has not opened starts at the top, whatever the last
  // one was scrolled to — one pane serves them all.
  assert.equal(recallScroll('b.ts'), 0);
});

test('a new session starts every file at the top again', () => {
  rememberScroll('a.ts', 420);
  open('another-box');
  assert.equal(recallScroll('a.ts'), 0);
});

test('an unchanged fingerprint refetches nothing', async () => {
  await loadTree();
  await loadFile('a.ts');
  const before = requested.length;

  // The first poll has no fingerprint to compare against, so it refetches.
  await poll();
  const afterFirst = requested.length;
  assert.ok(afterFirst > before);

  // Every poll after that, with nothing moving, must cost one request.
  await poll();
  await poll();
  assert.equal(requested.length, afterFirst + 2);
  assert.equal(requested.at(-1)?.includes('/review/status'), true);
});

test('a moved fingerprint refetches the tree and the open file', async () => {
  await loadTree();
  await loadFile('a.ts');
  await poll();
  const before = { tree: hits('/review/tree'), file: hits('/review/file') };

  answers['/review/status'] = status({ statusHash: 'moved' });
  await poll();

  assert.equal(hits('/review/tree'), before.tree + 1);
  assert.equal(hits('/review/file'), before.file + 1);
});

test('an edit to the open file alone refetches it', async () => {
  await loadTree();
  await loadFile('a.ts');
  await poll();
  const before = hits('/review/file');

  // What the agent does most: rewrite a file that git already calls modified.
  // Nothing else about the workspace moves, so this hash is the only thing
  // that says the pane is showing text that is no longer there.
  answers['/review/status'] = status({ fileHash: 'rewritten' });
  await poll();

  assert.equal(hits('/review/file'), before + 1);
});

test('the poll names the open file, so the server can hash it', async () => {
  await loadTree();
  await loadFile('a.ts');
  await poll();
  assert.equal(
    requested.filter((url) => url.includes('/review/status')).at(-1)?.includes('path=a.ts'),
    true,
  );
});

test('a moved fingerprint with no file open refetches only the tree', async () => {
  await loadTree();
  await poll();
  const before = hits('/review/file');

  answers['/review/status'] = status({ reviewHash: 'now-there-is-one' });
  await poll();
  assert.equal(hits('/review/file'), before);
});

test('a failed poll is silent', async () => {
  await loadTree();
  failWith = 'the network went away';
  await poll();
  // An error banner every five seconds on a flaky link is worse than
  // silence, and the next poll will answer.
  assert.equal(useReview.getState().error, null);
});

test('a poll while a write is in flight is skipped', async () => {
  await loadTree();
  useReview.setState({ saving: true });
  const before = requested.length;
  await poll();
  // Refetching here would fight the optimistic annotation list.
  assert.equal(requested.length, before);
  useReview.setState({ saving: false });
});

test('a poll while a composer is open is skipped', async () => {
  await loadTree();
  useReview.setState({ composing: 4 });
  const before = requested.length;
  await poll();
  // Refetching would drop what is being typed.
  assert.equal(requested.length, before);
  useReview.setState({ composing: null });
});

test('nothing is fetched before a session is set', async () => {
  useReview.setState({ sessionId: null });
  await loadTree();
  await loadFile('a.ts');
  await poll();
  assert.deepEqual(requested, []);
});

// --- comments ---------------------------------------------------------------

test('a comment shows before the server confirms it', async () => {
  await loadTree();
  await loadFile('a.ts');

  answers['/review/annotations'] = {
    path: 'a.ts',
    annotations: [{ line: 2, comment: 'saved', outdated: false }],
  };
  const pending = saveComment('a.ts', 2, 'saved');
  // Optimistic, because the alternative is a spinner on every comment over a
  // phone connection.
  assert.deepEqual(useReview.getState().file?.annotations, [
    { line: 2, comment: 'saved', outdated: false },
  ]);
  await pending;
  assert.deepEqual(useReview.getState().file?.annotations, [
    { line: 2, comment: 'saved', outdated: false },
  ]);
  assert.equal(useReview.getState().saving, false);
  assert.equal(useReview.getState().composing, null);
});

test('a failed comment rolls back and says why', async () => {
  await loadTree();
  await loadFile('a.ts');
  failWith = 'REVIEW.md is being written by something else';

  await saveComment('a.ts', 2, 'lost');
  assert.deepEqual(useReview.getState().file?.annotations, []);
  assert.match(useReview.getState().error!, /being written/);
  assert.equal(useReview.getState().saving, false);
});

test('the tree badge follows a comment without refetching the tree', async () => {
  await loadTree();
  await loadFile('a.ts');
  const before = hits('/review/tree');

  answers['/review/annotations'] = {
    path: 'a.ts',
    annotations: [{ line: 2, comment: 'x', outdated: false }],
  };
  await saveComment('a.ts', 2, 'x');
  // A whole tree round trip for a badge is exactly the cost this view avoids.
  assert.equal(hits('/review/tree'), before);
  assert.deepEqual(useReview.getState().tree?.counts, { 'a.ts': 1 });
});

test('deleting the last comment clears the badge', async () => {
  await loadTree();
  await loadFile('a.ts');
  answers['/review/annotations'] = {
    path: 'a.ts',
    annotations: [{ line: 2, comment: 'x', outdated: false }],
  };
  await saveComment('a.ts', 2, 'x');

  answers['/review/annotations'] = { path: 'a.ts', annotations: [] };
  await deleteComment('a.ts', 2);
  assert.deepEqual(useReview.getState().file?.annotations, []);
  assert.deepEqual(useReview.getState().tree?.counts, {});
});

test('a comment on a file that is not open still updates the tree', async () => {
  await loadTree();
  answers['/review/annotations'] = {
    path: 'other.ts',
    annotations: [{ line: 1, comment: 'x', outdated: false }],
  };
  await saveComment('other.ts', 1, 'x');
  assert.deepEqual(useReview.getState().tree?.counts, { 'other.ts': 1 });
});

test('editing an existing comment replaces it rather than adding one', async () => {
  await loadTree();
  await loadFile('a.ts');
  answers['/review/annotations'] = {
    path: 'a.ts',
    annotations: [{ line: 2, comment: 'first', outdated: false }],
  };
  await saveComment('a.ts', 2, 'first');

  answers['/review/annotations'] = {
    path: 'a.ts',
    annotations: [{ line: 2, comment: 'second', outdated: false }],
  };
  await saveComment('a.ts', 2, 'second');
  assert.equal(useReview.getState().file?.annotations.length, 1);
  assert.equal(useReview.getState().file?.annotations[0]?.comment, 'second');
});

test('a new review clears the comments and reloads the tree', async () => {
  await loadTree();
  await loadFile('a.ts');
  answers['/review/annotations'] = {
    path: 'a.ts',
    annotations: [{ line: 2, comment: 'x', outdated: false }],
  };
  await saveComment('a.ts', 2, 'x');
  const before = hits('/review/tree');

  await newReview();
  assert.deepEqual(useReview.getState().file?.annotations, []);
  // The whole review is gone, so the counts have to come from the server
  // rather than be adjusted locally.
  assert.equal(hits('/review/tree'), before + 1);
  assert.equal(requested.some((url) => url.includes('/review') && !url.includes('/review/')), true);
});

// --- the base revision ------------------------------------------------------

test('setting a base refetches the tree and the open file', async () => {
  await loadTree();
  await loadFile('a.ts');
  const before = { tree: hits('/review/tree'), file: hits('/review/file') };

  answers['/review/base'] = { rev: 'main', commit: 'abcdef1234' };
  await setBase('main');

  // The base changes what a status and a diff mean, so both are answers to a
  // different question now and neither can be kept.
  assert.equal(hits('/review/tree'), before.tree + 1);
  assert.equal(hits('/review/file'), before.file + 1);
  assert.equal(useReview.getState().saving, false);
});

test('clearing the base sends null', async () => {
  await loadTree();
  answers['/review/base'] = { rev: '', commit: '' };
  await setBase(null);
  assert.ok(requested.some((url) => url.includes('/review/base')));
});

test('an unknown revision reports itself and changes nothing', async () => {
  await loadTree();
  await loadFile('a.ts');
  const before = hits('/review/tree');
  failWith = 'unknown revision: nope';

  await setBase('nope');
  assert.match(useReview.getState().error!, /unknown revision/);
  // Nothing is refetched, because nothing changed server-side.
  assert.equal(hits('/review/tree'), before);
  assert.equal(useReview.getState().saving, false);
});

test('an outdated comment is carried through as such', async () => {
  await loadTree();
  answers['/review/file'] = file({
    annotations: [{ line: 2, comment: 'about the old code', outdated: true }],
  });
  await loadFile('a.ts');
  // The drift check runs server side on the fetch, so the flag arriving here
  // is the whole of the client's part in it.
  assert.equal(useReview.getState().file?.annotations[0]?.outdated, true);
});
