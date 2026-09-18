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
 * Prev/next navigation over a file's changes and comments, and the way in and
 * out of edit mode.
 *
 * The navigation replaces the desktop tool's scrollbar minimap. Annotation
 * markers on a scrollbar are unusable on touch — there is no scrollbar to aim
 * at — and paired step buttons turn out to be better on a pointer too: "the
 * next thing that needs me" is what the minimap was being used for, and this
 * says it directly. A decorative overview rail can come later; it is paint, not
 * function.
 *
 * Editing is a mode rather than a separate screen, and its controls live here
 * rather than over the code, because the toolbar is pinned while the keyboard
 * is up and a control the keyboard covers is a control that is not there.
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
  changeCount: number;
  commentCount: number;
  /** Whether the pane has rows to step to. A file shown as one block has none. */
  steppable: boolean;
  wrap: boolean;
  /** Whether this file can be edited at all. */
  editable: boolean;
  /** Whether the pane is being edited rather than read. */
  editing: boolean;
  /** Whether there is anything to save. */
  dirty: boolean;
  /** Whether a write is in flight. */
  busy: boolean;
  onWrap: () => void;
  /** −1 for the previous change, +1 for the next. */
  onStepChange: (direction: -1 | 1) => void;
  onStepComment: (direction: -1 | 1) => void;
  onEdit: () => void;
  onSave: () => void;
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
          {/* Named rather than an icon, and the one filled control on the bar:
              unsaved work is the only thing here that is lost by walking away
              from it. */}
          <Button type="button" size="sm" disabled={!dirty || busy} onClick={onSave}>
            Save
          </Button>
        </>
      ) : (
        // Wrapping is forced on while editing, so there is nothing to toggle
        // there and the button goes rather than sitting on the bar disabled.
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

      {/* A file the pane cannot show whole is one it must not write back, so
          there is no control here for it rather than one that refuses. */}
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
  icon: React.ReactNode;
  label: string;
  count: number;
  /** Whether there is a row to step to. */
  steppable: boolean;
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
