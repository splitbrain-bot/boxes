import type {
  ReviewAnnotation,
  ReviewBaseResponse,
  ReviewDirResponse,
  ReviewFileResponse,
  ReviewRepo,
} from '../../../shared/types.ts';
import type { Db, BoxRow } from '../db.ts';
import {
  fileService,
  FileServiceError,
  isMissing,
  isRefusedPath,
  type FileService,
  type FileStream,
  type WriteCondition,
} from '../files.ts';
import { HttpError } from '../http-error.ts';
import { log } from '../log.ts';
import { emptyDiff, fileDiff } from './difflines.ts';
import { fileLines, MAX_FILE_BYTES, MAX_REVIEW_BYTES } from './fs.ts';
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
  reviewChildren,
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
  /**
   * The box, started if it was stopped, and the directory a command runs in
   * inside it.
   *
   * Asking for it marks the box active, so a review that keeps asking
   * keeps the box it is asking about.
   */
  execTarget(id: string): Promise<{ boxId: string; workingDir: string }>;
}

/** A running box as the review reaches it: git and the file service. */
interface ReviewBox extends GitBox {
  /** The file service in the box. */
  files: FileService;
}

/** REVIEW.md as it was read, and the hash a write of it expects back. */
interface ReviewRead {
  /** The parsed review. Empty when there is no REVIEW.md. */
  review: Review;
  /** The hash of REVIEW.md, or '' when there is none. */
  hash: string;
}

/** One directory of the workspace as the review lists it. */
interface DirListing {
  /** The children the review shows. */
  children: DirChild[];
  /** True when the file service left children out. */
  truncated: boolean;
}

/**
 * Review operations over the boxes of one orchestrator.
 *
 * The review of a box is its whole workspace. REVIEW.md at the workspace root
 * is the only store of annotations, and the agent can edit it too. Files are
 * read and written by the file service in the box, and git runs in the box,
 * so every request starts a stopped box and marks it active.
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
   * The box's container to run git and the file service in, started if it
   * was stopped. An unknown or deleted box is a 404.
   *
   * Each request asks for it again, because a container can stop or be
   * replaced between two requests.
   */
  private async box(id: string): Promise<ReviewBox> {
    this.row(id);
    const target = await this.boxes.execTarget(id);
    return {
      boxId: target.boxId,
      workspaceDir: target.workingDir,
      files: fileService(target.boxId),
    };
  }

  /**
   * What a review knows from git: which repositories the workspace holds, what
   * each is compared against, and the status of every changed file in it.
   *
   * The snapshot is reused, because each git call is an exec into the
   * box. A new one is taken when `fresh` says the browser has just arrived,
   * after a save or a base change, and when {@link SNAPSHOT_MS} has passed.
   */
  private async snapshot(box: ReviewBox, id: string, fresh: boolean): Promise<GitSnapshot> {
    const held = this.snapshots.get(id);
    if (!fresh && held && Date.now() - held.at < ReviewService.SNAPSHOT_MS) return held;

    const map = await discoverRepos(box.files, box);
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
    const box = await this.box(id);
    const taken = await this.snapshot(box, id, fresh);

    const { review, hash } = fresh
      ? await this.driftAll(id, box.files)
      : await this.withLock(id, () => this.read(box.files));
    const counts = annotationCounts(review);

    const listing = await this.children(box.files, relDir, taken.statuses);
    const listed = dirEntries(relDir, listing.children, taken.statuses, counts, taken.map);
    const truncated = listing.truncated || listed.length > MAX_DIR_ENTRIES;

    return {
      path: relDir,
      entries: truncated ? listed.slice(0, MAX_DIR_ENTRIES) : listed,
      truncated,
      repos: taken.repos,
      hasGit: taken.map.hasGit,
      base: { rev: this.baseRev(id) },
      hasReview: hash !== '',
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
    const box = await this.box(id);
    const { map } = await this.snapshot(box, id, false);
    const repo = map.repoFor(relPath);
    if (!(await this.resolveFile(box, id, relPath))) {
      return goneFile(relPath, repo, await this.annotationsOf(id, box.files, relPath));
    }
    const read = await box.files.read(relPath, MAX_FILE_BYTES);
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
        ? await this.annotationsOf(id, box.files, relPath)
        : await this.driftFile(id, box.files, relPath, fileLines(read.content));

    return {
      path: relPath,
      repo: repo?.path ?? null,
      content: read.content,
      hash: read.hash,
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
   * The bytes of a file the review offers, as a stream.
   *
   * It applies `listedFile` as {@link resolveFile} does, without asking git.
   * A deleted file has no bytes to serve, so it gets the same 404 as any path
   * the review does not offer.
   */
  async rawFile(id: string, relPath: string): Promise<FileStream> {
    if (!listedFile(relPath)) throw new HttpError(404, 'File not found');
    const box = await this.box(id);
    try {
      return await box.files.readStream(relPath);
    } catch (err) {
      if (isRefusedPath(err)) throw new HttpError(404, 'File not found');
      throw err;
    }
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

    const box = await this.box(id);
    if (!(await this.resolveFile(box, id, relPath))) {
      throw new HttpError(409, 'This file was deleted, so there is nothing to save.');
    }

    const read = await box.files.read(relPath, MAX_FILE_BYTES);
    if (read.binary) throw new HttpError(409, 'This file is binary, so it cannot be edited.');
    if (read.truncated) {
      throw new HttpError(
        409,
        'This file is larger than the display limit, so it cannot be saved.',
      );
    }
    // 412 rather than 409, because the reviewer can overrule this refusal and
    // save anyway. The file service checks the hash once more as it writes.
    const changed = new HttpError(412, 'This file changed on disk while you were editing it.');
    if (read.hash !== hash) throw changed;
    try {
      await box.files.write(relPath, content, { hash });
    } catch (err) {
      if (failedCondition(err)) throw changed;
      throw err;
    }
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

    const box = await this.box(id);
    // The path must name a file the review lists, or the comment could never
    // be shown.
    if (!(await this.resolveFile(box, id, relPath))) {
      throw new HttpError(409, 'This file was deleted, so there is no line to comment on.');
    }
    const source = fileLines((await box.files.read(relPath, MAX_FILE_BYTES)).content);

    await this.mutate(id, box.files, relPath, (review) => {
      setAnnotation(review, relPath, line, text, source);
    });
    return this.drifted(id, box.files, relPath);
  }

  /** Removes the comment on one line, and returns what is left for the file. */
  async deleteAnnotation(id: string, relPath: string, line: number): Promise<ReviewAnnotation[]> {
    if (!Number.isInteger(line) || line < 1) {
      throw new HttpError(400, 'line must be a positive integer');
    }
    const { files } = await this.box(id);
    await this.mutate(id, files, relPath, (review) => {
      deleteAnnotation(review, relPath, line);
    });
    return this.drifted(id, files, relPath);
  }

  /**
   * Runs the drift check over the whole review and returns one file's comments
   * as they then stand. Every comment write ends with this.
   */
  private async drifted(
    id: string,
    files: FileService,
    relPath: string,
  ): Promise<ReviewAnnotation[]> {
    const { review } = await this.driftAll(id, files);
    return toAnnotations(annotationsFor(review, relPath));
  }

  /**
   * Deletes REVIEW.md, which starts a new review. A missing file is not an
   * error.
   */
  async deleteReview(id: string): Promise<void> {
    const { files } = await this.box(id);
    await this.withLock(id, async () => {
      try {
        await files.remove(REVIEW_FILE);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
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
   * The agent can edit or delete REVIEW.md at any time. The write expects the
   * hash that was read, and the file service refuses it when the file moved.
   * The change is then applied once more to the new content. A second move
   * gives a 409.
   */
  private async mutate(
    id: string,
    files: FileService,
    relPath: string,
    apply: (review: Review) => void,
  ): Promise<ReviewAnnotation[]> {
    return this.withLock(id, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { review, hash } = await this.read(files);
        const asRead = serializeReview(review);
        apply(review);
        // A change that changed nothing, such as deleting a missing comment,
        // writes no file.
        if (serializeReview(review) === asRead) {
          return toAnnotations(annotationsFor(review, relPath));
        }
        if (review.started === '') review.started = todayStamp();

        try {
          await files.write(REVIEW_FILE, serializeReview(review), expecting(hash));
        } catch (err) {
          if (!failedCondition(err)) throw err;
          log.box(id).info('REVIEW.md changed mid-write; re-applying');
          continue;
        }
        return toAnnotations(annotationsFor(review, relPath));
      }
      throw new HttpError(
        409,
        'REVIEW.md is being written by something else; try again',
      );
    });
  }

  /** Reads and parses REVIEW.md, or an empty review when there is none. */
  private async read(files: FileService): Promise<ReviewRead> {
    const empty = (): Review => ({ data: new Map(), started: '' });
    let read;
    try {
      read = await files.read(REVIEW_FILE, MAX_REVIEW_BYTES);
    } catch (err) {
      if (isMissing(err)) return { review: empty(), hash: '' };
      throw err;
    }
    return { review: read.binary ? empty() : parseReview(read.content), hash: read.hash };
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
    files: FileService,
    relPath: string,
  ): Promise<ReviewAnnotation[]> {
    return this.withLock(id, async () =>
      toAnnotations(annotationsFor((await this.read(files)).review, relPath)),
    );
  }

  /**
   * Runs drift on every annotated file and writes the result once if anything
   * moved. Returns the review as it now stands.
   *
   * When the agent changed REVIEW.md in the meantime, the result is not
   * written. The next drift check runs on the agent's version.
   */
  private async driftAll(id: string, files: FileService): Promise<ReviewRead> {
    return this.withLock(id, async () => {
      const read = await this.read(files);
      if (read.review.data.size === 0) return read;

      let changed = false;
      for (const [file, annotations] of read.review.data) {
        const source = await sourceLines(files, file);
        // Undefined is a binary or truncated file: skipped, not marked outdated.
        if (source === undefined) continue;
        if (checkDrift(annotations, source)) changed = true;
      }
      if (changed) await this.writeDrifted(files, read);
      return read;
    });
  }

  /** Runs drift on one file and returns its comments as they now stand. */
  private async driftFile(
    id: string,
    files: FileService,
    relPath: string,
    source: string[],
  ): Promise<ReviewAnnotation[]> {
    return this.withLock(id, async () => {
      const read = await this.read(files);
      const annotations = read.review.data.get(relPath);
      if (!annotations) return [];
      if (checkDrift(annotations, source)) await this.writeDrifted(files, read);
      return toAnnotations(annotationsFor(read.review, relPath));
    });
  }

  /**
   * Writes the result of a drift check, unless REVIEW.md changed since it was
   * read.
   */
  private async writeDrifted(files: FileService, read: ReviewRead): Promise<void> {
    try {
      await files.write(REVIEW_FILE, serializeReview(read.review), expecting(read.hash));
    } catch (err) {
      if (!failedCondition(err)) throw err;
    }
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
   * Checks a client-supplied path to a file the review offers.
   *
   * {@link listedFile} applies the listing's rule, so the API serves only what
   * a directory listing offers. The file service keeps the path inside the
   * workspace. A directory is refused too. Every refusal is the same 404, so an
   * escape attempt learns no more than an unknown path would.
   *
   * Returns false for a file that is missing on disk and that git reports
   * deleted. The caller decides how to answer for it.
   */
  private async resolveFile(box: ReviewBox, id: string, relPath: string): Promise<boolean> {
    if (!listedFile(relPath)) throw new HttpError(404, 'File not found');

    try {
      if ((await box.files.stat(relPath)).type !== 'file') {
        throw new HttpError(404, 'File not found');
      }
      return true;
    } catch (err) {
      if (!isRefusedPath(err)) throw err;
      if (!isMissing(err)) throw new HttpError(404, 'File not found');
    }

    // Nothing on disk. Only git can tell a deleted file from a path that never
    // existed.
    const { statuses } = await this.snapshot(box, id, false);
    if (statuses[relPath] !== 'deleted') throw new HttpError(404, 'File not found');
    return false;
  }

  /**
   * The children of one directory of the workspace, or a 404.
   *
   * A directory missing on disk counts as empty when git reports deleted files
   * under it, and {@link dirEntries} adds those files. Any other missing
   * directory is a 404.
   */
  private async children(
    files: FileService,
    relDir: string,
    statuses: FileStatuses,
  ): Promise<DirListing> {
    if (relDir !== '' && !listedDir(relDir)) throw new HttpError(404, 'Directory not found');

    try {
      const listed = await files.list(relDir);
      return { children: reviewChildren(relDir, listed.entries), truncated: listed.truncated };
    } catch (err) {
      if (!(err instanceof FileServiceError)) throw err;
      if (isMissing(err) && relDir !== '' && holdsDeleted(statuses, relDir)) {
        return { children: [], truncated: false };
      }
      throw new HttpError(404, 'Directory not found');
    }
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
 * Null says the file is gone or cannot be read, which marks every annotation
 * on it outdated. Undefined says the file is binary or longer than the display
 * cap, so the drift check skips it. A connection that fails throws, so it
 * marks nothing outdated.
 */
async function sourceLines(files: FileService, relPath: string): Promise<string[] | null | undefined> {
  try {
    const read = await files.read(relPath, MAX_FILE_BYTES);
    if (read.binary || read.truncated) return undefined;
    return fileLines(read.content);
  } catch (err) {
    if (err instanceof FileServiceError) return null;
    throw err;
  }
}

/** The condition a write of a file read with this hash expects: '' is no file. */
function expecting(hash: string): WriteCondition {
  return hash === '' ? { absent: true } : { hash };
}

/** Whether an error is the file service refusing a write whose condition failed. */
function failedCondition(err: unknown): boolean {
  return err instanceof FileServiceError && err.status === 412;
}

/** One file's annotations, as the API reports them: a list, in line order. */
function toAnnotations(annotations: Map<number, { comment: string; outdated: boolean }>): ReviewAnnotation[] {
  return [...annotations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, ann]) => ({ line, comment: ann.comment, outdated: ann.outdated }));
}
