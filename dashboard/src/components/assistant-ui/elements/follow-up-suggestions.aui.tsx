"use client";

import { AuiIf, useAuiState, ThreadPrimitive } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState, type FC } from "react";

/**
 * The suggested follow-up prompts in one row that scrolls sideways. An edge
 * fades out while content is hidden past it. A click sends the prompt.
 */
const FollowupSuggestionsRow: FC = () => {
  const suggestions = useAuiState((s) => s.thread.suggestions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rtlRef = useRef<boolean | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    // In RTL, scrollLeft runs from 0 to -max. The code converts it to the hidden width at each physical edge.
    const fromStart = Math.abs(el.scrollLeft);
    // A getComputedStyle call forces a style recalculation, so the code reads the direction once.
    const rtl = (rtlRef.current ??= getComputedStyle(el).direction === "rtl");
    const [left, right] = rtl
      ? [maxScroll - fromStart, fromStart]
      : [fromStart, maxScroll - fromStart];
    setFades((prev) => {
      const next = { left: left > 1, right: right > 1 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  useEffect(() => {
    updateFades();
    const el = scrollRef.current;
    if (!el?.firstElementChild) return undefined;
    const observer = new ResizeObserver(updateFades);
    observer.observe(el);
    observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [updateFades]);

  const maskImage = `linear-gradient(to right, ${
    fades.left ? "transparent, black 2rem" : "black"
  }, ${fades.right ? "black calc(100% - 2rem), transparent" : "black"})`;

  return (
    <div
      ref={scrollRef}
      onScroll={updateFades}
      // A scrolling overflow-x also clips vertically. The py-1 and -my-1 pair gives the focus rings room and
      // keeps the outer height.
      className="aui-thread-followup-suggestions -my-1 w-full overflow-x-auto py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage, WebkitMaskImage: maskImage }}
    >
      <div className="mx-auto flex min-h-8 w-max items-center gap-2 px-0.5">
        {suggestions.map((suggestion, idx) => (
          <ThreadPrimitive.Suggestion
            key={idx}
            className="aui-thread-followup-suggestion bg-background hover:bg-muted/80 rounded-full border px-3 py-1 text-sm whitespace-nowrap transition-colors ease-in"
            prompt={suggestion.prompt}
            method="replace"
            autoSend
          >
            {suggestion.title ?? suggestion.prompt}
            {suggestion.label && (
              <span className="aui-thread-followup-suggestion-label text-muted-foreground ms-1">
                {suggestion.label}
              </span>
            )}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};

/** The follow-up suggestions, shown after a finished turn when the thread has any. */
export const ThreadFollowupSuggestions: FC = () => (
  <AuiIf
    condition={(s) =>
      !s.thread.isEmpty &&
      !s.thread.isRunning &&
      s.thread.suggestions.length > 0
    }
  >
    <FollowupSuggestionsRow />
  </AuiIf>
);
