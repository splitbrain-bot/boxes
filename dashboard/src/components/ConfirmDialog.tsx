import type { ComponentChildren } from 'preact';
import './ConfirmDialog.css';

/** A modal that asks before an action. A click on the backdrop cancels. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      class="ConfirmDialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div class="ConfirmDialog" role="dialog" aria-modal="true" aria-label={title}>
        <div class="ConfirmDialog-title">{title}</div>
        <div class="ConfirmDialog-body">{children}</div>
        <div class="ConfirmDialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            class={danger ? 'ConfirmDialog-danger' : undefined}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
