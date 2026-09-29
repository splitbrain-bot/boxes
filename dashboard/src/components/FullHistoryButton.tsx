import { HistoryIcon } from 'lucide-react';
import { Spinner } from '@/components/Spinner';
import { Button } from '@/components/ui/button';

/**
 * The top of a thread that lacks its oldest messages: a line that says so,
 * and a button that loads the full history.
 */
export function FullHistoryButton({
  loading,
  onLoad,
}: {
  /** True while the full history is loading, which disables the button. */
  loading: boolean;
  /** Loads the full history. */
  onLoad: () => void;
}) {
  return (
    <div
      data-slot="full-history"
      className="mb-6 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground"
    >
      <p>Older messages of this thread are not shown.</p>
      <Button variant="outline" size="sm" disabled={loading} onClick={onLoad}>
        {loading ? <Spinner /> : <HistoryIcon />}
        Load full history
      </Button>
    </div>
  );
}
