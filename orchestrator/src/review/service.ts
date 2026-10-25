import type {
  ReviewAnnotation,
  ReviewBaseResponse,
  ReviewDirResponse,
  ReviewFileResponse,
  ReviewRepo,
} from '../../../shared/types.ts';
import type { BoxRow, Db } from '../db.ts';
import {
  type FileRead,
  type FileService,
  FileServiceError,
  type FileStream,
  fileService,
  isMissing,
  isRefusedPath,
  type WriteCondition,
} from '../files.ts';
import { HttpError } from '../http-error.ts';
import { log } from '../log.ts';
import { emptyDiff, fileDiff } from './difflines.ts';
import { fileLines, MAX_FILE_BYTES, MAX_REVIEW_BYTES } from './fs.ts';
import { type GitBox, headCommit } from './git.ts';
import {
  type Base,
  type FileStatuses,
  NO_BASE,
  resolveBases,
  workspaceStatuses,
} from './gitstatus.ts';
import { discoverRepos, gitTarget, inRepo, type Repo, type RepoMap } from './repos.ts';
import {
  annotationCounts,
  annotationsFor,
  checkDrift,
  deleteAnnotation,
  detectLang,
  parseReview,
  type Review,
  serializeReview,
  setAnnotation,
  todayStamp,
} from './store.ts';
import {
  type DirChild,
  dirEntries,
  holdsDeleted,
  listedDir,
  listedFile,
  MAX_DIR_ENTRIES,
  REVIEW_FILE,
  reviewChildren,
} from './tree.ts';

/** The git state of the whole workspace for one review, as the last snapshot found it. */
interface GitSnapshot {
  /** The time the snapshot was taken, in milliseconds since the epoch. */
  at: number;
  /** The repositories in the workspace, with the lookup for the repository of a path. */
  map: RepoMap;
  /** The same repositories as the API reports them. */
  repos: ReviewRepo[];
  /** The git status of every changed file in the workspace, by path. */
  statuses: FileStatuses;
  /** The base of each repository, by repository path. A repository without an entry compares against HEAD. */
  bases: Map<string, Base>;
}

/** The access to the boxes that the review needs. */
export interface ReviewBoxes {
  /**
   * Starts the box when it is stopped, and gives the place for a command in the box.
   *
   * The call marks the box active, so the reaper does not stop a box while a
   * review reads it.
   *
   * @param id The box id.
   * @returns The box id and the directory in the box that a command runs in.
   */
  execTarget(id: string): Promise<{ boxId: string; workingDir: string }>;
}

/** A running box, with the workspace for git and the file service in the box. */
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
 * The service for the code review of each box.
 *
 * The review of a box covers its whole workspace. REVIEW.md at the workspace
 * root is the only store of annotations, and the agent can edit it too.
 */
export class ReviewService {
  /**
   * The tail of the promise chain of each box, by box id. The chain runs the reads and writes of one
   * REVIEW.md one after the other.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  /** The last git snapshot of each review, by box id. */
  private readonly snapshots = new Map<string, GitSnapshot>();

  /**
   * The snapshot that is being taken for each review, by box id. Only this snapshot replaces the held one when it
   * is complete.
   */
  private readonly taking = new Map<string, Promise<GitSnapshot>>();

  /**
   * Creates the service.
   *
   * @param db The database that holds the box rows.
   * @param boxes The access to the boxes that the reviews read.
   */
  constructor(
    /** The database that holds the box rows. */
    private readonly db: Db,
    /** The access to the boxes that the reviews read. */
    private readonly boxes: ReviewBoxes,
  ) {}

  /**
   * The time in milliseconds after which a request starts a new git snapshot in the background.
   *
   * Many folder and file opens in this time run git for the snapshot once.
   */
  private static readonly SNAPSHOT_MS = 60_000;

  /**
   * Reads the row of a box.
   *
   * @param id The box id.
   * @returns The box row.
   * @throws {HttpError} 404 for an unknown or deleted box.
   */
  private row(id: string): BoxRow {
    const row = this.db.prepare('SELECT * FROM boxes WHERE id = ?').get(id) as BoxRow | undefined;
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Box not found');
    return row;
  }

  /**
   * Starts the box when it is stopped, and gives the place where git and the file service run.
   *
   * Each request calls this method again, because a container can stop or be
   * replaced between two requests.
   *
   * @param id The box id.
   * @returns The box with its workspace and its file service.
   * @throws {HttpError} 404 for an unknown or deleted box.
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
   * Gives the git snapshot of a review.
   *
   * The method reuses the held snapshot, because each git call is an exec into the
   * box. It takes a new snapshot and waits for it when `fresh` is true or when no
   * snapshot is held. When {@link ReviewService.SNAPSHOT_MS} has passed, it returns
   * the held snapshot and takes a new one in the background, so the request does
   * not wait for git.
   *
   * @param box The box to run git in.
   * @param id The box id.
   * @param fresh True to take a new snapshot and wait for it in all cases.
   * @returns The snapshot.
   */
  private async snapshot(box: ReviewBox, id: string, fresh: boolean): Promise<GitSnapshot> {
    if (fresh) return this.take(box, id);

    const held = this.snapshots.get(id);
    if (!held) return this.taking.get(id) ?? this.take(box, id);

    if (Date.now() - held.at >= ReviewService.SNAPSHOT_MS && !this.taking.has(id)) {
      this.take(box, id).catch((err: unknown) => {
        log.box(id).warn('could not refresh the git snapshot', { error: (err as Error).message });
      });
    }
    return held;
  }

  /**
   * Takes a new git snapshot of a review.
   *
   * A later take or an {@link ReviewService.invalidate} replaces this take. The
   * snapshot of a replaced take is returned to its caller, but it is not held.
   *
   * @param box The box to run git in.
   * @param id The box id.
   * @returns The snapshot.
   */
  private async take(box: ReviewBox, id: string): Promise<GitSnapshot> {
    const taking = (async (): Promise<GitSnapshot> => {
      const map = await discoverRepos(box.files, box);
      const bases = await resolveBases(box, map, this.baseRev(id));
      const [repos, statuses] = await Promise.all([
        this.describeRepos(box, map, bases),
        workspaceStatuses(box, map, bases),
      ]);
      return { at: Date.now(), map, repos, statuses, bases };
    })();
    this.taking.set(id, taking);
    try {
      const taken = await taking;
      if (this.taking.get(id) === taking) this.snapshots.set(id, taken);
      return taken;
    } finally {
      if (this.taking.get(id) === taking) this.taking.delete(id);
    }
  }

  /**
   * Drops the git snapshot of a box, after a change that can change the git status.
   *
   * @param id The box id.
   */
  private invalidate(id: string): void {
    this.snapshots.delete(id);
    this.taking.delete(id);
  }

  /**
   * Reads the revision expression that the review of a box compares against.
   *
   * One expression serves the whole workspace. Each repository resolves it to its own commit.
   *
   * @param id The box id.
   * @returns The revision expression, or '' when none is set. With '', each repository is compared against
   *   its own HEAD.
   */
  private baseRev(id: string): string {
    return this.row(id).review_base_rev ?? '';
  }

  /**
   * Gives one directory of the review with its children, and the facts that the whole view
   * needs.
   *
   * Listing and status come in one answer, because a file that the change deleted
   * has no directory entry and only the status map names it.
   *
   * @param id The box id.
   * @param relDir The workspace-relative path of the directory, or '' for the root.
   * @param fresh True to take a new git snapshot and run the drift check over every annotated file. The
   *   browser sets it when it shows the tree again, for example when the view mounts, a file closes back to
   *   the tree, or the tab becomes visible.
   * @returns The directory response.
   * @throws {HttpError} 404 for an unknown box, or for a directory that the review does not list or that is
   *   missing.
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
   * Gives one file with its content, diff markers and comments, in one response.
   *
   * The diff comes from the repository that owns the path, with the path
   * relative to that repository. The status and the base come from the git
   * snapshot, so the status is the one that the tree shows. A file outside every
   * repository has no diff and no status. The content is plain text, and the
   * browser adds the highlighting.
   *
   * @param id The box id.
   * @param relPath The workspace-relative path of the file.
   * @returns The file response. For a file that git reports deleted, the response has no content.
   * @throws {HttpError} 404 for an unknown box or a path that the review does not offer.
   */
  async file(id: string, relPath: string): Promise<ReviewFileResponse> {
    const box = await this.box(id);
    const { map, statuses, bases } = await this.snapshot(box, id, false);
    const repo = map.repoFor(relPath);
    if (!(await this.resolveFile(box, id, relPath))) {
      return goneFile(relPath, repo, await this.annotationsOf(id, box.files, relPath));
    }
    const read = await box.files.read(relPath, MAX_FILE_BYTES);

    // Git runs only in the owning repository, so opening a file costs the same
    // for any number of repositories in the workspace.
    const diff =
      repo && !read.binary
        ? await fileDiff(
            gitTarget(box, repo.path),
            bases.get(repo.path) ?? NO_BASE,
            inRepo(repo, relPath),
            read.content,
          )
        : null;

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
      status: statuses[relPath] ?? null,
      diff: {
        lines: Object.fromEntries(Object.entries(diff?.lines ?? {})),
        hunks: diff?.hunks ?? [],
        deletions: diff?.deletions ?? [],
      },
      annotations,
    };
  }

  /**
   * Gives the bytes of a file that the review offers, as a stream.
   *
   * The method applies {@link listedFile} as {@link ReviewService.resolveFile} does, but it does not run git.
   * A deleted file has no bytes to serve, so it gets the same 404 as any path
   * that the review does not offer.
   *
   * @param id The box id.
   * @param relPath The workspace-relative path of the file.
   * @returns The content of the file as a stream, with its size.
   * @throws {HttpError} 404 for an unknown box or a path that the review does not offer.
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

  /**
   * Replaces one file of the workspace with the content that the reviewer edited, and
   * returns the file view after the write.
   *
   * When the file does not match `hash`, something else changed it. The method then refuses the save, so
   * that change is kept. The method also refuses a truncated file, because the browser
   * holds only the part up to the cap. The response comes from {@link ReviewService.file},
   * whose drift check moves the comments with the edit.
   *
   * @param id The box id.
   * @param relPath The workspace-relative path of the file.
   * @param content The new content.
   * @param hash The hash of the file that the browser read last.
   * @returns The file response after the write.
   * @throws {HttpError} 400 for content larger than {@link MAX_FILE_BYTES}, 404 for a path that the review does
   *   not offer, 409 for a deleted, binary or truncated file, and 412 when the file does not match `hash`.
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
    // 412 and not 409, because the reviewer can overrule this refusal and
    // save anyway. The file service checks the hash again as it writes.
    const changed = new HttpError(412, 'This file changed on disk while you were editing it.');
    if (read.hash !== hash) throw changed;
    try {
      await box.files.write(relPath, content, { hash });
    } catch (err) {
      if (failedCondition(err)) throw changed;
      throw err;
    }
    // The write can change the git status of this file.
    this.invalidate(id);
    return this.file(id, relPath);
  }

  /**
   * Adds or replaces the comment on one line.
   *
   * @param id The box id.
   * @param relPath The workspace-relative path of the file.
   * @param line The line number, starting at 1.
   * @param comment The comment. The method trims it.
   * @returns The comments of the file after the drift check.
   * @throws {HttpError} 400 for a line that is not a positive integer or a comment that is empty or longer
   *   than 20000 characters, 404 for a path that the review does not offer, 409 for a deleted file or when
   *   REVIEW.md changes during both write attempts.
   */
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
    // The path must name a file that the review lists, or the review cannot show
    // the comment.
    if (!(await this.resolveFile(box, id, relPath))) {
      throw new HttpError(409, 'This file was deleted, so there is no line to comment on.');
    }
    const source = fileLines((await box.files.read(relPath, MAX_FILE_BYTES)).content);

    await this.mutate(id, box.files, relPath, (review) => {
      setAnnotation(review, relPath, line, text, source);
    });
    return this.drifted(id, box.files, relPath);
  }

  /**
   * Removes the comment on one line.
   *
   * @param id The box id.
   * @param relPath The workspace-relative path of the file.
   * @param line The line number, starting at 1.
   * @returns The comments of the file that are left, after the drift check.
   * @throws {HttpError} 400 for a line that is not a positive integer, 404 for an unknown box, 409 when
   *   REVIEW.md changes during both write attempts.
   */
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
   * Runs the drift check over the whole review. The comment writes call it after the write.
   *
   * @param id The box id.
   * @param files The file service in the box.
   * @param relPath The workspace-relative path of the file.
   * @returns The comments of the file after the drift check.
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
   *
   * @param id The box id.
   * @throws {HttpError} 404 for an unknown or deleted box.
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
   * Records the revision that the whole review compares against, and returns the
   * base commit of each repository.
   *
   * The expression resolves in each repository through the merge base with the
   * HEAD of that repository. A repository where it names nothing is compared
   * against its own HEAD.
   *
   * @param id The box id.
   * @param rev The revision expression. Null or a blank string clears the base.
   * @returns The stored expression and the repositories with their base commits.
   * @throws {HttpError} 400 for an expression that is too long or that resolves in no repository, 404 for an
   *   unknown box, 409 when the workspace holds no git repository.
   */
  async setBase(id: string, rev: string | null): Promise<ReviewBaseResponse> {
    // The box check comes first, because a held snapshot skips the box check.
    const box = await this.box(id);
    const { map } = await this.snapshot(box, id, false);
    if (rev === null || rev.trim() === '') {
      this.db.prepare('UPDATE boxes SET review_base_rev = NULL WHERE id = ?').run(id);
      // The statuses in the snapshot compare against the old base.
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

  /**
   * Applies one change to REVIEW.md and writes it back, under the lock of the box.
   *
   * The agent can edit or delete REVIEW.md at any time. The write expects the
   * hash that was read, and the file service refuses it when the file changed.
   * The method then applies the change again to the new content.
   *
   * @param id The box id.
   * @param files The file service in the box.
   * @param relPath The workspace-relative path of the file whose comments the method returns.
   * @param apply The change. It changes the review in place.
   * @returns The comments of the file after the change.
   * @throws {HttpError} 409 when REVIEW.md changes during both write attempts.
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
      throw new HttpError(409, 'REVIEW.md is being written by something else; try again');
    });
  }

  /**
   * Reads and parses REVIEW.md.
   *
   * @param files The file service in the box.
   * @returns The review and its hash. A missing REVIEW.md gives an empty review and the hash ''. A binary
   *   REVIEW.md gives an empty review.
   */
  private async read(files: FileService): Promise<ReviewRead> {
    const empty = (): Review => ({ data: new Map(), started: '' });
    let read: FileRead;
    try {
      read = await files.read(REVIEW_FILE, MAX_REVIEW_BYTES);
    } catch (err) {
      if (isMissing(err)) return { review: empty(), hash: '' };
      throw err;
    }
    return { review: read.binary ? empty() : parseReview(read.content), hash: read.hash };
  }

  /**
   * Gives the comments of one file as REVIEW.md holds them, without a drift check.
   *
   * The method is for files that the drift check cannot compare, which are
   * deleted, binary, or larger than the display cap. The tree counts their
   * comments, so the file view shows them too.
   *
   * @param id The box id.
   * @param files The file service in the box.
   * @param relPath The workspace-relative path of the file.
   * @returns The comments of the file.
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
   * Runs the drift check on every annotated file and writes the result once
   * when an annotation changed.
   *
   * When the agent changed REVIEW.md in the meantime, the method does not
   * write the result. The next drift check runs on the version of the agent.
   *
   * @param id The box id.
   * @param files The file service in the box.
   * @returns The review after the drift check, with the hash that was read.
   */
  private async driftAll(id: string, files: FileService): Promise<ReviewRead> {
    return this.withLock(id, async () => {
      const read = await this.read(files);
      if (read.review.data.size === 0) return read;

      let changed = false;
      for (const [file, annotations] of read.review.data) {
        const source = await sourceLines(files, file);
        // Undefined is a binary or truncated file. The drift check skips it and does not mark it outdated.
        if (source === undefined) continue;
        if (checkDrift(annotations, source)) changed = true;
      }
      if (changed) await this.writeDrifted(files, read);
      return read;
    });
  }

  /**
   * Runs the drift check on one file.
   *
   * @param id The box id.
   * @param files The file service in the box.
   * @param relPath The workspace-relative path of the file.
   * @param source The current lines of the file.
   * @returns The comments of the file after the drift check.
   */
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
   *
   * @param files The file service in the box.
   * @param read The review after the drift check, with the hash that was read.
   */
  private async writeDrifted(files: FileService, read: ReviewRead): Promise<void> {
    try {
      await files.write(REVIEW_FILE, serializeReview(read.review), expecting(read.hash));
    } catch (err) {
      if (!failedCondition(err)) throw err;
    }
  }

  /**
   * Runs `fn` after every earlier holder of the lock of the box has finished.
   *
   * The stored tail catches rejections, so one failure does not block the
   * next holder.
   *
   * @param id The box id.
   * @param fn The function to run.
   * @returns The result of `fn`.
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
   * Gives the repositories as the API reports them.
   *
   * A revision can name a branch in one repository and nothing in another, so
   * each repository reports its own `baseCommit`.
   *
   * @param box The box to run git in.
   * @param map The repositories of the workspace.
   * @param bases The base of each repository, by repository path.
   * @returns The repositories with their HEAD and base commits.
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
   * Checks that a path from the client names a file that the review offers.
   *
   * {@link listedFile} applies the rule of the listing, so the API serves only
   * what a directory listing offers. The file service keeps the path inside the
   * workspace. The method also refuses a directory. Every refusal is the same 404, so an
   * escape attempt learns no more than an unknown path.
   *
   * @param box The box with its file service.
   * @param id The box id.
   * @param relPath The workspace-relative path from the client.
   * @returns True for a file on disk. False for a file that is missing on disk and that git reports
   *   deleted. The caller decides how to answer for it.
   * @throws {HttpError} 404 for every other path.
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
   * Lists the children of one directory of the workspace.
   *
   * A directory missing on disk counts as empty when git reports deleted files
   * under it, and {@link dirEntries} adds those files.
   *
   * @param files The file service in the box.
   * @param relDir The workspace-relative path of the directory, or '' for the root.
   * @param statuses The git statuses of the workspace.
   * @returns The children that the review lists.
   * @throws {HttpError} 404 for a directory that the review does not list, and for every other error of the
   *   file service.
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

  /**
   * Drops the snapshot, a snapshot that is being taken and the lock of a deleted box.
   *
   * @param id The box id.
   */
  forget(id: string): void {
    this.snapshots.delete(id);
    this.taking.delete(id);
    this.locks.delete(id);
  }
}

/**
 * Builds the response for a file that the change removed. The file is in the tree
 * because git reports it deleted, but it is not on disk. The response holds its
 * comments, because the tree counts them and the reviewer can still read and
 * delete them.
 *
 * @param relPath The workspace-relative path of the file.
 * @param repo The repository that owns the path, or null.
 * @param annotations The comments of the file.
 * @returns The file response without content.
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
 * Reads the current lines of a file for a drift check.
 *
 * A connection that fails throws, so it marks nothing outdated.
 *
 * @param files The file service in the box.
 * @param relPath The workspace-relative path of the file.
 * @returns The lines. Null when the file service answers with an error, for example for a missing file, which
 *   marks every annotation on it outdated. Undefined for a binary file or a file larger than the display
 *   cap, which the drift check skips.
 */
async function sourceLines(
  files: FileService,
  relPath: string,
): Promise<string[] | null | undefined> {
  try {
    const read = await files.read(relPath, MAX_FILE_BYTES);
    if (read.binary || read.truncated) return undefined;
    return fileLines(read.content);
  } catch (err) {
    if (err instanceof FileServiceError) return null;
    throw err;
  }
}

/**
 * Gives the condition for a write of a file that was read with a hash.
 *
 * @param hash The hash from the read, or '' when there was no file.
 * @returns The condition that the file still has the hash, or that it is still absent.
 */
function expecting(hash: string): WriteCondition {
  return hash === '' ? { absent: true } : { hash };
}

/**
 * Checks if the file service refused a write because its condition failed.
 *
 * @param err The error of the write.
 * @returns True for a 412 from the file service.
 */
function failedCondition(err: unknown): boolean {
  return err instanceof FileServiceError && err.status === 412;
}

/**
 * Converts the annotations of one file into the list that the API reports.
 *
 * @param annotations The annotations by line number.
 * @returns The annotations in line order.
 */
function toAnnotations(
  annotations: Map<number, { comment: string; outdated: boolean }>,
): ReviewAnnotation[] {
  return [...annotations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, ann]) => ({ line, comment: ann.comment, outdated: ann.outdated }));
}
