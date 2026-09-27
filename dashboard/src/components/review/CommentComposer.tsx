import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/**
 * The save shortcut as the hint shows it: ⌘↵ on Apple platforms, Ctrl+↵
 * elsewhere. The shortcut itself accepts either modifier.
 */
const SAVE_KEY = /mac|iphone|ipad|ipod/i.test(
  typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent,
)
  ? '⌘↵'
  : 'Ctrl+↵';

/** The form both arrangements render. */
function Form({
  line,
  initial,
  busy,
  autoFocus,
  onSave,
  onCancel,
}: {
  /** The line being commented on. */
  line: number;
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
        placeholder={`Comment on line ${line}…`}
        aria-label={`Comment on line ${line}`}
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

/** The composer inline under the line, for wide screens. */
export function InlineComposer(props: {
  /** The line being commented on. */
  line: number;
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
 */
export function ComposerSheet({
  line,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  /** The line being commented on, or null when the sheet is closed. */
  line: number | null;
  /** The existing comment when editing, or '' when writing a new one. */
  initial: string;
  /** Disables the buttons while a write is in flight. */
  busy: boolean;
  /** Called with the trimmed comment when the user saves. */
  onSave: (comment: string) => void;
  /** Called when the user cancels or dismisses the sheet. */
  onCancel: () => void;
}) {
  return (
    <Sheet open={line !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      {/* The sheet has no description. An explicit undefined tells Radix the
          omission is deliberate. */}
      <SheetContent side="bottom" className="gap-0" aria-describedby={undefined}>
        <SheetHeader className="pb-2">
          <SheetTitle className="text-sm">
            {initial === '' ? `Comment on line ${line}` : `Edit the comment on line ${line}`}
          </SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {line === null ? null : (
            <Form
              line={line}
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
