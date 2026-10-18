import { useCallback, useEffect, useState } from 'react';
import { type Token, tokenizeLines } from '@/lib/highlight';
import type { OpenFile } from '../stores/review.ts';

/** The typing pause in milliseconds after which the hook colours the buffer again. */
const RECOLOUR_AFTER = 150;

/** The edit state of one file, and the actions on it. */
export interface CodeEditing {
  /** The buffer, or null while the reader views the file and does not edit it. */
  text: string | null;
  /** Tokens for the text on screen, in both modes. */
  tokens: Token[][] | null;
  /** The text that the tokens were made from. While the reader types, this text lags behind the buffer. */
  tokensFor: string;
  /**
   * True when the buffer differs from the file as it was last read.
   *
   * A save that returns the typed text clears the flag. Typing the original text again also clears it.
   */
  dirty: boolean;
  /** Starts editing, from the file as it was last read. */
  start: () => void;
  /** Stops editing, discarding whatever is in the buffer. */
  stop: () => void;
  /** Replaces the buffer with the typed text. */
  change: (text: string) => void;
  /** Resets the buffer to the file as it was last read, and stays in edit mode. */
  revert: () => void;
}

/**
 * Holds the buffer of one file while the reader edits it, and the colours for the buffer.
 *
 * The hook keeps the buffer out of the review store, which holds only the files of the workspace. The view tells the
 * store about unsaved work, so a refetch does not discard it.
 *
 * @param file The open file, or null when no file is open.
 * @returns The edit state of the file and the actions on it.
 */
export function useCodeEdit(file: OpenFile | null): CodeEditing {
  const [text, setText] = useState<string | null>(null);
  /** The last computed colours, and the text they were computed from. */
  const [painted, setPainted] = useState<{ text: string; tokens: Token[][] | null }>({
    text: '',
    tokens: null,
  });

  const path = file?.path ?? null;
  const content = file?.content ?? '';
  const language = file?.language ?? '';

  // Closing the file or opening another one ends the edit.
  useEffect(() => {
    setText(null);
  }, [path]);

  /*
   * Colours the buffer again once typing pauses, because tokenizing a long
   * file on every keystroke is too slow on a phone. Until then, the pane
   * shows a changed line without colour.
   */
  useEffect(() => {
    if (text === null || text === painted.text) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void tokenizeLines(text, language).then((tokens) => {
        if (!cancelled) setPainted({ text, tokens });
      });
    }, RECOLOUR_AFTER);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, painted.text, language]);

  const start = useCallback(() => {
    // The buffer starts as the file content, so the colours of the file fit it.
    setPainted({ text: content, tokens: file?.tokens ?? null });
    setText(content);
  }, [content, file?.tokens]);

  const stop = useCallback(() => setText(null), []);
  const revert = useCallback(() => setText(content), [content]);

  if (text === null) {
    return {
      text: null,
      tokens: file?.tokens ?? null,
      tokensFor: content,
      dirty: false,
      start,
      stop,
      change: setText,
      revert,
    };
  }
  return {
    text,
    tokens: painted.tokens,
    tokensFor: painted.text,
    dirty: text !== content,
    start,
    stop,
    change: setText,
    revert,
  };
}
