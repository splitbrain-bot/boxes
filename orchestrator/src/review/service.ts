import { join } from 'node:path';
import type {
  ReviewAnnotation,
  ReviewBase,
  ReviewFileResponse,
  ReviewStatusResponse,
  ReviewTreeResponse,
} from '../../../shared/types.ts';
import type { Db, SessionRow } from '../db.ts';
import { log } from '../log.ts';
import { fileDiff } from './difflines.ts';
import {
  fileHash,
  fileLines,
  isDirectory,
  readTextFile,
  removeFile,
  resolveInRoot,
  subdirectories,
  textHash,
  writeFileAtomic,
} from './fs.ts';
import { headCommit, topLevel } from './git.ts';
import { fileStatuses, NO_BASE, resolveBase, type Base } from './gitstatus.ts';
import {
  annotationCounts,
  annotationsFor,
  checkDrift,
  deleteAnnotation,
  detectLang,
  parseReview,
  serializeReview,
  setAnnotation,
  todayStamp,
  type Review,
} from './store.ts';
import { REVIEW_FILE, reviewTree, treePaths } from './tree.ts';

/**
 * The per-session review façade: root resolution, the REVIEW.md
 * read-modify-write, and the poll fingerprint.
 *
 * REVIEW.md is the single source of truth and it is shared with the agent, so
 * there is no annotation table anywhere. Every mutation is
 * read → parse → apply → serialize → write-tmp-then-rename, under a per-session
 * lock, with the file's hash checked between the read and the write. If the
 * hash moved — the agent edited REVIEW.md mid-mutation — the whole thing is
 * re-read and re-applied once. A lost race costs one visible refresh rather
 * than data, because every write re-serializes the whole parsed file.
 *
 * Nothing here starts or touches a session container. That is the point of the
 * workspace being a directory: the natural moment to review is when the agent
 * is done and the box has idled out.
 */

/** Why a review request could not be served. */
export class ReviewUnavailable extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** What a session's review is rooted at, and whether git works there. */
interface Root {
  /** Absolute path of the review root. */
  path: string;
  /** The root relative to the workspace, '' when it is the workspace itself. */
  relative: string;
  hasGit: boolean;
}

/** Review operations over the sessions of one orchestrator. */
export class ReviewService {
  /**
   * One promise chain per session, so two mutations of the same REVIEW.md are
   * serialized. Different sessions do not wait on each other.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * The paths a session's tree lists, briefly remembered.
   *
   * A path is validated against the tree rather than merely against the root,
   * so the file endpoint serves exactly what the browser was offered and
   * nothing the ignore lists left out. Building the tree costs one `git
   * ls-files`, or a walk where there is no repository, and opening a file
   * almost always follows a tree fetch — so it is cached for a few seconds
   * rather than rebuilt per request.
   */
  private readonly treePaths = new Map<string, { at: number; paths: Set<string> }>();

  constructor(
    private readonly db: Db,
    /** Where a session's files are, or null while it is still volume-backed. */
    private readonly workspaceOf: (id: string) => string | null,
  ) {}

  // --- the workspace and the root -------------------------------------------

  /** How long a remembered tree path set is reused. */
  private static readonly TREE_CACHE_MS = 3000;

  /** The session row, or a 404 by the same rule every other endpoint uses. */
  private row(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    if (!row || row.status === 'deleted') throw new ReviewUnavailable(404, 'Session not found');
    return row;
  }

  /**
   * The session's workspace on this process's filesystem.
   *
   * A session created before workspaces became directories has none until its
   * next start, which recreates its container with the bind and copies the
   * volume across. 409 rather than 404, because the session is real and the
   * fix is a start — which is what the review view says.
   */
  private workspace(id: string): string {
    const row = this.row(id);
    const path = this.workspaceOf(row.id);
    if (!path || !isDirectory(path)) {
      throw new ReviewUnavailable(
        409,
        'This session stores its workspace in a volume the orchestrator cannot read. ' +
          'Start the session once to migrate it, then review it.',
      );
    }
    return path;
  }

  /**
   * Where the review is rooted, resolved once and remembered on the session
   * row.
   *
   * `/workspace` starts empty and an agent usually clones a project into a
   * subdirectory, so the workspace itself is frequently not the repository.
   * The stored value is re-validated rather than trusted: the agent can delete
   * the directory it named.
   */
  private async root(id: string): Promise<Root> {
    const workspace = this.workspace(id);
    const row = this.row(id);

    const stored = row.review_root;
    if (stored !== null) {
      const path = stored === '' ? workspace : join(workspace, stored);
      if (isDirectory(path)) {
        return { path, relative: stored, hasGit: (await topLevel(path)) === path };
      }
      log.session(id).info('review root is gone; resolving again', { root: stored });
    }

    const resolved = await this.resolveRoot(workspace);
    this.db
      .prepare('UPDATE sessions SET review_root = ? WHERE id = ?')
      .run(resolved.relative, id);
    return resolved;
  }

  /**
   * Root resolution, in the order the shapes actually occur:
   *
   * 1. The workspace is itself a git work tree — root there.
   * 2. It holds exactly one directory and that is a git work tree — root
   *    there, which is the overwhelmingly common shape after a clone.
   * 3. Neither — root at the workspace with the git features off, the way the
   *    desktop tool degrades outside a repository.
   */
  private async resolveRoot(workspace: string): Promise<Root> {
    // Only a top level at the workspace itself counts. One above it would be a
    // repository the workspace merely sits inside, and rooting there would
    // serve files outside the session.
    if ((await topLevel(workspace)) === workspace) {
      return { path: workspace, relative: '', hasGit: true };
    }

    const dirs = subdirectories(workspace).filter((name) => name !== '.git');
    if (dirs.length === 1) {
      const only = dirs[0]!;
      const path = join(workspace, only);
      if ((await topLevel(path)) === path) return { path, relative: only, hasGit: true };
    }

    return { path: workspace, relative: '', hasGit: false };
  }

  /** The base revision recorded for a session, or HEAD. */
  private base(id: string): Base {
    const row = this.row(id);
    if (!row.review_base_commit) return NO_BASE;
    return { rev: row.review_base_rev ?? '', commit: row.review_base_commit };
  }

  /** Where REVIEW.md is: at the review root, so the agent sees it as its own. */
  private reviewPath(root: Root): string {
    return join(root.path, REVIEW_FILE);
  }

  // --- reading --------------------------------------------------------------

  /**
   * The whole left panel: tree, statuses, comment counts, root and base.
   *
   * Drift runs here across every annotated file, because this is the response
   * that decides which files the tree marks as commented, and a stale
   * `(outdated)` in it would be visible. It is bounded by the number of
   * annotated files, which a review has tens of, not thousands.
   */
  async tree(id: string): Promise<ReviewTreeResponse> {
    const root = await this.root(id);
    const base = this.base(id);

    const [tree, statuses] = await Promise.all([
      reviewTree(root.path, root.hasGit),
      root.hasGit ? fileStatuses(root.path, base) : Promise.resolve(null),
    ]);

    const review = await this.driftAll(id, root);

    return {
      root: root.relative,
      hasGit: root.hasGit,
      entries: tree.entries,
      truncated: tree.truncated,
      statuses: statuses ?? {},
      counts: Object.fromEntries(annotationCounts(review)),
      base: { rev: base.rev, commit: base.commit },
      hasReview: fileHash(this.reviewPath(root)) !== '',
      started: review.started,
    };
  }

  /**
   * One file: content, diff markers and its comments, in one response.
   *
   * The content is plain text. Highlighting happens in the browser, so nothing
   * on this wire is render markup — which is also what keeps the orchestrator
   * out of the presentation business and makes every line an addressable row.
   */
  async file(id: string, relPath: string): Promise<ReviewFileResponse> {
    const root = await this.root(id);
    const path = await this.resolveListed(root, id, relPath);
    const read = readTextFile(path);
    const base = this.base(id);

    const [diff, statuses] = await Promise.all([
      root.hasGit && !read.binary
        ? fileDiff(root.path, base, relPath, read.content)
        : Promise.resolve(null),
      root.hasGit ? fileStatuses(root.path, base) : Promise.resolve(null),
    ]);

    const annotations = read.binary
      ? []
      : await this.driftFile(id, root, relPath, fileLines(read.content));

    return {
      path: relPath,
      content: read.content,
      truncated: read.truncated,
      binary: read.binary,
      size: read.size,
      lines: read.binary ? 0 : fileLines(read.content).length,
      language: detectLang(relPath),
      status: statuses?.[relPath] ?? null,
      diff: {
        lines: Object.fromEntries(Object.entries(diff?.lines ?? {})),
        hunks: diff?.hunks ?? [],
        deletions: diff?.deletions ?? [],
      },
      annotations,
    };
  }

  /**
   * The poll fingerprint: three cheap local hashes. The review view asks for
   * this every few seconds while its tab is visible and refetches only when one
   * of them moved.
   */
  async status(id: string): Promise<ReviewStatusResponse> {
    const root = await this.root(id);
    const base = this.base(id);
    const statuses = root.hasGit ? await fileStatuses(root.path, base) : null;
    return {
      reviewHash: fileHash(this.reviewPath(root)),
      headCommit: root.hasGit ? await headCommit(root.path) : '',
      // The map is serialized in key order so an unchanged working tree hashes
      // the same every time.
      statusHash: statuses ? textHash(JSON.stringify(Object.entries(statuses).toSorted())) : '',
    };
  }

  // --- mutation -------------------------------------------------------------

  /** Adds or replaces the comment on one line, and returns the file's comments. */
  async setAnnotation(
    id: string,
    relPath: string,
    line: number,
    comment: string,
  ): Promise<ReviewAnnotation[]> {
    if (!Number.isInteger(line) || line < 1) {
      throw new ReviewUnavailable(400, 'line must be a positive integer');
    }
    const text = comment.trim();
    if (text === '') throw new ReviewUnavailable(400, 'comment is required');
    if (text.length > 20_000) throw new ReviewUnavailable(400, 'comment is too long');

    const root = await this.root(id);
    // The path has to name a file of the tree, not merely resolve inside it:
    // an annotation on something the tree never listed could never be shown.
    const path = await this.resolveListed(root, id, relPath);
    const source = fileLines(readTextFile(path).content);

    return this.mutate(id, root, relPath, (review) => {
      setAnnotation(review, relPath, line, text, source);
    });
  }

  /** Removes the comment on one line, and returns what is left for the file. */
  async deleteAnnotation(id: string, relPath: string, line: number): Promise<ReviewAnnotation[]> {
    if (!Number.isInteger(line) || line < 1) {
      throw new ReviewUnavailable(400, 'line must be a positive integer');
    }
    const root = await this.root(id);
    return this.mutate(id, root, relPath, (review) => {
      deleteAnnotation(review, relPath, line);
    });
  }

  /**
   * Deletes REVIEW.md — the "New review" button.
   *
   * The file is the review, so this is the whole operation. The agent may have
   * already deleted it, which is not an error.
   */
  async deleteReview(id: string): Promise<void> {
    const root = await this.root(id);
    await this.withLock(id, async () => {
      removeFile(this.reviewPath(root));
    });
  }

  /**
   * Records the revision a review is compared against, resolved through the
   * merge base with HEAD so commits made on the base branch after branching off
   * are not reported as this branch's changes. Null clears it back to HEAD.
   */
  async setBase(id: string, rev: string | null): Promise<ReviewBase> {
    const root = await this.root(id);
    if (rev === null || rev.trim() === '') {
      this.db
        .prepare('UPDATE sessions SET review_base_rev = NULL, review_base_commit = NULL WHERE id = ?')
        .run(id);
      return { rev: '', commit: '' };
    }
    const wanted = rev.trim();
    if (wanted.length > 200) throw new ReviewUnavailable(400, 'rev is too long');
    if (!root.hasGit) throw new ReviewUnavailable(409, 'This workspace is not a git repository');

    const resolved = await resolveBase(root.path, wanted);
    if ('error' in resolved) throw new ReviewUnavailable(400, resolved.error);

    this.db
      .prepare('UPDATE sessions SET review_base_rev = ?, review_base_commit = ? WHERE id = ?')
      .run(resolved.base.rev, resolved.base.commit, id);
    return { rev: resolved.base.rev, commit: resolved.base.commit };
  }

  // --- the read-modify-write ------------------------------------------------

  /**
   * Applies one change to REVIEW.md and writes it back, under the session's
   * lock and guarded by the file's hash.
   *
   * The hash check is what makes sharing the file with the agent safe: between
   * the read and the write the agent may have edited or deleted REVIEW.md, and
   * writing the parse of the old content would silently drop its edit. On a
   * moved hash the whole thing is retried once against the new content, which
   * is enough — a second concurrent write in the same few milliseconds is not a
   * case worth an unbounded loop.
   */
  private async mutate(
    id: string,
    root: Root,
    relPath: string,
    apply: (review: Review) => void,
  ): Promise<ReviewAnnotation[]> {
    const path = this.reviewPath(root);
    return this.withLock(id, () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = fileHash(path);
        const review = this.read(path);
        apply(review);
        if (review.started === '') review.started = todayStamp();
        const serialized = serializeReview(review);

        if (fileHash(path) !== before) {
          log.session(id).info('REVIEW.md changed mid-write; re-applying');
          continue;
        }
        writeFileAtomic(path, serialized);
        return toAnnotations(annotationsFor(review, relPath));
      }
      throw new ReviewUnavailable(
        409,
        'REVIEW.md is being written by something else; try again',
      );
    });
  }

  /** Reads and parses REVIEW.md, or an empty review when there is none. */
  private read(path: string): Review {
    const hash = fileHash(path);
    if (hash === '') return { data: new Map(), started: '' };
    const read = readTextFile(path, 8 * 1024 * 1024);
    if (read.binary) return { data: new Map(), started: '' };
    return parseReview(read.content);
  }

  /**
   * Runs drift on every annotated file and writes the result once if anything
   * moved. Returns the review as it now stands.
   */
  private async driftAll(id: string, root: Root): Promise<Review> {
    const path = this.reviewPath(root);
    return this.withLock(id, () => {
      const before = fileHash(path);
      const review = this.read(path);
      if (review.data.size === 0) return review;

      let changed = false;
      for (const [file, annotations] of review.data) {
        if (checkDrift(annotations, this.sourceLines(root, file))) changed = true;
      }
      if (changed && fileHash(path) === before) {
        writeFileAtomic(path, serializeReview(review));
      }
      return review;
    });
  }

  /** Runs drift on one file and returns its comments as they now stand. */
  private async driftFile(
    id: string,
    root: Root,
    relPath: string,
    source: string[],
  ): Promise<ReviewAnnotation[]> {
    const path = this.reviewPath(root);
    return this.withLock(id, () => {
      const before = fileHash(path);
      const review = this.read(path);
      const annotations = review.data.get(relPath);
      if (!annotations) return [];
      if (checkDrift(annotations, source) && fileHash(path) === before) {
        writeFileAtomic(path, serializeReview(review));
      }
      return toAnnotations(annotationsFor(review, relPath));
    });
  }

  /**
   * A file's current lines for a drift check, or null when the file is gone —
   * which is what marks every annotation on it outdated.
   */
  private sourceLines(root: Root, relPath: string): string[] | null {
    const resolved = resolveInRoot(root.path, relPath);
    if (!resolved.ok || isDirectory(resolved.path)) return null;
    try {
      const read = readTextFile(resolved.path);
      // A truncated or binary read has nothing honest to compare against, so
      // the annotations are left alone rather than declared outdated.
      if (read.binary || read.truncated) return null;
      return fileLines(read.content);
    } catch {
      return null;
    }
  }

  /**
   * Runs `fn` with the session's REVIEW.md to itself.
   *
   * A plain promise chain rather than a mutex library: the queue is per
   * session, every holder is a few filesystem operations long, and a rejection
   * must not wedge the chain — hence the catch on the stored tail.
   */
  private withLock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    this.locks.set(
      id,
      result.catch(() => undefined),
    );
    return result;
  }

  /**
   * Resolves a client-supplied path, requiring that the tree lists it.
   *
   * Containment (fs.ts) is the security boundary; this is the narrower rule
   * that the API serves what the browser was shown. Every refusal is the same
   * 404, so an escape attempt learns nothing an unknown file would not have
   * told it.
   */
  private async resolveListed(root: Root, id: string, relPath: string): Promise<string> {
    const resolved = resolveInRoot(root.path, relPath);
    if (!resolved.ok || isDirectory(resolved.path)) {
      throw new ReviewUnavailable(404, 'File not found');
    }
    if (!(await this.listed(id, root)).has(relPath)) {
      throw new ReviewUnavailable(404, 'File not found');
    }
    return resolved.path;
  }

  /** The path set of a session's tree, rebuilt when the cached one is stale. */
  private async listed(id: string, root: Root): Promise<Set<string>> {
    const cached = this.treePaths.get(id);
    if (cached && Date.now() - cached.at < ReviewService.TREE_CACHE_MS) return cached.paths;
    const tree = await reviewTree(root.path, root.hasGit);
    const paths = treePaths(tree.entries);
    this.treePaths.set(id, { at: Date.now(), paths });
    return paths;
  }

  /** Drops a session's remembered tree, for a delete. */
  forget(id: string): void {
    this.treePaths.delete(id);
    this.locks.delete(id);
  }

  /**
   * The review root of a session, relative to the workspace, for the "hand to
   * agent" prompt. Empty when the workspace itself is the root.
   */
  async rootRelative(id: string): Promise<string> {
    return (await this.root(id)).relative;
  }
}

/** One file's annotations, as the API reports them: a list, in line order. */
function toAnnotations(annotations: Map<number, { comment: string; outdated: boolean }>): ReviewAnnotation[] {
  return [...annotations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, ann]) => ({ line, comment: ann.comment, outdated: ann.outdated }));
}
