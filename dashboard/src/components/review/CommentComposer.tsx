import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { lineRange } from '@/lib/lines';
import type { Composing } from '../../stores/review.ts';

/**
 * The save shortcut as the hint shows it: ⌘↵ on Apple platforms, Ctrl+↵
 * elsewhere. The shortcut itself accepts either modifier.
 */
const SAVE_KEY = /mac|iphone|ipad|ipod/i.test(
  typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent,
)
  ? '⌘↵'
  : 'Ctrl+↵';

/**
 * The form that both composer layouts render.
 *
 * @param line The line being commented on, or the first line of the block.
 * @param endLine The last line of the block, or 0 for one line.
 * @param initial The existing comment when editing, or '' when writing a new one.
 * @param busy Disables the buttons while a write is in flight.
 * @param autoFocus Focuses the textarea on mount and whenever the line changes.
 * @param onSave Called with the trimmed comment when the user saves.
 * @param onCancel Called when the user cancels.
 */
function Form({
  line,
  endLine,
  initial,
  busy,
  autoFocus,
  onSave,
  onCancel,
}: {
  /** The line being commented on, or the first line of the block. */
  line: number;
  /** The last line of the block, or 0 for one line. */
  endLine: number;
  /** The existing comment when editing, or '' when writing a new one. */
  initial: string;
  /** Disables the buttons while a write is in flight. */
  busy: boolean;
  /** Focuses the textarea on mount and whenever the line changes. */
  autoFocus: boolean;
  /** Called with the trimmed comment when the user saves. */
  onSave: (comment: string) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const range = lineRange(line, endLine);

  // The composer stays mounted when it moves to another line, so it resets the text.
  useEffect(() => {
    setText(initial);
  }, [line, initial]);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus, line]);

  const save = (): void => {
    const comment = text.trim();
    if (comment !== '') onSave(comment);
  };

  return (
    <div className="flex flex-col gap-2 font-sans">
      <textarea
        ref={field}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Plain Enter adds a line break, so saving needs the modifier.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
          if (event.key === 'Escape') onCancel();
        }}
        rows={3}
        placeholder={`Comment on ${range}…`}
        aria-label={`Comment on ${range}`}
        className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy || text.trim() === ''} onClick={save}>
          {initial === '' ? 'Comment' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
          {SAVE_KEY} to save, Esc to cancel
        </span>
      </div>
    </div>
  );
}

/**
 * The composer inline below the line, for wide screens.
 *
 * @param props The line or the block, the existing comment, the busy flag and the callbacks.
 */
export function InlineComposer(props: {
  /** The line being commented on, or the first line of the block. */
  line: number;
  /** The last line of the block, or 0 for one line. */
  endLine: number;
  /** The existing comment when editing, or '' when writing a new one. */
  initial: string;
  /** Disables the buttons while a write is in flight. */
  busy: boolean;
  /** Called with the trimmed comment when the user saves. */
  onSave: (comment: string) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}) {
  return (
    <div className="rounded-md border bg-card p-2">
      <Form {...props} autoFocus />
    </div>
  );
}

/**
 * The composer as a bottom sheet for narrow screens, so the keyboard does not
 * cover the textarea.
 *
 * The view picks this or {@link InlineComposer} with a media query, because the
 * sheet renders into a portal that a CSS breakpoint on a wrapper cannot hide.
 *
 * @param composing The line or the block being commented on, or null when the sheet is closed.
 * @param initial The existing comment when editing, or '' when writing a new one.
 * @param busy Disables the buttons while a write is in flight.
 * @param onSave Called with the trimmed comment when the user saves.
 * @param onCancel Called when the user cancels or dismisses the sheet.
 * @param onCover Called with the top edge of the area that the sheet and the keyboard cover, or with null when the
 *   sheet closes.
 */
export function ComposerSheet({
  composing,
  initial,
  busy,
  onSave,
  onCancel,
  onCover,
}: {
  /** The line or the block being commented on, or null when the sheet is closed. */
  composing: Composing | null;
  /** The existing comment when editing, or '' when writing a new one. */
  initial: string;
  /** Disables the buttons while a write is in flight. */
  busy: boolean;
  /** Called with the trimmed comment when the user saves. */
  onSave: (comment: string) => void;
  /** Called when the user cancels or dismisses the sheet. */
  onCancel: () => void;
  /**
   * Called with the top edge of the area that the sheet and the keyboard cover, in pixels from the top of the
   * layout viewport, or with null when the sheet closes.
   */
  onCover: (top: number | null) => void;
}) {
  const range = composing ? lineRange(composing.line, composing.endLine) : '';
  const open = composing !== null;
  /** The panel of the open sheet. Radix mounts it in a portal after the sheet opens, and unmounts it after it closes. */
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);

  /**
   * Reports the covered area while the panel is on screen. The panel slides in, and the keyboard opens after it
   * and shrinks the visible area, so the sheet measures again after each of them.
   */
  useEffect(() => {
    const element = panel;
    if (!element) {
      onCover(null);
      return;
    }
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
        onCover(Math.min(element.getBoundingClientRect().top, visibleBottom));
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('animationend', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('animationend', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [panel, onCover]);

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      {/* The sheet has no description. An explicit undefined tells Radix the
          omission is deliberate. The backdrop is light, so the commented text
          above the sheet stays readable. */}
      <SheetContent
        ref={setPanel}
        side="bottom"
        className="gap-0"
        overlayClassName="bg-black/25"
        aria-describedby={undefined}
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="text-sm">
            {initial === '' ? `Comment on ${range}` : `Edit the comment on ${range}`}
          </SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {composing === null ? null : (
            <Form
              line={composing.line}
              endLine={composing.endLine}
              initial={initial}
              busy={busy}
              autoFocus
              onSave={onSave}
              onCancel={onCancel}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
