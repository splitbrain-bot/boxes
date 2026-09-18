import { join } from 'node:path';
import type {
  ReviewAnnotation,
  ReviewBaseResponse,
  ReviewFileResponse,
  ReviewFileStatus,
  ReviewRepo,
  ReviewTreeResponse,
} from '../../../shared/types.ts';
import type { Db, SessionRow } from '../db.ts';
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
  markRepoRoots,
  REVIEW_FILE,
  reviewTree,
  treePaths,
  withDeleted,
  type TreeEntry,
} from './tree.ts';

/**
 * The per-session review façade: the repo map, the REVIEW.md
 * read-modify-write, and the routing of git questions to the repository that
 * can answer them.
 *
 * The workspace is the review. The root is always the session's
 * `/workspace`, there is nothing to pick and nothing to switch between, and
 * every file under it is browsable in one tree. A repository decides which
 * status and which diff one path is shown with: the closest enclosing one, by
 * longest prefix.
 *
 * REVIEW.md is the single source of truth and it is shared with the agent, so
 * there is no annotation table anywhere. Every mutation is
 * read → parse → apply → serialize → write-tmp-then-rename, under a per-session
 * lock, with the file's hash checked between the read and the write. If the
 * hash moved — the agent edited REVIEW.md mid-mutation — the whole thing is
 * re-read and re-applied once. A lost race costs one visible refresh rather
 * than data, because every write re-serializes the whole parsed file.
 *
 * It sits at `/workspace/REVIEW.md`, outside every repository, so it cannot be
 * committed by accident or show up in a repository's own status.
 *
 * Files are read and written here, on the workspace directory. Git is not: it
 * runs in the session's own container, over a repository whose configuration
 * the agent writes. So a question with git in it starts the box if it was
 * stopped, and the box stays counted as in use while the review is open.
 */

/** What the review needs of the sessions it is a view onto. */
export interface ReviewSessions {
  /** Where a session's files are, or null while it is still volume-backed. */
  workspacePath(id: string): string | null;
  /**
   * The session's container, started if it was stopped, and the directory a
   * command runs in inside it.
   *
   * Asking for it marks the session active, so a review that keeps asking
   * keeps the box it is asking about.
   */
  execTarget(id: string): Promise<{ containerId: string; workingDir: string }>;
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
   * A path is validated against the tree rather than merely against the
   * workspace, so the file endpoint serves exactly what the browser was
   * offered and no binary or metadata the tree leaves out. Building the tree
   * costs a walk of the workspace plus a status per repository, and opening a file almost
   * always follows a tree fetch — so it is cached for a few seconds rather
   * than rebuilt per request.
   */
  private readonly treePaths = new Map<string, { at: number; paths: Set<string> }>();

  /**
   * The repositories a session's workspace holds, as last discovered.
   *
   * Rediscovered by the tree fetch and reused by everything else. Fetches are
   * the clock: `GET /review/tree` walks again, and a file open, a comment and
   * a base change all reuse what it left.
   */
  private readonly repoMaps = new Map<string, RepoMap>();

  constructor(
    private readonly db: Db,
    private readonly sessions: ReviewSessions,
  ) {}

  // --- the workspace and its repositories -----------------------------------

  /** How long a remembered tree path set is reused. */
  private static readonly TREE_CACHE_MS = 3000;

  /** The session row, or a 404 by the same rule every other endpoint uses. */
  private row(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Session not found');
    return row;
  }

  /**
   * The session's workspace on this process's filesystem, which is the review
   * root and the only one there is.
   *
   * A session created before workspaces became directories has none until its
   * next start, which recreates its container with the bind and copies the
   * volume across. 409 rather than 404, because the session is real and the
   * fix is a start — which is what the review view says.
   */
  private workspace(id: string): string {
    const row = this.row(id);
    const path = this.sessions.workspacePath(row.id);
    if (!path || !isDirectory(path)) {
      throw new HttpError(
        409,
        'This session stores its workspace in a volume the orchestrator cannot read. ' +
          'Start the session once to migrate it, then review it.',
      );
    }
    return path;
  }

  /**
   * The session's container to run git in, started if it was stopped.
   *
   * Resolved for each request that asks git something, rather than remembered:
   * a container can be stopped between two requests, or replaced by one, and
   * either leaves a held id naming nothing.
   */
  private async box(id: string): Promise<GitBox> {
    const target = await this.sessions.execTarget(id);
    return { containerId: target.containerId, workspaceDir: target.workingDir };
  }

  /** The repositories of a session's workspace, discovering them if none are held. */
  private async repos(box: GitBox, id: string): Promise<RepoMap> {
    const held = this.repoMaps.get(id);
    if (held) return held;
    return this.rediscover(box, id);
  }

  /** Walks the workspace again and keeps what it found. */
  private async rediscover(box: GitBox, id: string): Promise<RepoMap> {
    const map = await discoverRepos(this.workspace(id), box);
    this.repoMaps.set(id, map);
    return map;
  }

  /**
   * The revision expression the session compares against, or '' for each
   * repository's own working tree.
   *
   * One expression for the whole workspace: what it resolves to is a different
   * commit in every repository, and is derived per request rather than stored.
   */
  private baseRev(id: string): string {
    return this.row(id).review_base_rev ?? '';
  }

  /** Where REVIEW.md is: at the workspace root, outside every repository. */
  private reviewPath(workspace: string): string {
    return join(workspace, REVIEW_FILE);
  }

  // --- reading --------------------------------------------------------------

  /**
   * The whole left panel: tree, statuses, comment counts, repositories and base.
   *
   * This is also the fetch that rediscovers the repositories, because it is the
   * one request that is always made when a review is looked at.
   *
   * Drift runs here across every annotated file, because this is the response
   * that decides which files the tree marks as commented, and a stale
   * `(outdated)` in it would be visible. It is bounded by the number of
   * annotated files, which a review has tens of, not thousands.
   */
  async tree(id: string): Promise<ReviewTreeResponse> {
    const workspace = this.workspace(id);
    const box = await this.box(id);
    const map = await this.rediscover(box, id);
    const rev = this.baseRev(id);
    const bases = await resolveBases(box, map, rev);

    const [listing, repos] = await Promise.all([
      this.listing(box, map, bases),
      this.describeRepos(box, map, bases),
    ]);

    const review = await this.driftAll(id, workspace);
    const entries = markRepoRoots(listing.entries, map);
    // The paths this response offers, remembered for the file open that
    // almost always follows it.
    this.rememberPaths(id, entries);

    return {
      repos,
      hasGit: map.hasGit,
      entries,
      truncated: listing.truncated,
      statuses: listing.statuses,
      counts: Object.fromEntries(annotationCounts(review)),
      base: { rev },
      hasReview: fileHash(this.reviewPath(workspace)) !== '',
      started: review.started,
    };
  }

  /**
   * One file: content, diff markers and its comments, in one response.
   *
   * The diff and the status come from the repository that owns the path, with
   * the path spelled the way that repository spells it. A file no repository
   * claims gets neither.
   *
   * The content is plain text. Highlighting happens in the browser, so nothing
   * on this wire is render markup and every line is an addressable row.
   */
  async file(id: string, relPath: string): Promise<ReviewFileResponse> {
    const workspace = this.workspace(id);
    const box = await this.box(id);
    const map = await this.repos(box, id);
    const repo = map.repoFor(relPath);
    const path = await this.resolveListed(box, workspace, id, relPath);
    if (path === null) {
      return goneFile(relPath, repo, await this.annotationsOf(id, workspace, relPath));
    }
    const read = readTextFile(path);
    const base = repo ? await this.baseIn(box, id, repo) : NO_BASE;

    // Only the owning repository is asked, rather than the whole workspace:
    // one file's status is one repository's answer, and running `status` in
    // every repository to find it would scale a file open with the number of
    // repositories.
    const [diff, statuses] = await Promise.all([
      repo && !read.binary
        ? fileDiff(gitTarget(box, repo.path), base, inRepo(repo, relPath), read.content)
        : Promise.resolve(null),
      repo ? fileStatuses(gitTarget(box, repo.path), base) : Promise.resolve(null),
    ]);

    // A binary file and a file past the display cap are not what the comments
    // were written against, so they come back as they stand: a drift check
    // against lines this process cannot read whole would mark them outdated.
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

  // --- mutation -------------------------------------------------------------

  /**
   * Replaces one file of the workspace with what the reviewer edited, and
   * answers with the file as it now stands.
   *
   * The whole file, because that is what was being edited. `hash` is what the
   * browser last read; a file that no longer matches it was written by the
   * agent in the meantime, and saving over that would drop its work without
   * anybody seeing it go. The refusal hands the decision back to the reviewer,
   * who is holding the only other copy.
   *
   * A truncated read is refused rather than saved: what the browser was shown
   * stops at the cap, and writing it back would delete everything past it.
   *
   * The answer is the file endpoint's, so one round trip repaints the code,
   * the diff, the status and the comments — which have followed the edit,
   * because {@link file} runs the drift check that moves them.
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
    const path = await this.resolveListed(await this.box(id), workspace, id, relPath);
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
    // 412 rather than 409, because this is the one refusal the reviewer can
    // overrule: they still hold their version, and the view offers to save it
    // anyway. The others say the file cannot be edited at all.
    if (fileHash(path) !== hash) {
      throw new HttpError(412, 'This file changed on disk while you were editing it.');
    }

    writeFileAtomic(path, content);
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
    // The path has to name a file of the tree, not merely resolve inside it:
    // an annotation on something the tree never listed could never be shown.
    const path = await this.resolveListed(await this.box(id), workspace, id, relPath);
    if (path === null) {
      throw new HttpError(409, 'This file was deleted, so there is no line to comment on.');
    }
    const source = fileLines(readTextFile(path).content);

    return this.mutate(id, workspace, relPath, (review) => {
      setAnnotation(review, relPath, line, text, source);
    });
  }

  /** Removes the comment on one line, and returns what is left for the file. */
  async deleteAnnotation(id: string, relPath: string, line: number): Promise<ReviewAnnotation[]> {
    if (!Number.isInteger(line) || line < 1) {
      throw new HttpError(400, 'line must be a positive integer');
    }
    const workspace = this.workspace(id);
    return this.mutate(id, workspace, relPath, (review) => {
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
    const workspace = this.workspace(id);
    await this.withLock(id, () => {
      removeFile(this.reviewPath(workspace));
    });
  }

  /**
   * Records the revision the whole review is compared against, and reports
   * where it landed.
   *
   * One expression, resolved independently in each repository through the
   * merge base with that repository's own HEAD, so commits made on the base
   * branch after branching off are not reported as this branch's changes. A
   * repository the revision names nothing in is compared against its own
   * working tree instead of failing the request; a 400 comes back only when it
   * resolves nowhere. Null clears it.
   */
  async setBase(id: string, rev: string | null): Promise<ReviewBaseResponse> {
    // The session is validated here as it is everywhere else, because the held
    // repository map would otherwise answer for a session that has none.
    this.workspace(id);
    const box = await this.box(id);
    const map = await this.repos(box, id);
    if (rev === null || rev.trim() === '') {
      this.db.prepare('UPDATE sessions SET review_base_rev = NULL WHERE id = ?').run(id);
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
      log.session(id).info('review base resolved in some repositories only', {
        rev: wanted,
        resolved: bases.size,
        repositories: map.repos.length,
      });
    }

    this.db.prepare('UPDATE sessions SET review_base_rev = ? WHERE id = ?').run(wanted, id);
    return { rev: wanted, repos: await this.describeRepos(box, map, bases) };
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
        // A change that applied to nothing — deleting a comment that is not
        // there — leaves the file alone, rather than creating a review that
        // holds none.
        if (serializeReview(review) === asRead) {
          return toAnnotations(annotationsFor(review, relPath));
        }
        if (review.started === '') review.started = todayStamp();
        const serialized = serializeReview(review);

        if (fileHash(path) !== before) {
          log.session(id).info('REVIEW.md changed mid-write; re-applying');
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
   * For the files drift has nothing to check against: one the change deleted,
   * one that is binary, one longer than the display cap. The tree counts those
   * comments, so the file view has to show them — a badge promising a comment
   * the reviewer cannot read or delete is worse than no badge.
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
        // Undefined is a file that cannot be read honestly: it is skipped
        // rather than having its annotations declared outdated.
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

  // --- repositories and the base --------------------------------------------

  /**
   * The repositories as the API reports them: where each is, what its HEAD
   * names, and what the review's base resolved to in it.
   *
   * `baseCommit` is what lets the header say "vs main, 2 of 3 repositories" —
   * a revision can name a branch in one repository and nothing at all in the
   * dependency checked out beside it.
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
    // Unknown here is not an error: this repository is compared against its
    // own working tree, the same soft failure `resolveBases` takes.
    return 'base' in resolved ? resolved.base : NO_BASE;
  }

  // --- paths ----------------------------------------------------------------

  /**
   * Resolves a client-supplied path, requiring that the tree lists it.
   *
   * `resolveInRoot` is the security boundary; this is the narrower rule that
   * the API serves what the browser was shown. Containment is against
   * `/workspace`, so a contained path may be in any repository it holds, or in
   * none. Every refusal is the same 404, so an escape attempt learns nothing
   * an unknown file would not have told it.
   *
   * Null is not a refusal: the tree lists the path and the working tree does
   * not have it, which is a file the change deleted. What to say about one is
   * the caller's to decide.
   */
  private async resolveListed(
    box: GitBox,
    workspace: string,
    id: string,
    relPath: string,
  ): Promise<string | null> {
    if (!(await this.listed(box, id)).has(relPath)) {
      throw new HttpError(404, 'File not found');
    }
    const resolved = resolveInRoot(workspace, relPath);
    if (resolved.ok) {
      if (isDirectory(resolved.path)) throw new HttpError(404, 'File not found');
      return resolved.path;
    }
    if (resolved.reason === 'missing') return null;
    throw new HttpError(404, 'File not found');
  }

  /**
   * The path set of a session's tree, rebuilt when the cached one is stale.
   *
   * The files a change deleted are in it, because the tree offers them: what
   * this set decides is whether the API serves what the browser was shown.
   */
  private async listed(box: GitBox, id: string): Promise<Set<string>> {
    const cached = this.treePaths.get(id);
    if (cached && Date.now() - cached.at < ReviewService.TREE_CACHE_MS) return cached.paths;
    const map = await this.repos(box, id);
    const bases = await resolveBases(box, map, this.baseRev(id));
    return this.rememberPaths(id, (await this.listing(box, map, bases)).entries);
  }

  /**
   * The tree a review browses, with the files a change deleted put back into
   * it, and the statuses that named them.
   *
   * Only the statuses know a deleted file's path, so the two are built
   * together — and the tree endpoint and {@link listed} offer exactly the same
   * entries, which is what makes a path the browser was shown one the file
   * endpoint serves.
   */
  private async listing(
    box: GitBox,
    map: RepoMap,
    bases: Map<string, Base>,
  ): Promise<{ entries: TreeEntry[]; statuses: FileStatuses; truncated: boolean }> {
    const [tree, statuses] = await Promise.all([
      reviewTree(map),
      workspaceStatuses(box, map, bases),
    ]);
    return {
      entries: withDeleted(tree.entries, deletedPaths(statuses)),
      statuses,
      truncated: tree.truncated,
    };
  }

  /**
   * Remembers the paths one set of tree entries offers, and hands them back.
   *
   * Both the tree endpoint and {@link listed} end up holding the same entries,
   * so whichever of them ran most recently is the one the next file request is
   * validated against.
   */
  private rememberPaths(id: string, entries: TreeEntry[]): Set<string> {
    const paths = treePaths(entries);
    this.treePaths.set(id, { at: Date.now(), paths });
    return paths;
  }

  /** Drops a session's remembered tree and repositories, for a delete. */
  forget(id: string): void {
    this.treePaths.delete(id);
    this.repoMaps.delete(id);
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
 * Null says the file is gone, which is what marks every annotation on it
 * outdated. Undefined says it is there and cannot be read honestly — it is
 * binary, or longer than the display cap — where the lines on hand are not
 * what the comments were written against and drift has nothing to say.
 *
 * The path is workspace-relative and so is the annotation's, which is why a
 * file that moves between repositories needs nothing new: a comment follows
 * the path, and drift already handles its content moving.
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

/** The paths a status map reports as gone from the working tree. */
function deletedPaths(statuses: Record<string, ReviewFileStatus>): string[] {
  return Object.entries(statuses)
    .filter(([, status]) => status === 'deleted')
    .map(([path]) => path);
}

/** One file's annotations, as the API reports them: a list, in line order. */
function toAnnotations(annotations: Map<number, { comment: string; outdated: boolean }>): ReviewAnnotation[] {
  return [...annotations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, ann]) => ({ line, comment: ann.comment, outdated: ann.outdated }));
}
