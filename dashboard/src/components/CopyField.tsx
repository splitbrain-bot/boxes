import { useState } from 'preact/hooks';
import './CopyField.css';

/** A labelled value with a copy button, masked until revealed when asked. */
export function CopyField({
  label,
  value,
  masked = false,
}: {
  label: string;
  value: string;
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
      // Clipboard needs a secure context; reveal the value to be copied by hand.
      setRevealed(true);
    }
  };

  const shown = revealed ? value : '•'.repeat(Math.min(value.length, 32));

  return (
    <div class="CopyField">
      <span class="CopyField-label">{label}</span>
      <div class="CopyField-row">
        <code class="CopyField-value">{shown}</code>
        {masked && !revealed ? (
          <button type="button" class="CopyField-button" onClick={() => setRevealed(true)}>
            Show
          </button>
        ) : null}
        <button
          type="button"
          class={`CopyField-button${copied ? ' CopyField-button--done' : ''}`}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
