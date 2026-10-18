"use client";

import { memo, useCallback, useRef } from "react";
import {
  useAuiState,
  type ReasoningMessagePartComponent,
  type ReasoningGroupComponent,
} from "@assistant-ui/react";
import { useDisclosureLock } from "@/hooks/use-disclosure-lock";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  ANIMATION_DURATION,
  ReasoningRoot as ReasoningRootBase,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
  reasoningVariants,
  type ReasoningRootProps,
} from "./reasoning";

export type { ReasoningRootProps } from "./reasoning";

/**
 * `ReasoningRoot` with the thread viewport scroll locked during disclosure animations.
 *
 * @param props The props of the reasoning root, with its ref and its animation start handler.
 */
function ReasoningRoot({
  ref,
  onAnimationStart,
  ...props
}: ReasoningRootProps) {
  const collapsibleRef = useRef<HTMLDivElement | null>(null);
  // Boxes edit: skips the lock while the thread follows its output.
  const lockScroll = useDisclosureLock(collapsibleRef, ANIMATION_DURATION);

  const handleAnimationStart = useCallback(() => {
    lockScroll();
    onAnimationStart?.();
  }, [lockScroll, onAnimationStart]);

  const composedRef = useCallback(
    (node: HTMLDivElement | null) => {
      collapsibleRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  return (
    <ReasoningRootBase
      ref={composedRef}
      onAnimationStart={handleAnimationStart}
      {...props}
    />
  );
}

/** One reasoning part, rendered as markdown. */
const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

/**
 * A collapsible block around consecutive reasoning parts. The trigger shows activity while one of the parts streams.
 *
 * @param children The reasoning parts.
 * @param startIndex The index of the first part of the group in the message.
 * @param endIndex The index of the last part of the group in the message.
 */
const ReasoningGroupImpl: ReasoningGroupComponent = ({
  children,
  startIndex,
  endIndex,
}) => {
  const isReasoningStreaming = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    for (let index = startIndex; index <= endIndex; index++) {
      if (s.message.parts[index]?.status.type === "running") return true;
    }
    return false;
  });

  return (
    <ReasoningRoot streaming={isReasoningStreaming}>
      <ReasoningTrigger active={isReasoningStreaming} />
      <ReasoningContent aria-busy={isReasoningStreaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

/** The reasoning part component, with the parts of the block attached for custom layouts. */
const Reasoning = memo(
  ReasoningImpl,
) as unknown as ReasoningMessagePartComponent & {
  /** The root part. */
  Root: typeof ReasoningRoot;
  /** The row that opens and closes the block. */
  Trigger: typeof ReasoningTrigger;
  /** The collapsible panel. */
  Content: typeof ReasoningContent;
  /** The reasoning text part. */
  Text: typeof ReasoningText;
  /** The edge fade part. */
  Fade: typeof ReasoningFade;
};

Reasoning.displayName = "Reasoning";
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;
Reasoning.Fade = ReasoningFade;

/**
 * The memoized reasoning group.
 *
 * @deprecated The wrapper is for the legacy `components.ReasoningGroup` prop of
 * `MessagePrimitive.Parts`. Use `MessagePrimitive.GroupedParts` with a `groupBy`
 * that returns `"group-reasoning"`, and compose `ReasoningRoot`, `ReasoningTrigger`,
 * `ReasoningContent` and `ReasoningText` directly.
 */
const ReasoningGroup = memo(ReasoningGroupImpl);
ReasoningGroup.displayName = "ReasoningGroup";

export {
  Reasoning,
  ReasoningGroup,
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
  reasoningVariants,
};
