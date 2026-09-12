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
 * What a box's next conversation is started as.
 *
 * A dialog rather than a button that starts one straight away, because a
 * thread is not a thing you change your mind about afterwards: the agent it
 * runs is fixed for the life of the transcript, and a mode picked after the
 * first prompt is a mode picked late. It opens on the last choice for that
 * agent, so the deployment that mostly starts the same kind of thread
 * confirms rather than configures.
 *
 * Escape, the backdrop and the back button all cancel — see `ui/dialog`,
 * which pushes a history entry so the phone's own dismiss gesture works.
 */
export function NewThreadDialog({
  busy,
  onCancel,
  onCreate,
}: {
  /** Held while the create is in flight, so a double tap cannot start two. */
  busy: boolean;
  onCancel: () => void;
  /** Absent options means the orchestrator's own defaults; see ThreadOptions. */
  onCreate: (options: ThreadOptionsBody | undefined) => void;
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
            // Nothing to start until the list has said what can run: a create
            // sent before then would take the orchestrator's default agent
            // rather than the one this dialog is about to show. A list that
            // could not be read is still an answer — the thread starts on the
            // orchestrator's defaults, which is what the block says.
            disabled={busy || !state.ready}
            onClick={() => {
              state.remember();
              onCreate(state.value ?? undefined);
            }}
          >
            {busy ? 'Starting…' : 'Start thread'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
