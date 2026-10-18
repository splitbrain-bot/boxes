import { ThreadOptions, useThreadOptions } from '@/components/ThreadOptions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ThreadOptions as ThreadOptionsBody } from '../../../shared/types.ts';

/**
 * Dialog that starts a new thread in a box.
 *
 * The agent of a thread is fixed for the life of its transcript, so the
 * dialog asks before the thread starts. Escape, the backdrop and the back
 * button all cancel.
 *
 * @param busy True while a create is in flight. A double tap then cannot start two threads.
 * @param onCancel Called when the dialog closes without starting a thread.
 * @param onCreate Starts the thread and resolves with true when it started. Undefined options start it on the
 *   defaults of the orchestrator.
 */
export function NewThreadDialog({
  busy,
  onCancel,
  onCreate,
}: {
  /** True while a create is in flight. A double tap then cannot start two threads. */
  busy: boolean;
  /** Called when the dialog closes without starting a thread. */
  onCancel: () => void;
  /**
   * Starts the thread and resolves with true when it started. Undefined options
   * start it on the defaults of the orchestrator.
   */
  onCreate: (options: ThreadOptionsBody | undefined) => Promise<boolean>;
}) {
  const state = useThreadOptions();

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New thread</DialogTitle>
          <DialogDescription>
            Another conversation in this box, on the same checkout. It starts empty.
          </DialogDescription>
        </DialogHeader>

        <ThreadOptions state={state} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            // A create before the options are ready uses the default agent of the
            // orchestrator. A failed list also counts as ready.
            disabled={busy || !state.ready}
            onClick={() => {
              void onCreate(state.value ?? undefined).then((created) => {
                if (created) state.remember();
              });
            }}
          >
            {busy ? 'Starting…' : 'Start thread'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
