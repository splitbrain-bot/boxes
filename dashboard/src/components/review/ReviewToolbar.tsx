import {
  ChevronDown,
  ChevronUp,
  GitCompare,
  MessageSquare,
  Pencil,
  Undo2,
  WrapText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The toolbar over the code pane: prev/next navigation over a file's changes
 * and comments, and the way in and out of edit mode.
 *
 * The edit controls live here because the toolbar stays pinned while the
 * keyboard is up.
 */
export function ReviewToolbar({
  changeCount,
  commentCount,
  steppable,
  wrap,
  editable,
  editing,
  dirty,
  busy,
  onWrap,
  onStepChange,
  onStepComment,
  onEdit,
  onSave,
  onRevert,
}: {
  /** The number of changes in the file. */
  changeCount: number;
  /** The number of comments in the file. */
  commentCount: number;
  /** Whether the pane has rows to step to. A file shown as one block has none. */
  steppable: boolean;
  /** Whether long lines wrap. */
  wrap: boolean;
  /** Whether this file can be edited at all. */
  editable: boolean;
  /** Whether the pane is being edited rather than read. */
  editing: boolean;
  /** Whether there is anything to save. */
  dirty: boolean;
  /** Whether a write is in flight. */
  busy: boolean;
  /** Called when the user toggles wrapping. */
  onWrap: () => void;
  /** Called with −1 for the previous change or 1 for the next. */
  onStepChange: (direction: -1 | 1) => void;
  /** Called with −1 for the previous comment or 1 for the next. */
  onStepComment: (direction: -1 | 1) => void;
  /** Called when the user switches edit mode on or off. */
  onEdit: () => void;
  /** Called when the user saves the file. */
  onSave: () => void;
  /** Called when the user discards the unsaved changes. */
  onRevert: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1 text-xs">
      <Group
        icon={<GitCompare className="size-3.5" />}
        label="change"
        count={changeCount}
        steppable={steppable}
        onStep={onStepChange}
      />
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <Group
        icon={<MessageSquare className="size-3.5" />}
        label="comment"
        count={commentCount}
        steppable={steppable}
        onStep={onStepComment}
      />
      <span className="flex-1" />

      {editing ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!dirty || busy}
            onClick={onRevert}
            title="Put the file back as it was"
            aria-label="Put the file back as it was"
          >
            <Undo2 />
          </Button>
          {/* The only filled control, because unsaved work is the one thing lost
              by walking away. */}
          <Button type="button" size="sm" disabled={!dirty || busy} onClick={onSave}>
            Save
          </Button>
        </>
      ) : (
        // Editing always wraps, so the wrap toggle hides while editing.
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
      )}

      {editable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={editing}
          onClick={onEdit}
          title={editing ? 'Stop editing and go back to commenting' : 'Edit this file'}
          aria-label={editing ? 'Stop editing and go back to commenting' : 'Edit this file'}
          className={cn(editing && 'bg-accent text-accent-foreground')}
        >
          <Pencil />
        </Button>
      ) : null}
    </div>
  );
}

/** One count with its pair of step buttons. */
function Group({
  icon,
  label,
  count,
  steppable,
  onStep,
}: {
  /** The icon in front of the count. */
  icon: React.ReactNode;
  /** The singular noun for what is counted, used in the button labels. */
  label: string;
  /** How many there are. */
  count: number;
  /** Whether there is a row to step to. */
  steppable: boolean;
  /** Called with −1 for the previous one or 1 for the next. */
  onStep: (direction: -1 | 1) => void;
}) {
  const nothingToStepTo = count === 0 || !steppable;
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
        disabled={nothingToStepTo}
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
        disabled={nothingToStepTo}
        onClick={() => onStep(1)}
        aria-label={`Next ${label}`}
        title={`Next ${label}`}
      >
        <ChevronDown />
      </Button>
    </div>
  );
}
