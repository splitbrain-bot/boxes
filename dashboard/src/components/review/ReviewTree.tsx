import { ChevronDown, ChevronRight, File, GitBranch, MessageSquare } from 'lucide-react';
import type { ReviewDirResponse, ReviewFileStatus } from '../../../../shared/types.ts';
import { Notice } from '@/components/Notice';
import { cn } from '@/lib/utils';

/** What a status colours its row, and the single letter that names it. */
const STATUS: Record<ReviewFileStatus, { className: string; mark: string; label: string }> = {
  modified: { className: 'text-warn', mark: 'M', label: 'modified' },
  staged: { className: 'text-primary', mark: 'S', label: 'staged' },
  untracked: { className: 'text-ok', mark: '?', label: 'untracked' },
  added: { className: 'text-ok', mark: 'A', label: 'added' },
  deleted: { className: 'text-danger', mark: 'D', label: 'deleted' },
  conflict: { className: 'text-danger', mark: '!', label: 'conflict' },
};

/**
 * The workspace's files, with git status and comment counts on them.
 *
 * One tree over the whole workspace, not over one repository in it: paths are
 * workspace-relative, and the directory a repository is rooted at is marked,
 * so the boundaries are visible while scrolling across them. Which repository
 * a file belongs to is what decides its status letter and its gutter markers,
 * and there is nothing to switch between.
 *
 * A folder is fetched when it is opened, so what is on screen is what has been
 * asked for. Which folders are open is the store's, because refetching the tree
 * has to bring back the same shape the reviewer left.
 *
 * One component for both arrangements: a column beside the pane from `md` up,
 * and below it a full-width step of the navigation stack that the open file
 * takes the screen from. The desktop tool's three panels do not survive a
 * phone, but the tree does — what changes is where it is mounted, not what it
 * renders.
 */
export function ReviewTree({
  dirs,
  expanded,
  activePath,
  onOpen,
  onToggle,
}: {
  /** Each loaded directory by its path; the workspace root is ''. */
  dirs: Record<string, ReviewDirResponse>;
  /** The folders standing open, by path. */
  expanded: string[];
  /** The file the pane is showing, so the tree can mark it. */
  activePath: string | null;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const root = dirs[''];
  if (!root) return null;

  if (root.entries.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground">
        This workspace is empty. Once the agent has cloned or written something, it shows up
        here.
      </p>
    );
  }

  return (
    <div className="flex flex-col py-1">
      <Level
        dir={root}
        depth={0}
        dirs={dirs}
        expanded={expanded}
        activePath={activePath}
        onOpen={onOpen}
        onToggle={onToggle}
      />
    </div>
  );
}

/** One directory, and every folder of it that stands open. */
function Level({
  dir,
  depth,
  dirs,
  expanded,
  activePath,
  onOpen,
  onToggle,
}: {
  dir: ReviewDirResponse;
  depth: number;
  dirs: Record<string, ReviewDirResponse>;
  expanded: string[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  return (
    <>
      {dir.truncated ? (
        <Notice tone="warn" className="mx-2 mb-1 rounded-md border px-2 py-1 text-xs">
          This folder holds more files than can be listed. The rest are not shown.
        </Notice>
      ) : null}
      <ul className="list-none">
        {dir.entries.map((entry) => {
          const isOpen = entry.isDir && expanded.includes(entry.path);
          const below = isOpen ? dirs[entry.path] : undefined;

          return (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => (entry.isDir ? onToggle(entry.path) : onOpen(entry.path))}
                aria-expanded={entry.isDir ? isOpen : undefined}
                aria-current={entry.path === activePath ? 'true' : undefined}
                // 44px of tap target on touch, less on a pointer where rows can
                // be dense without being unusable.
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 text-left text-sm',
                  'min-h-11 md:min-h-8',
                  'hover:bg-accent hover:text-accent-foreground',
                  entry.path === activePath && 'bg-accent font-medium',
                )}
                style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
              >
                {entry.isDir ? (
                  isOpen ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <File className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    entry.status && STATUS[entry.status].className,
                    // A repository root reads as a heading rather than a folder:
                    // it is where one project's statuses and diffs stop meaning
                    // anything and the next one's start.
                    entry.repo && 'font-medium',
                  )}
                  title={entry.path}
                >
                  {entry.name}
                </span>
                {entry.repo ? (
                  <GitBranch
                    className="size-3 shrink-0 text-muted-foreground"
                    role="img"
                    aria-label="a git repository"
                  />
                ) : null}
                {entry.status ? (
                  <span
                    aria-label={STATUS[entry.status].label}
                    title={STATUS[entry.status].label}
                    className={cn(
                      'shrink-0 font-mono text-xs',
                      STATUS[entry.status].className,
                    )}
                  >
                    {STATUS[entry.status].mark}
                  </span>
                ) : entry.changed && !isOpen ? (
                  // Closed, with changed files inside: the letters belong to
                  // the files, but a branch that hides one has to say so.
                  <span
                    role="img"
                    aria-label="contains changes"
                    title="contains changes"
                    className="size-1.5 shrink-0 rounded-full bg-warn"
                  />
                ) : null}
                {entry.comments ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/15 px-1.5 text-xs text-primary"
                    aria-label={
                      entry.comments === 1 ? '1 comment' : `${entry.comments} comments`
                    }
                  >
                    <MessageSquare className="size-3" />
                    {entry.comments}
                  </span>
                ) : entry.commented && !isOpen ? (
                  // A closed branch still says there is something in it,
                  // which is what makes the tree usable as a to-do list.
                  <MessageSquare
                    className="size-3 shrink-0 text-primary"
                    role="img"
                    aria-label="contains comments"
                  />
                ) : null}
              </button>

              {below ? (
                <Level
                  dir={below}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  activePath={activePath}
                  onOpen={onOpen}
                  onToggle={onToggle}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
