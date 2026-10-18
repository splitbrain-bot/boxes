"use client";

import { memo, useCallback, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  XCircleIcon,
} from "lucide-react";
import {
  useToolCallElapsed,
  type ToolApprovalOption,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useDisclosureLock } from "@/hooks/use-disclosure-lock";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";

/** The duration of the disclosure animation, in milliseconds. */
const ANIMATION_DURATION = 200;

/** The class that shrinks a button a little while it is pressed. */
const pressable = "active:scale-[0.98]";

/** The props of {@link ToolFallbackRoot}. */
export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  /** The open state, for a controlled disclosure. */
  open?: boolean;
  /** Called with the new open state when the user toggles the disclosure. */
  onOpenChange?: (open: boolean) => void;
  /** The open state at mount, for an uncontrolled disclosure. */
  defaultOpen?: boolean;
};

/**
 * The collapsible root of one tool call, with the viewport scroll locked while it animates.
 *
 * @param props The open state props, the classes, the content and the other collapsible props.
 */
function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  // Boxes edit: skips the lock while the thread follows its output.
  const lockScroll = useDisclosureLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        className,
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

/** The status type of a tool call. */
type ToolStatus = ToolCallMessagePartStatus["type"];

/** The trigger icon for each tool status. Boxes edit: a running call shows the spinner of the dashboard. */
const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: Spinner,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

/**
 * Formats the run time of a tool call.
 *
 * @param ms The run time in milliseconds.
 * @returns "<1s" below one second, tenths of a second below ten seconds, whole
 *   seconds below a minute, and minutes with seconds after that.
 */
const formatToolDuration = (ms: number) => {
  if (ms < 1000) return "<1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

/**
 * The run time of the tool call, or nothing while the runtime does not know it.
 *
 * @param className Extra classes.
 * @param props The other span props.
 */
function ToolFallbackDuration({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        "aui-tool-fallback-duration text-muted-foreground text-xs tabular-nums",
        className,
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

/**
 * The row that names the tool call and its status, and opens its details.
 *
 * @param toolName The name of the tool.
 * @param status The status of the call. Absent counts as complete.
 * @param asking True when this call puts a question to the user.
 * @param className Extra classes.
 * @param props The other collapsible trigger props.
 */
function ToolFallbackTrigger({
  toolName,
  status,
  asking,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  /** The name of the tool. */
  toolName: string;
  /** The status of the call. Absent counts as complete. */
  status?: ToolCallMessagePartStatus;
  /** True when this call puts a question to the user. */
  asking?: boolean;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];
  // Boxes edit: a call with no result inherits the status of its message, so
  // requires-action alone does not mean the call wants to run. `asking` tells
  // the two apart.
  const label = isCancelled
    ? "Cancelled tool"
    : statusType === "requires-action"
      ? asking
        ? "Wants to run"
        : "Unfinished tool"
      : isRunning
        ? "Running tool"
        : "Used tool";

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]",
        className,
      )}
      {...props}
    >
      {/* Boxes edit: no animate-spin, because the spinner of the dashboard animates itself. */}
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          isCancelled && "text-muted-foreground",
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper inline-block text-start leading-none",
          isCancelled && "text-muted-foreground line-through",
          isRunning && "shimmer motion-reduce:animate-none",
        )}
      >
        {label}: <b>{toolName}</b>
      </span>
      <ToolFallbackDuration />
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          "-rotate-90",
          "group-data-open/trigger:rotate-0",
          "group-data-panel-open/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

/**
 * The collapsible panel with the details of the tool call.
 *
 * @param className Extra classes.
 * @param children The details.
 * @param props The other collapsible content props.
 */
function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex flex-col gap-2 ps-6 pt-1 pb-2 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:blur-in-[2px] group-data-open/collapsible-content:slide-in-from-top-1",
          "group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:blur-out-[2px] group-data-closed/collapsible-content:slide-out-to-top-1",
          "group-data-closed/collapsible-content:animation-duration-(--animation-duration) group-data-open/collapsible-content:animation-duration-(--animation-duration)",
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

/**
 * The arguments of the tool call as text. It renders nothing without arguments.
 *
 * @param argsText The arguments as text.
 * @param className Extra classes.
 * @param props The other div props.
 */
function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  /** The arguments as text. */
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args", className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value bg-muted/50 text-foreground/90 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {argsText}
      </pre>
    </div>
  );
}

/**
 * The result of the tool call. A result that is not a string shows as JSON.
 * It renders nothing without a result.
 *
 * @param result The result of the call.
 * @param className Extra classes.
 * @param props The other div props.
 */
function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  /** The result of the call. */
  result?: unknown;
}) {
  if (result === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result", className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-muted-foreground text-xs font-medium">
        Result:
      </p>
      <pre className="aui-tool-fallback-result-content bg-muted/50 text-foreground/90 mt-1 rounded-md p-2.5 text-xs whitespace-pre-wrap">
        {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

/**
 * The error or the cancel reason of an incomplete tool call. It renders nothing
 * for another status or without an error.
 *
 * @param status The status of the call.
 * @param className Extra classes.
 * @param props The other div props.
 */
function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  /** The status of the call. */
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isCancelled = status.reason === "cancelled";
  const headerText = isCancelled ? "Cancelled reason:" : "Error:";

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">
        {errorText}
      </p>
    </div>
  );
}

/** The result that an Allow adds to a call without an approval request or an interrupt. */
const APPROVED_RESULT = "Approved by user";
/** The result that a Deny adds to a call without an approval request or an interrupt. */
const DENIED_RESULT = "User denied tool execution";

/** The button label for each known approval option kind, for an option without a label. */
const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  "allow-once": "Allow",
  "allow-always": "Always allow",
  "reject-once": "Deny",
  "reject-always": "Always deny",
};

/**
 * Checks if an approval option kind is one of the four known kinds.
 *
 * @param kind The option kind.
 * @returns True for a known kind.
 */
const isKnownKind = (kind: string) =>
  Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, kind);

/**
 * Checks if an approval option kind allows the call.
 *
 * @param kind The option kind.
 * @returns True for "allow-once" and "allow-always".
 */
const isAllowKind = (kind: string) =>
  kind === "allow-once" || kind === "allow-always";

/**
 * Gives the button label of an approval option.
 *
 * @param option The option.
 * @returns The label of the option, else the default label of its kind, else its id.
 */
const approvalOptionLabel = (option: ToolApprovalOption) =>
  option.label ??
  (isKnownKind(option.kind)
    ? APPROVAL_OPTION_DEFAULT_LABELS[option.kind]
    : undefined) ??
  option.id;

/**
 * Checks if the approval controls have something to answer.
 *
 * @param status The status of the call.
 * @param approval The approval request of the call, if any.
 * @param interrupt The interrupt of the call, if any.
 * @returns False only for the status requires-action with the reason interrupt, when the call has no approval
 *   request and no interrupt.
 */
const offersInterruptAction = (
  status: ToolCallMessagePartStatus | undefined,
  approval: ToolCallMessagePart["approval"],
  interrupt: ToolCallMessagePart["interrupt"],
) =>
  status?.type !== "requires-action" ||
  status.reason !== "interrupt" ||
  approval != null ||
  interrupt != null;

/**
 * Checks if this call waits for an answer from the user.
 *
 * Boxes edit: the runtime derives the status of a part from its message, so a
 * call that never reported back looks the same as a call that waits on a
 * permission decision. The tool runs in the box, so Allow and Deny in the
 * browser cannot answer a call that never reported back.
 *
 * @param approval The approval request of the call, if any.
 * @param interrupt The interrupt of the call, if any.
 * @returns True when the call waits on the user.
 */
const isAskingUser = (
  approval: ToolCallMessagePart["approval"],
  interrupt: ToolCallMessagePart["interrupt"],
) =>
  interrupt != null ||
  (approval != null &&
    approval.approved === undefined &&
    approval.resolution === undefined);

/**
 * The controls that answer a tool call that asks the user. They offer the
 * declared options, a confirmation step for an option that asks for one, or
 * Allow and Deny. They hide after an answer.
 *
 * @param className Extra classes.
 * @param addResult Adds a result to a call without an approval request or an interrupt.
 * @param resume Answers an interrupt.
 * @param interrupt The interrupt of the call, if any.
 * @param approval The approval request of the call, if any.
 * @param respondToApproval Answers the approval request.
 * @param status The status of the call.
 * @param props The other div props.
 */
function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  status,
  ...props
}: React.ComponentProps<"div"> &
  Partial<
    Pick<
      ToolCallMessagePartProps,
      "addResult" | "resume" | "respondToApproval" | "status"
    >
  > & {
    /** The interrupt of the call, if any. */
    interrupt?: ToolCallMessagePart["interrupt"];
    /** The approval request of the call, if any. */
    approval?: ToolCallMessagePart["approval"];
  }) {
  const [submitted, setSubmitted] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (
    approval != null &&
    (approval.approved !== undefined || approval.resolution !== undefined)
  )
    return null;

  if (!offersInterruptAction(status, approval, interrupt)) return null;

  // A declared option list limits the choices. The component adds no way to
  // approve beyond the list, and it always keeps a way to refuse.
  const declaredOptions = respondToApproval ? approval?.options : undefined;

  const respond = (approved: boolean) => {
    if (submitted) return;
    if (
      approval != null &&
      approval.approved === undefined &&
      respondToApproval
    ) {
      respondToApproval({ approved });
    } else if (interrupt) {
      resume?.({ approved });
    } else if (
      status?.type === "requires-action" &&
      status.reason === "interrupt"
    ) {
      return;
    } else {
      addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
    }
    setSubmitted(true);
  };

  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return;
    // The runtime cannot derive a decision from a custom kind, and it throws
    // when the answer has none. A picked option is an answer, so it counts as approved.
    respondToApproval?.(
      isKnownKind(option.kind)
        ? { optionId: option.id }
        : { optionId: option.id, approved: true },
    );
    setSubmitted(true);
    setConfirmingId(null);
  };

  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) {
      setConfirmingId(option.id);
    } else {
      respondWithOption(option);
    }
  };

  const confirming =
    confirmingId != null
      ? declaredOptions?.find((o) => o.id === confirmingId)
      : undefined;

  if (confirming) {
    const confirmMeta =
      typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const confirmDescription =
      confirmMeta?.description ?? confirming.description;
    return (
      <div
        data-slot="tool-fallback-approval-confirm"
        className={cn(
          "aui-tool-fallback-approval-confirm flex flex-col gap-2 pt-1",
          className,
        )}
        {...props}
      >
        <p className="aui-tool-fallback-approval-confirm-title font-semibold">
          {confirmMeta?.title ?? `${approvalOptionLabel(confirming)}?`}
        </p>
        {confirmDescription && (
          <p className="aui-tool-fallback-approval-confirm-description text-muted-foreground">
            {confirmDescription}
          </p>
        )}
        {confirming.grants && confirming.grants.length > 0 && (
          <ul className="aui-tool-fallback-approval-confirm-grants flex flex-col gap-1">
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code className="aui-tool-fallback-approval-confirm-grant bg-muted rounded px-1.5 py-0.5 text-xs">
                  {grant}
                </code>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className={pressable}
            onClick={() => respondWithOption(confirming)}
            disabled={submitted}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={pressable}
            onClick={() => setConfirmingId(null)}
            disabled={submitted}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = declaredOptions.filter((o) => isAllowKind(o.kind));
    const customOptions = declaredOptions.filter((o) => !isKnownKind(o.kind));
    const rejectOptions = declaredOptions.filter(
      (o) => isKnownKind(o.kind) && !isAllowKind(o.kind),
    );
    return (
      <div
        data-slot="tool-fallback-approval"
        className={cn(
          "aui-tool-fallback-approval flex flex-wrap items-center gap-2 pt-1",
          className,
        )}
        {...props}
      >
        {[...allowOptions, ...customOptions, ...rejectOptions].map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option === allowOptions[0] ? "default" : "outline"}
            className={pressable}
            onClick={() => handleOption(option)}
            disabled={submitted}
          >
            {approvalOptionLabel(option)}
          </Button>
        ))}
        {rejectOptions.length === 0 && (
          <Button
            size="sm"
            variant="outline"
            className={pressable}
            onClick={() => respond(false)}
            disabled={submitted}
          >
            Deny
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      data-slot="tool-fallback-approval"
      className={cn(
        "aui-tool-fallback-approval flex items-center gap-2 pt-1",
        className,
      )}
      {...props}
    >
      <Button
        size="sm"
        className={pressable}
        onClick={() => respond(true)}
        disabled={submitted}
      >
        Allow
      </Button>
      <Button
        size="sm"
        variant="outline"
        className={pressable}
        onClick={() => respond(false)}
        disabled={submitted}
      >
        Deny
      </Button>
    </div>
  );
}

/**
 * One tool call with its row, arguments and result, and the approval controls when it asks the user.
 *
 * @param toolName The name of the tool.
 * @param argsText The arguments as text.
 * @param result The result of the call.
 * @param status The status of the call.
 * @param addResult Adds a result to the call.
 * @param resume Answers an interrupt.
 * @param interrupt The interrupt of the call, if any.
 * @param approval The approval request of the call, if any.
 * @param respondToApproval Answers the approval request.
 */
const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const isRequiresAction = status?.type === "requires-action";
  // Boxes edit: the status alone does not show that the call waits on the user.
  const asking = isAskingUser(approval, interrupt);
  const shouldRenderApproval =
    isRequiresAction && asking && offersInterruptAction(status, approval, interrupt);

  // Boxes edit: the card opens when the call asks the user, not on the status
  // alone, because an unfinished call holds nothing to act on.
  const [open, setOpen] = useState(asking);
  const [prevAsking, setPrevAsking] = useState(asking);
  if (asking !== prevAsking) {
    setPrevAsking(asking);
    if (asking) setOpen(true);
  }

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={status} asking={asking} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs
          argsText={argsText}
          className={cn(isCancelled && "opacity-60")}
        />
        {shouldRenderApproval && (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
            status={status}
          />
        )}
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

/** The tool call component, with its parts attached for custom layouts. */
const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  /** The root part. */
  Root: typeof ToolFallbackRoot;
  /** The row that opens and closes the block. */
  Trigger: typeof ToolFallbackTrigger;
  /** The collapsible panel. */
  Content: typeof ToolFallbackContent;
  /** The arguments part. */
  Args: typeof ToolFallbackArgs;
  /** The result part. */
  Result: typeof ToolFallbackResult;
  /** The error part. */
  Error: typeof ToolFallbackError;
  /** The approval controls part. */
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
