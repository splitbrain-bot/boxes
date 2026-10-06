import { join } from 'node:path';
import type {
  ReviewAnnotation,
  ReviewBaseResponse,
  ReviewDirResponse,
  ReviewFileResponse,
  ReviewRepo,
} from '../../../shared/types.ts';
import type { Db, BoxRow } from '../db.ts';
import { HttpError } from '../http-error.ts';
import { log } from '../log.ts';
import { emptyDiff, fileDiff } from './difflines.ts';
import {
  fileHash,
  fileLines,
  isDirectory,
  MAX_FILE_BYTES,
  MAX_REVIEW_BYTES,
  readTextFile,
  removeFile,
  resolveInRoot,
  writeFileAtomic,
} from './fs.ts';
import { headCommit, type GitBox } from './git.ts';
import {
  fileStatuses,
  NO_BASE,
  resolveBase,
  resolveBases,
  workspaceStatuses,
  type Base,
  type FileStatuses,
} from './gitstatus.ts';
import { discoverRepos, gitTarget, inRepo, type Repo, type RepoMap } from './repos.ts';
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
import {
  dirEntries,
  holdsDeleted,
  listedDir,
  listedFile,
  MAX_DIR_ENTRIES,
  readDir,
  REVIEW_FILE,
  type DirChild,
} from './tree.ts';

/**
 * What one review last learned from git about the whole workspace. Every
 * directory answer is a slice of it.
 */
interface GitSnapshot {
  /** When it was taken, which is what its lifetime is measured from. */
  at: number;
  /** The repositories the workspace held, and which of them owns a path. */
  map: RepoMap;
  /** The same repositories as the API reports them. */
  repos: ReviewRepo[];
  /** The git status of every changed file in the workspace, by path. */
  statuses: FileStatuses;
}

/** What the review needs of the boxes it is a view onto. */
export interface ReviewBoxes {
  /** Where a box's files are, or null for an unknown or deleted box. */
  workspacePath(id: string): string | null;
  /**
   * The box's container, started if it was stopped, and the directory a
   * command runs in inside it.
   *
   * Asking for it marks the box active, so a review that keeps asking
   * keeps the box it is asking about.
   */
  execTarget(id: string): Promise<{ containerId: string; workingDir: string }>;
}

/**
 * Review operations over the boxes of one orchestrator.
 *
 * The review of a box is its whole workspace. REVIEW.md at the workspace root
 * is the only store of annotations, and the agent can edit it too. Files are
 * read and written on this process's filesystem. Git runs in the box's
 * container, so a request that needs git starts a stopped box and marks it
 * active.
 */
export class ReviewService {
  /**
   * One promise chain per box, so two mutations of the same REVIEW.md are
   * serialized. Different boxes do not wait on each other.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  /** What each open review last learned from git, by box id. */
  private readonly snapshots = new Map<string, GitSnapshot>();

  constructor(
    /** The database that holds the box rows. */
    private readonly db: Db,
    /** The boxes the reviews look into. */
    private readonly boxes: ReviewBoxes,
  ) {}

  // --- the workspace and its repositories -----------------------------------

  /**
   * How long a git snapshot is reused when no request asks for a new one.
   *
   * A burst of folder taps runs git once. Arrivals, saves and base changes
   * take a new snapshot sooner.
   */
  private static readonly SNAPSHOT_MS = 60_000;

  /** The box row, or a 404 for an unknown or deleted box. */
  private row(id: string): BoxRow {
    const row = this.db.prepare('SELECT * FROM boxes WHERE id = ?').get(id) as
      | BoxRow
      | undefined;
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Box not found');
    return row;
  }

  /**
   * The box's workspace on this process's filesystem, which is the review
   * root.
   *
   * A box whose directory is gone is a 409 rather than a 404, because the
   * box exists.
   */
  private workspace(id: string): string {
    const row = this.row(id);
    const path = this.boxes.workspacePath(row.id);
    if (!path || !isDirectory(path)) {
      throw new HttpError(
        409,
        'The workspace directory of this box cannot be found. ' +
          'Restore the files from a backup, or delete the box.',
      );
    }
    return path;
  }

  /**
   * The box's container to run git in, started if it was stopped.
   *
   * Each request asks for it again, because a container can stop or be
   * replaced between two requests.
   */
  private async box(id: string): Promise<GitBox> {
    const target = await this.boxes.execTarget(id);
    return { containerId: target.containerId, workspaceDir: target.workingDir };
  }

  /**
   * What a review knows from git: which repositories the workspace holds, what
   * each is compared against, and the status of every changed file in it.
   *
   * The snapshot is reused, because each git call is a `docker exec` into the
   * box. A new one is taken when `fresh` says the browser has just arrived,
   * after a save or a base change, and when {@link SNAPSHOT_MS} has passed.
   */
  private async snapshot(box: GitBox, id: string, fresh: boolean): Promise<GitSnapshot> {
    const held = this.snapshots.get(id);
    if (!fresh && held && Date.now() - held.at < ReviewService.SNAPSHOT_MS) return held;

    const map = await discoverRepos(this.workspace(id), box);
    const bases = await resolveBases(box, map, this.baseRev(id));
    const [repos, statuses] = await Promise.all([
      this.describeRepos(box, map, bases),
      workspaceStatuses(box, map, bases),
    ]);
    const taken: GitSnapshot = { at: Date.now(), map, repos, statuses };
    this.snapshots.set(id, taken);
    return taken;
  }

  /** Drops a box's git snapshot, for a change that moves what git says. */
  private invalidate(id: string): void {
    this.snapshots.delete(id);
  }

  /**
   * The revision expression the box compares against, or '' when none is set,
   * which compares each repository against its own HEAD.
   *
   * One expression serves the whole workspace. It resolves to a different
   * commit in each repository, and those commits are not stored.
   */
  private baseRev(id: string): string {
    return this.row(id).review_base_rev ?? '';
  }

  /** Where REVIEW.md is: at the workspace root. */
  private reviewPath(workspace: string): string {
    return join(workspace, REVIEW_FILE);
  }

  // --- reading --------------------------------------------------------------

  /**
   * One directory of the review: its children, and the facts the whole view
   * needs.
   *
   * Listing and status come in one answer, because a file the change deleted
   * has no directory entry and only the status map names it.
   *
   * `fresh` says the browser has arrived: the view mounted, a file closed back
   * to the tree, or the tab came back. It takes a new git snapshot and runs the
   * drift check over every annotated file. Opening a folder does neither.
   */
  async dir(id: string, relDir: string, fresh: boolean): Promise<ReviewDirResponse> {
    const workspace = this.workspace(id);
    const box = await this.box(id);
    const taken = await this.snapshot(box, id, fresh);

    const review = fresh
      ? await this.driftAll(id, workspace)
      : await this.withLock(id, () => this.read(this.reviewPath(workspace)));
    const counts = annotationCounts(review);

    const children = this.children(workspace, relDir, taken.statuses);
    const listed = dirEntries(relDir, children, taken.statuses, counts, taken.map);
    const truncated = listed.length > MAX_DIR_ENTRIES;

    return {
      path: relDir,
      entries: truncated ? listed.slice(0, MAX_DIR_ENTRIES) : listed,
      truncated,
      repos: taken.repos,
      hasGit: taken.map.hasGit,
      base: { rev: this.baseRev(id) },
      hasReview: fileHash(this.reviewPath(workspace)) !== '',
      started: review.started,
      commentCount: [...counts.values()].reduce((total, count) => total + count, 0),
    };
  }

  /**
   * One file: content, diff markers and its comments, in one response.
   *
   * The diff and the status come from the repository that owns the path, with
   * the path as that repository names it. A file no repository claims gets
   * neither. The content is plain text, and the browser does the highlighting.
   */
  async file(id: string, relPath: string): Promise<ReviewFileResponse> {
    const workspace = this.workspace(id);
    const box = await this.box(id);
    const { map } = await this.snapshot(box, id, false);
    const repo = map.repoFor(relPath);
    const path = await this.resolveFile(box, id, workspace, relPath);
    if (path === null) {
      return goneFile(relPath, repo, await this.annotationsOf(id, workspace, relPath));
    }
    const read = readTextFile(path);
    const base = repo ? await this.baseIn(box, id, repo) : NO_BASE;

    // Only the owning repository is asked, so opening a file costs the same
    // however many repositories the workspace holds.
    const [diff, statuses] = await Promise.all([
      repo && !read.binary
        ? fileDiff(gitTarget(box, repo.path), base, inRepo(repo, relPath), read.content)
        : Promise.resolve(null),
      repo ? fileStatuses(gitTarget(box, repo.path), base) : Promise.resolve(null),
    ]);

    // The drift check needs the whole text, so the comments on a binary or
    // truncated file come back as they stand.
    const annotations =
      read.binary || read.truncated
        ? await this.annotationsOf(id, workspace, relPath)
        : await this.driftFile(id, workspace, relPath, fileLines(read.content));

    return {
      path: relPath,
      repo: repo?.path ?? null,
      content: read.content,
      hash: fileHash(path),
      truncated: read.truncated,
      binary: read.binary,
      deleted: false,
      size: read.size,
      lines: read.binary ? 0 : fileLines(read.content).length,
      language: detectLang(relPath),
      status: (repo ? statuses?.[inRepo(repo, relPath)] : null) ?? null,
      diff: {
        lines: Object.fromEntries(Object.entries(diff?.lines ?? {})),
        hunks: diff?.hunks ?? [],
        deletions: diff?.deletions ?? [],
      },
      annotations,
    };
  }

  /**
   * Resolves a client-supplied path to a file on disk the review offers, for
   * serving its bytes.
   *
   * It applies `listedFile` and `resolveInRoot` as {@link resolveFile} does,
   * without asking git. A deleted file has no bytes to serve, so it gets the
   * same 404 as any path the review does not offer.
   */
  rawFile(id: string, relPath: string): string {
    const workspace = this.workspace(id);
    if (!listedFile(relPath)) throw new HttpError(404, 'File not found');
    const resolved = resolveInRoot(workspace, relPath);
    if (!resolved.ok) throw new HttpError(404, 'File not found');
    return resolved.path;
  }

  // --- mutation -------------------------------------------------------------

  /**
   * Replaces one file of the workspace with the reviewer's edited content, and
   * returns the file view as it now stands.
   *
   * `hash` is the file hash the browser last read. When the file no longer
   * matches it, something else changed it, and the save is refused so that
   * change is not lost. A truncated file is refused too, because the browser
   * holds only the part up to the cap. The response comes from {@link file},
   * whose drift check moves the comments with the edit.
   */
  async writeFile(
    id: string,
    relPath: string,
    content: string,
    hash: string,
  ): Promise<ReviewFileResponse> {
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new HttpError(400, 'This file is larger than the display limit.');
    }

    const workspace = this.workspace(id);
    const box = await this.box(id);
    const path = await this.resolveFile(box, id, workspace, relPath);
    if (path === null) {
      throw new HttpError(409, 'This file was deleted, so there is nothing to save.');
    }

    const read = readTextFile(path);
    if (read.binary) throw new HttpError(409, 'This file is binary, so it cannot be edited.');
    if (read.truncated) {
      throw new HttpError(
        409,
        'This file is larger than the display limit, so it cannot be saved.',
      );
    }
    // 412 rather than 409, because the reviewer can overrule this refusal and
    // save anyway.
    if (fileHash(path) !== hash) {
      throw new HttpError(412, 'This file changed on disk while you were editing it.');
    }

    writeFileAtomic(path, content);
    // The write can change this file's git status.
    this.invalidate(id);
    return this.file(id, relPath);
  }

  /** Adds or replaces the comment on one line, and returns the file's comments. */
  async setAnnotation(
    id: string,
    relPath: string,
    line: number,
    comment: string,
  ): Promise<ReviewAnnotation[]> {
    if (!Number.isInteger(line) || line < 1) {
      throw new HttpError(400, 'line must be a positive integer');
    }
    const text = comment.trim();
    if (text === '') throw new HttpError(400, 'comment is required');
    if (text.length > 20_000) throw new HttpError(400, 'comment is too long');

    const workspace = this.workspace(id);
    // The path must name a file the review lists, or the comment could never
    // be shown.
    const path = await this.resolveFile(await this.box(id), id, workspace, relPath);
    if (path === null) {
      throw new HttpError(409, 'This file was deleted, so there is no line to comment on.');
    }
    const source = fileLines(readTextFile(path).content);

    await this.mutate(id, workspace, relPath, (review) => {
      setAnnotation(review, relPath, line, text, source);
    });
    return this.drifted(id, workspace, relPath);
  }

  /** Removes the comment on one line, and returns what is left for the file. */
  async deleteAnnotation(id: string, relPath: string, line: number): Promise<ReviewAnnotation[]> {
    if (!Number.isInteger(line) || line < 1) {
      throw new HttpError(400, 'line must be a positive integer');
    }
    const workspace = this.workspace(id);
    await this.mutate(id, workspace, relPath, (review) => {
      deleteAnnotation(review, relPath, line);
    });
    return this.drifted(id, workspace, relPath);
  }

  /**
   * Runs the drift check over the whole review and returns one file's comments
   * as they then stand. Every comment write ends with this.
   */
  private async drifted(
    id: string,
    workspace: string,
    relPath: string,
  ): Promise<ReviewAnnotation[]> {
    const review = await this.driftAll(id, workspace);
    return toAnnotations(annotationsFor(review, relPath));
  }

  /**
   * Deletes REVIEW.md, which starts a new review. A missing file is not an
   * error.
   */
  async deleteReview(id: string): Promise<void> {
    const workspace = this.workspace(id);
    await this.withLock(id, () => {
      removeFile(this.reviewPath(workspace));
    });
  }

  /**
   * Records the revision the whole review is compared against, and reports
   * where it landed.
   *
   * The expression is resolved in each repository through the merge base with
   * that repository's own HEAD. A repository where it names nothing is compared
   * against its own HEAD. A 400 comes back only when it resolves nowhere. Null
   * clears the base.
   */
  async setBase(id: string, rev: string | null): Promise<ReviewBaseResponse> {
    // Checks the box first: a held snapshot would answer without checking it.
    this.workspace(id);
    const box = await this.box(id);
    const { map } = await this.snapshot(box, id, false);
    if (rev === null || rev.trim() === '') {
      this.db.prepare('UPDATE boxes SET review_base_rev = NULL WHERE id = ?').run(id);
      // Every status the snapshot holds was an answer about the old base.
      this.invalidate(id);
      return { rev: '', repos: await this.describeRepos(box, map, new Map()) };
    }
    const wanted = rev.trim();
    if (wanted.length > 200) throw new HttpError(400, 'rev is too long');
    if (!map.hasGit) throw new HttpError(409, 'This workspace holds no git repository');

    const bases = await resolveBases(box, map, wanted);
    if (bases.size === 0) {
      throw new HttpError(400, `unknown revision: ${wanted}`);
    }
    if (bases.size < map.repos.length) {
      log.box(id).info('review base resolved in some repositories only', {
        rev: wanted,
        resolved: bases.size,
        repositories: map.repos.length,
      });
    }

    this.db.prepare('UPDATE boxes SET review_base_rev = ? WHERE id = ?').run(wanted, id);
    this.invalidate(id);
    return { rev: wanted, repos: await this.describeRepos(box, map, bases) };
  }

  // --- the read-modify-write ------------------------------------------------

  /**
   * Applies one change to REVIEW.md and writes it back, under the box's lock.
   *
   * The agent can edit or delete REVIEW.md at any time. The file's hash is
   * compared before the read and before the write. When it moved, the change is
   * applied once more to the new content. A second move gives a 409.
   */
  private async mutate(
    id: string,
    workspace: string,
    relPath: string,
    apply: (review: Review) => void,
  ): Promise<ReviewAnnotation[]> {
    const path = this.reviewPath(workspace);
    return this.withLock(id, () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = fileHash(path);
        const review = this.read(path);
        const asRead = serializeReview(review);
        apply(review);
        // A change that changed nothing, such as deleting a missing comment,
        // writes no file.
        if (serializeReview(review) === asRead) {
          return toAnnotations(annotationsFor(review, relPath));
        }
        if (review.started === '') review.started = todayStamp();
        const serialized = serializeReview(review);

        if (fileHash(path) !== before) {
          log.box(id).info('REVIEW.md changed mid-write; re-applying');
          continue;
        }
        writeFileAtomic(path, serialized);
        return toAnnotations(annotationsFor(review, relPath));
      }
      throw new HttpError(
        409,
        'REVIEW.md is being written by something else; try again',
      );
    });
  }

  /** Reads and parses REVIEW.md, or an empty review when there is none. */
  private read(path: string): Review {
    const hash = fileHash(path);
    if (hash === '') return { data: new Map(), started: '' };
    const read = readTextFile(path, MAX_REVIEW_BYTES);
    if (read.binary) return { data: new Map(), started: '' };
    return parseReview(read.content);
  }

  /**
   * One file's comments as REVIEW.md holds them, without a drift check.
   *
   * For files the drift check cannot compare against: deleted, binary, or past
   * the display cap. The tree counts their comments, so the file view shows
   * them too.
   */
  private async annotationsOf(
    id: string,
    workspace: string,
    relPath: string,
  ): Promise<ReviewAnnotation[]> {
    const path = this.reviewPath(workspace);
    return this.withLock(id, () => toAnnotations(annotationsFor(this.read(path), relPath)));
  }

  /**
   * Runs drift on every annotated file and writes the result once if anything
   * moved. Returns the review as it now stands.
   */
  private async driftAll(id: string, workspace: string): Promise<Review> {
    const path = this.reviewPath(workspace);
    return this.withLock(id, () => {
      const before = fileHash(path);
      const review = this.read(path);
      if (review.data.size === 0) return review;

      let changed = false;
      for (const [file, annotations] of review.data) {
        const source = sourceLines(workspace, file);
        // Undefined is a binary or truncated file: skipped, not marked outdated.
        if (source === undefined) continue;
        if (checkDrift(annotations, source)) changed = true;
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
    workspace: string,
    relPath: string,
    source: string[],
  ): Promise<ReviewAnnotation[]> {
    const path = this.reviewPath(workspace);
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
   * Runs `fn` after every earlier holder of the box's lock has finished.
   *
   * The stored tail catches rejections, so one failure does not block the
   * next holder.
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

  // --- repositories and the base --------------------------------------------

  /**
   * The repositories as the API reports them: where each is, what its HEAD
   * names, and what the review's base resolved to in it.
   *
   * A revision can name a branch in one repository and nothing in another, so
   * each repository reports its own `baseCommit`.
   */
  private async describeRepos(
    box: GitBox,
    map: RepoMap,
    bases: Map<string, Base>,
  ): Promise<ReviewRepo[]> {
    return Promise.all(
      map.repos.map(async (repo) => ({
        path: repo.path,
        name: repo.name,
        head: await headCommit(gitTarget(box, repo.path)),
        baseCommit: bases.get(repo.path)?.commit ?? '',
      })),
    );
  }

  /**
   * What one repository is compared against, for a single-file request that
   * has no reason to resolve the base in any of the others.
   */
  private async baseIn(box: GitBox, id: string, repo: Repo): Promise<Base> {
    const rev = this.baseRev(id);
    if (rev === '') return NO_BASE;
    const resolved = await resolveBase(gitTarget(box, repo.path), rev);
    // An unknown revision falls back to HEAD here, as in `resolveBases`.
    return 'base' in resolved ? resolved.base : NO_BASE;
  }

  // --- paths ----------------------------------------------------------------

  /**
   * Resolves a client-supplied path to a file the review offers.
   *
   * {@link listedFile} applies the listing's rule, so the API serves only what
   * a directory listing offers. `resolveInRoot` keeps the path inside the
   * workspace. A directory is refused too. Every refusal is the same 404, so an
   * escape attempt learns no more than an unknown path would.
   *
   * Returns null for a file that is missing on disk and that git reports
   * deleted. The caller decides how to answer for it.
   */
  private async resolveFile(
    box: GitBox,
    id: string,
    workspace: string,
    relPath: string,
  ): Promise<string | null> {
    if (!listedFile(relPath)) throw new HttpError(404, 'File not found');

    const resolved = resolveInRoot(workspace, relPath);
    if (resolved.ok) {
      if (isDirectory(resolved.path)) throw new HttpError(404, 'File not found');
      return resolved.path;
    }
    if (resolved.reason !== 'missing') throw new HttpError(404, 'File not found');

    // Nothing on disk. Only git can tell a deleted file from a path that never
    // existed.
    const { statuses } = await this.snapshot(box, id, false);
    if (statuses[relPath] !== 'deleted') throw new HttpError(404, 'File not found');
    return null;
  }

  /**
   * The children of one directory of the workspace, or a 404.
   *
   * A directory missing on disk counts as empty when git reports deleted files
   * under it, and {@link dirEntries} adds those files. Any other missing
   * directory is a 404.
   */
  private children(
    workspace: string,
    relDir: string,
    statuses: FileStatuses,
  ): DirChild[] {
    if (relDir === '') return readDir(workspace, '');
    if (!listedDir(relDir)) throw new HttpError(404, 'Directory not found');

    const resolved = resolveInRoot(workspace, relDir);
    if (resolved.ok) {
      if (!isDirectory(resolved.path)) throw new HttpError(404, 'Directory not found');
      return readDir(workspace, relDir);
    }
    if (resolved.reason === 'missing' && holdsDeleted(statuses, relDir)) return [];
    throw new HttpError(404, 'Directory not found');
  }

  /** Drops the snapshot and the lock of a deleted box. */
  forget(id: string): void {
    this.snapshots.delete(id);
    this.locks.delete(id);
  }
}

/**
 * The answer for a file the change removed: it is in the tree because git
 * reports it deleted, and there is nothing on disk to read. Its comments come
 * with it, because the tree counts them and they are still there to be read
 * and deleted.
 */
function goneFile(
  relPath: string,
  repo: Repo | null,
  annotations: ReviewAnnotation[],
): ReviewFileResponse {
  return {
    path: relPath,
    repo: repo?.path ?? null,
    content: '',
    hash: '',
    truncated: false,
    binary: false,
    deleted: true,
    size: 0,
    lines: 0,
    language: detectLang(relPath),
    status: 'deleted',
    diff: emptyDiff(),
    annotations,
  };
}

/**
 * A file's current lines for a drift check.
 *
 * Null says the file is gone or unreadable, which marks every annotation on it
 * outdated. Undefined says the file is binary or longer than the display cap,
 * so the drift check skips it.
 */
function sourceLines(workspace: string, relPath: string): string[] | null | undefined {
  const resolved = resolveInRoot(workspace, relPath);
  if (!resolved.ok || isDirectory(resolved.path)) return null;
  try {
    const read = readTextFile(resolved.path);
    if (read.binary || read.truncated) return undefined;
    return fileLines(read.content);
  } catch {
    return null;
  }
}

/** One file's annotations, as the API reports them: a list, in line order. */
function toAnnotations(annotations: Map<number, { comment: string; outdated: boolean }>): ReviewAnnotation[] {
  return [...annotations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, ann]) => ({ line, comment: ann.comment, outdated: ann.outdated }));
}
