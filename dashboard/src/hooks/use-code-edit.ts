import { useCallback, useEffect, useState } from 'react';
import { tokenizeLines, type Token } from '@/lib/highlight';
import type { OpenFile } from '../stores/review.ts';

/**
 * The buffer behind edit mode, and the colours it is painted with.
 *
 * A review is mostly reading, so the buffer only exists while somebody is
 * editing: null is the reading state, and there is no copy of the file lying
 * around to go stale the rest of the time.
 *
 * Nothing here is in the review store. The store holds what the session has —
 * the tree, the open file, the comments — and a half-typed line is not that.
 * What the store does need to know is whether there is one, because refetching
 * over unsaved work would throw it away; the view tells it.
 */

/** How long typing has to pause before the file is coloured again. */
const RECOLOUR_AFTER = 150;

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
  change: (text: string) => void;
  /** Puts the file back as it was last read, without leaving edit mode. */
  revert: () => void;
}

/**
 * Holds one file's buffer for as long as it is being edited.
 *
 * Dirty is the buffer against the file rather than a flag of its own, so
 * saving clears it by the fact of the file coming back as what was typed, and
 * typing a line back to what it was clears it too.
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

  // A buffer belongs to the file it was opened from, so closing that file or
  // opening another one ends the edit rather than carrying the text across.
  useEffect(() => {
    setText(null);
  }, [path]);

  /**
   * Colours the buffer again once typing stops.
   *
   * On a delay because tokenizing a long file on a phone is not something to
   * do per keystroke, and it is not needed per keystroke either: the pane
   * renders a line it has no current colours for as plain text, so what the
   * reader sees is the line they are typing losing its colour for a moment
   * and getting it back.
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
    // The file's own colours to begin with, because the buffer starts as the
    // file: there is nothing to wait for and nothing to recompute.
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
