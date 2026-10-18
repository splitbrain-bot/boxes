'use client';

import { useState } from 'react';

/** The options of {@link useCopyToClipboard}. */
export type UseCopyToClipboardOptions = {
  /** The time that `isCopied` stays true after a copy, in milliseconds. */
  copiedDuration?: number;
};

/**
 * Copies text to the clipboard and marks the copy for a short time.
 *
 * @param options The copy options.
 * @returns `isCopied`, which is true for a short time after a copy, and `copyToClipboard`.
 */
export const useCopyToClipboard = ({ copiedDuration = 3000 }: UseCopyToClipboardOptions = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  /**
   * Copies a non-empty value when the browser has a clipboard API.
   *
   * @param value The text to copy.
   */
  const copyToClipboard = (value: string) => {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    navigator.clipboard.writeText(value).then(
      () => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), copiedDuration);
      },
      () => {},
    );
  };

  return { isCopied, copyToClipboard };
};
