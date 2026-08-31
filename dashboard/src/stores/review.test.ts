import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type {
  ReviewFileResponse,
  ReviewStatusResponse,
  ReviewTreeResponse,
} from '../../../shared/types.ts';
import {
  closeFile,
  loadFile,
  loadTree,
  open,
  poll,
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
  return { reviewHash: '', headCommit: 'abc', statusHash: 'def', ...over };
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
