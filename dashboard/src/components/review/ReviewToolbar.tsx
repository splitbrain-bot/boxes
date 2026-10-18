import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitCompare,
  MessageSquare,
  Pencil,
  Undo2,
  WrapText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The toolbar over the code pane.
 *
 * The edit controls are here, because the toolbar stays pinned while the
 * keyboard is up.
 *
 * @param changeCount The number of changes in the file.
 * @param commentCount The number of comments in the file.
 * @param steppable True when the pane has rows to step to. A file shown as one block has none.
 * @param wrap True when long lines wrap.
 * @param editable True when this file can be edited.
 * @param editing True while the pane is in edit mode.
 * @param dirty True when there are unsaved changes.
 * @param busy True while a write is in flight.
 * @param openHref The URL that serves the bytes of the file, or null for a file with none.
 * @param onWrap Called when the user toggles wrapping.
 * @param onStepChange Called with -1 for the previous change or 1 for the next.
 * @param onStepComment Called with -1 for the previous comment or 1 for the next.
 * @param onEdit Called when the user switches edit mode on or off.
 * @param onSave Called when the user saves the file.
 * @param onRevert Called when the user discards the unsaved changes.
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
  openHref,
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
  /** True when the pane has rows to step to. A file shown as one block has none. */
  steppable: boolean;
  /** True when long lines wrap. */
  wrap: boolean;
  /** True when this file can be edited. */
  editable: boolean;
  /** True while the pane is in edit mode. */
  editing: boolean;
  /** True when there are unsaved changes. */
  dirty: boolean;
  /** True while a write is in flight. */
  busy: boolean;
  /** The URL that serves the bytes of the file, or null for a file with none. */
  openHref: string | null;
  /** Called when the user toggles wrapping. */
  onWrap: () => void;
  /** Called with -1 for the previous change or 1 for the next. */
  onStepChange: (direction: -1 | 1) => void;
  /** Called with -1 for the previous comment or 1 for the next. */
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

      {/* A plain link, so the browser handles the file by its type. */}
      {openHref ? (
        <Button asChild variant="ghost" size="icon-sm">
          <a
            href={openHref}
            target="_blank"
            rel="noopener"
            title="Open in a new tab"
            aria-label="Open in a new tab"
          >
            <ExternalLink />
          </a>
        </Button>
      ) : null}

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
          {/* The only filled control, because unsaved changes are lost when the
              reader leaves. */}
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

/**
 * One count with its pair of step buttons.
 *
 * @param icon The icon in front of the count.
 * @param label The singular noun for the counted things, used in the button labels.
 * @param count The number of counted things.
 * @param steppable True when there is a row to step to.
 * @param onStep Called with -1 for the previous one or 1 for the next.
 */
function Group({
  icon,
  label,
  count,
  steppable,
  onStep,
}: {
  /** The icon in front of the count. */
  icon: React.ReactNode;
  /** The singular noun for the counted things, used in the button labels. */
  label: string;
  /** The number of counted things. */
  count: number;
  /** True when there is a row to step to. */
  steppable: boolean;
  /** Called with -1 for the previous one or 1 for the next. */
  onStep: (direction: -1 | 1) => void;
}) {
  const nothingToStepTo = count === 0 || !steppable;
  const plural = count === 1 ? label : `${label}s`;
  return (
    <div className="flex items-center gap-0.5">
      <span
        role="img"
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
