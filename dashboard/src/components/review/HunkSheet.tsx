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
 * One diff hunk, as its own surface.
 *
 * The desktop tool shows this in a tooltip on gutter hover. There is no hover
 * on a phone and a tooltip cannot be scrolled, so the same content becomes a
 * bottom sheet a gutter tap opens — which is also where the deleted lines
 * live, since the file itself cannot show them.
 *
 * The diff text comes from the workspace and is rendered as text nodes only.
 */
export function HunkSheet({
  hunk,
  onClose,
}: {
  /** The hunk to show, or null when the sheet is closed. */
  hunk: ReviewDiffHunk | null;
  onClose: () => void;
}) {
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
          <div className="w-max min-w-full font-mono text-[13px] leading-[1.5]">
            {(hunk?.diff ?? '').split('\n').map((line, i) =>
              // A trailing empty line is the terminator, not a diff line.
              i === (hunk?.diff ?? '').split('\n').length - 1 && line === '' ? null : (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre px-1',
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
