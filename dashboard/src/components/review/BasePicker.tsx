import { GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import type { ReviewBase } from '../../../../shared/types.ts';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Which revision the review is compared against.
 *
 * Without one, the diff is against the working tree's HEAD: what has not been
 * committed yet. With one, it is against the merge base of that revision and
 * HEAD, so a whole branch's work reads as the change — and commits made on the
 * base branch after branching off do not.
 *
 * A popover with a free-text field rather than a list of branches: the
 * orchestrator does not enumerate refs, and "main" or "HEAD~3" is quicker to
 * type than a list is to scroll on a phone. The revision is resolved server
 * side, so a name that is not a revision comes back as an error rather than
 * silently doing nothing.
 */
export function BasePicker({
  base,
  busy,
  onSet,
}: {
  base: ReviewBase;
  busy: boolean;
  onSet: (rev: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rev, setRev] = useState(base.rev);

  const active = base.commit !== '';

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
        // Re-seeded on open rather than kept: the field should show what is
        // active, not what was last typed and abandoned.
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
              ? `Comparing against ${base.rev} (${base.commit.slice(0, 8)})`
              : 'Comparing against the working tree'
          }
        >
          <GitCompareArrows className="size-3.5" />
          {/* The status line says which base is active, the way the desktop
              tool's does. On a narrow header the icon alone carries it. */}
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
            <p className="font-mono text-xs text-muted-foreground">
              now: {base.rev} @ {base.commit.slice(0, 8)}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
