import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { lineRange } from '@/lib/lines';
import type { ReviewAnnotation } from '../../../../shared/types.ts';

/**
 * One comment, as a card under the line or the block it is about.
 *
 * The agent can write into REVIEW.md, so the comment renders as a text node only.
 *
 * @param annotation The comment to show.
 * @param busy True while a write is in flight, so a double tap cannot act twice.
 * @param showLine True to name the line of a comment on one line. A comment on a block always names its lines.
 * @param onEdit Called when the user asks to edit the comment.
 * @param onDelete Called when the user asks to delete the comment.
 */
export function CommentCard({
  annotation,
  busy,
  showLine = false,
  onEdit,
  onDelete,
}: {
  /** The comment to show. */
  annotation: ReviewAnnotation;
  /** True while a write is in flight, so a double tap cannot act twice. */
  busy: boolean;
  /** True to name the line of a comment on one line. A comment on a block always names its lines. */
  showLine?: boolean;
  /** Called when the user asks to edit the comment. */
  onEdit: () => void;
  /** Called when the user asks to delete the comment. */
  onDelete: () => void;
}) {
  const range = lineRange(annotation.line, annotation.endLine);
  return (
    <div className="rounded-md border bg-card px-3 py-2 font-sans text-sm">
      {annotation.endLine > 0 || showLine ? (
        <p className="mb-1 text-xs text-muted-foreground first-letter:uppercase">{range}</p>
      ) : null}
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{annotation.comment}</p>
        <div className="flex shrink-0 gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onEdit}
            aria-label={`Edit the comment on ${range}`}
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
            aria-label={`Delete the comment on ${range}`}
            title="Delete"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {annotation.outdated ? (
        <p className="mt-1 text-xs text-muted-foreground">
          The code this was written about has changed, so the line may no longer be the right one.
        </p>
      ) : null}
    </div>
  );
}
