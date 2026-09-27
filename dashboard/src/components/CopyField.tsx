import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** A labelled value with a copy button, optionally masked until revealed. */
export function CopyField({
  label,
  value,
  masked = false,
}: {
  /** The label above the value. */
  label: string;
  /** The value to show and copy. */
  value: string;
  /** Hides the value behind dots until the user reveals it. */
  masked?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!masked);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard needs a secure context, so the value is revealed for copying by hand.
      setRevealed(true);
    }
  };

  const shown = revealed ? value : '•'.repeat(Math.min(value.length, 32));

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {shown}
        </code>
        {masked && !revealed ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(true)}>
            Show
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
