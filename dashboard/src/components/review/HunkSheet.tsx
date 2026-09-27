import type { ReviewDiffHunk } from '../../../../shared/types.ts';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/**
 * A bottom sheet that shows one diff hunk. It is the only place where deleted
 * lines show.
 *
 * The diff text comes from the workspace and renders as text nodes only.
 */
export function HunkSheet({
  hunk,
  onClose,
}: {
  /** The hunk to show, or null when the sheet is closed. */
  hunk: ReviewDiffHunk | null;
  /** Called when the sheet closes. */
  onClose: () => void;
}) {
  const lines = (hunk?.diff ?? '').split('\n');
  return (
    <Sheet open={hunk !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="bottom" className="max-h-[70vh] gap-0">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-sm">
            {hunk ? `Lines ${hunk.startLine}–${hunk.endLine}` : 'Changes'}
          </SheetTitle>
          <SheetDescription className="text-xs">
            What changed here, as git reports it.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 overflow-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="min-w-full font-mono text-[13px] leading-[1.5]">
            {lines.map((line, i) =>
              // A trailing empty line is the terminator, not a diff line.
              i === lines.length - 1 && line === '' ? null : (
                <div
                  key={i}
                  className={cn(
                    // Indents the rest of a wrapped line past the +/− column.
                    '-indent-3 pr-1 pl-4 break-words whitespace-pre-wrap',
                    line.startsWith('+') && 'bg-ok/12 text-ok',
                    line.startsWith('-') && 'bg-danger/12 text-danger',
                    line.startsWith('\\') && 'text-muted-foreground',
                  )}
                >
                  {line === '' ? '​' : line}
                </div>
              ),
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
