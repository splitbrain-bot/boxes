import { GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import type { ReviewBase, ReviewRepo } from '../../../../shared/types.ts';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * A popover that sets the revision the review is compared against.
 *
 * The revision is a free-text field, because the orchestrator does not list
 * refs. The same revision can resolve in one repository and not in another,
 * so the popover lists the commit it resolved to in each repository.
 */
export function BasePicker({
  base,
  repos,
  busy,
  onSet,
}: {
  /** The active base. An empty revision compares each repository against its own HEAD. */
  base: ReviewBase;
  /** The workspace's repositories, each carrying the commit the revision resolved to. */
  repos: ReviewRepo[];
  /** Disables the controls while a request runs. */
  busy: boolean;
  /** Called with the new revision, or with null to compare against HEAD again. */
  onSet: (rev: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rev, setRev] = useState(base.rev);

  const active = base.rev !== '';
  const landed = repos.filter((repo) => repo.baseCommit !== '');

  const submit = (): void => {
    const wanted = rev.trim();
    if (wanted === '') return;
    setOpen(false);
    onSet(wanted);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset on open, so the field shows the active base and not abandoned input.
        if (next) setRev(base.rev);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? 'outline' : 'ghost'}
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={busy}
          title={
            active
              ? `Comparing against ${base.rev}${whereLanded(landed.length, repos.length)}`
              : 'Comparing against HEAD'
          }
        >
          <GitCompareArrows className="size-3.5" />
          <span className="hidden max-w-24 truncate sm:inline">
            {active ? base.rev : 'HEAD'}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Compare against a branch, tag or commit. The merge base with HEAD is used, so work
            done on the base branch since is not counted as a change here.
          </p>
          <input
            value={rev}
            onChange={(event) => setRev(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="main, v1.2.0, HEAD~3…"
            aria-label="Base revision"
            spellCheck={false}
            autoCapitalize="off"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || rev.trim() === ''}
              onClick={submit}
            >
              Compare
            </Button>
            {active ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onSet(null);
                }}
              >
                Back to HEAD
              </Button>
            ) : null}
          </div>
          {active ? (
            <ul className="flex list-none flex-col gap-0.5 font-mono text-xs text-muted-foreground">
              {repos.map((repo) => (
                <li key={repo.path} className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{repo.name}</span>
                  {/* The orchestrator compares a repository the revision does not
                      resolve in against its own HEAD instead of failing. */}
                  <span className={repo.baseCommit === '' ? 'text-warn' : undefined}>
                    {repo.baseCommit === '' ? 'HEAD' : repo.baseCommit.slice(0, 8)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Describes how many repositories the base resolved in, for the button title.
 *
 * @param landed The number of repositories the base resolved in.
 * @param total The number of repositories in the workspace.
 * @returns Text like ", in 2 of 3 repositories", or an empty string for one repository or none.
 */
function whereLanded(landed: number, total: number): string {
  if (total <= 1) return '';
  return `, in ${landed} of ${total} repositories`;
}
