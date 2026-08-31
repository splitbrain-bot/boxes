import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

/**
 * Writing a comment on a line.
 *
 * Inline under the line on a pointer, and a bottom sheet on touch — the
 * keyboard is coming up anyway, and a textarea halfway down a scrolling code
 * pane ends up behind it. Both render the same form, so there is one place
 * where "what a comment is" is decided.
 *
 * The two arrangements are chosen by CSS presence rather than by a media
 * query in JavaScript: the view renders whichever one its breakpoint shows, so
 * a resize cannot leave the wrong one mounted.
 */

/** The form both arrangements render. */
function Form({
  line,
  initial,
  busy,
  autoFocus,
  onSave,
  onCancel,
}: {
  line: number;
  /** The existing comment when editing, or '' when writing a new one. */
  initial: string;
  busy: boolean;
  autoFocus: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);

  // A fresh line means a fresh comment: the same composer is reused for the
  // next line, and it must not keep the last one's text.
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
          // Enter makes a paragraph in a comment, so submitting is the
          // modifier — the convention every composer in this app follows.
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
          ⌘↵ to save, Esc to cancel
        </span>
      </div>
    </div>
  );
}

/** The inline arrangement, under the annotated line. */
export function InlineComposer(props: {
  line: number;
  initial: string;
  busy: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-md border bg-card p-2">
      <Form {...props} autoFocus />
    </div>
  );
}

/** The touch arrangement: a bottom sheet, which the keyboard can sit under. */
export function ComposerSheet({
  line,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  /** The line being commented on, or null when the sheet is closed. */
  line: number | null;
  initial: string;
  busy: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
}) {
  return (
    <Sheet open={line !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <SheetContent side="bottom" className="gap-0">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-sm">
            {initial === '' ? `Comment on line ${line}` : `Edit the comment on line ${line}`}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Saved into REVIEW.md in the workspace, where the agent can read it.
          </SheetDescription>
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
