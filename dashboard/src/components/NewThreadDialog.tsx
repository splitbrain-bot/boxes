import type { ThreadOptions as ThreadOptionsBody } from '../../../shared/types.ts';
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

/**
 * Dialog that starts a new thread in a box.
 *
 * The agent of a thread is fixed for the life of its transcript, so the
 * dialog asks before the thread starts. Escape, the backdrop and the back
 * button all cancel.
 */
export function NewThreadDialog({
  busy,
  onCancel,
  onCreate,
}: {
  /** Whether a create is in flight. A double tap then cannot start two threads. */
  busy: boolean;
  /** Called when the dialog closes without starting a thread. */
  onCancel: () => void;
  /**
   * Starts the thread and resolves with whether it started. Undefined options
   * start it on the orchestrator's defaults.
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
            // An earlier create would take the orchestrator's default agent. A
            // failed list also counts as ready, and the thread then starts on
            // the orchestrator's defaults.
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
