import { useCallback, useEffect, useState } from 'react';
import { tokenizeLines, type Token } from '@/lib/highlight';
import type { OpenFile } from '../stores/review.ts';

/** How long typing has to pause, in milliseconds, before the buffer is coloured again. */
const RECOLOUR_AFTER = 150;

/** The edit state of one file, and the actions on it. */
export interface CodeEditing {
  /** The buffer, or null while the file is being read rather than edited. */
  text: string | null;
  /** Tokens for what is on screen, whichever mode that is. */
  tokens: Token[][] | null;
  /** The text those tokens were made from, which typing outruns. */
  tokensFor: string;
  /** Whether the buffer says something the file on disk does not. */
  dirty: boolean;
  /** Starts editing, from the file as it was last read. */
  start: () => void;
  /** Stops editing, discarding whatever is in the buffer. */
  stop: () => void;
  /** Replaces the buffer with what was typed. */
  change: (text: string) => void;
  /** Puts the file back as it was last read, without leaving edit mode. */
  revert: () => void;
}

/**
 * Holds one file's buffer while it is edited, and the colours for it.
 *
 * The buffer is null while the file is read. The hook keeps it out of the
 * review store, which holds only what the box has. The view tells the store
 * about unsaved work, so a refetch does not throw it away.
 *
 * Dirty compares the buffer with the file. A save that returns the typed text
 * clears it, and so does typing the text back to what it was.
 */
export function useCodeEdit(file: OpenFile | null): CodeEditing {
  const [text, setText] = useState<string | null>(null);
  /** The last colours computed, and what they were computed from. */
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
    // The buffer starts as the file, so the file's colours fit it.
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
