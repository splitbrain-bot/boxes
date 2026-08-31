import { ChevronDown, ChevronUp, GitCompare, MessageSquare, WrapText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Prev/next navigation over a file's changes and comments.
 *
 * This replaces the desktop tool's scrollbar minimap. Annotation markers on a
 * scrollbar are unusable on touch — there is no scrollbar to aim at — and
 * paired step buttons turn out to be better on a pointer too: "the next thing
 * that needs me" is what the minimap was being used for, and this says it
 * directly. A decorative overview rail can come later; it is paint, not
 * function.
 */
export function ReviewToolbar({
  changeCount,
  commentCount,
  wrap,
  onWrap,
  onStepChange,
  onStepComment,
}: {
  changeCount: number;
  commentCount: number;
  wrap: boolean;
  onWrap: () => void;
  /** −1 for the previous change, +1 for the next. */
  onStepChange: (direction: -1 | 1) => void;
  onStepComment: (direction: -1 | 1) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1 text-xs">
      <Group
        icon={<GitCompare className="size-3.5" />}
        label="change"
        count={changeCount}
        onStep={onStepChange}
      />
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <Group
        icon={<MessageSquare className="size-3.5" />}
        label="comment"
        count={commentCount}
        onStep={onStepComment}
      />
      <span className="flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-pressed={wrap}
        onClick={onWrap}
        title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
        aria-label={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
        className={cn(wrap && 'bg-accent text-accent-foreground')}
      >
        <WrapText />
      </Button>
    </div>
  );
}

/** One count with its pair of step buttons. */
function Group({
  icon,
  label,
  count,
  onStep,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  onStep: (direction: -1 | 1) => void;
}) {
  const plural = count === 1 ? label : `${label}s`;
  return (
    <div className="flex items-center gap-0.5">
      <span
        className="inline-flex items-center gap-1 px-1 text-muted-foreground"
        aria-label={`${count} ${plural}`}
      >
        {icon}
        <span className="tabular-nums">{count}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={count === 0}
        onClick={() => onStep(-1)}
        aria-label={`Previous ${label}`}
        title={`Previous ${label}`}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={count === 0}
        onClick={() => onStep(1)}
        aria-label={`Next ${label}`}
        title={`Next ${label}`}
      >
        <ChevronDown />
      </Button>
    </div>
  );
}
