import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * A modal that asks before an action. Escape, the backdrop and the back button cancel.
 *
 * @param title The question.
 * @param description The effect of the action, as one paragraph.
 * @param children The things that the action affects, below the description.
 * @param confirmLabel The text of the confirm button.
 * @param danger Styles the confirm button as destructive.
 * @param busy Disables both buttons while the action runs.
 * @param onConfirm Called when the user confirms.
 * @param onCancel Called when the user cancels or dismisses the dialog.
 */
export function ConfirmDialog({
  title,
  description,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  /** The question. */
  title: string;
  /** The effect of the action, as one paragraph. */
  description?: string;
  /**
   * The things that the action affects, below the description. A slot, because a list
   * inside the description paragraph would be invalid markup.
   */
  children?: ReactNode;
  /** The text of the confirm button. */
  confirmLabel: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  /** Disables both buttons while the action runs. */
  busy?: boolean;
  /** Called when the user confirms. */
  onConfirm: () => void;
  /** Called when the user cancels or dismisses the dialog. */
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={danger ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
