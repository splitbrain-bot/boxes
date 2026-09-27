import { Pencil, Trash2 } from 'lucide-react';
import type { ReviewAnnotation } from '../../../../shared/types.ts';
import { Button } from '@/components/ui/button';

/**
 * One comment, as a card under the line it is about.
 *
 * The agent can write into REVIEW.md, so the comment renders as a text node only.
 */
export function CommentCard({
  annotation,
  busy,
  onEdit,
  onDelete,
}: {
  /** The comment to show. */
  annotation: ReviewAnnotation;
  /** True while a write is in flight, so a double tap cannot act twice. */
  busy: boolean;
  /** Called when the user asks to edit the comment. */
  onEdit: () => void;
  /** Called when the user asks to delete the comment. */
  onDelete: () => void;
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2 font-sans text-sm">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{annotation.comment}</p>
        <div className="flex shrink-0 gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onEdit}
            aria-label={`Edit the comment on line ${annotation.line}`}
            title="Edit"
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Delete the comment on line ${annotation.line}`}
            title="Delete"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {annotation.outdated ? (
        <p className="mt-1 text-xs text-muted-foreground">
          The code this was written about has changed, so the line may no longer be the right
          one.
        </p>
      ) : null}
    </div>
  );
}
