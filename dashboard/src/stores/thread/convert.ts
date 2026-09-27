import type { ThreadMessageLike, ToolApprovalOption } from '@assistant-ui/react';
import { imageSrc, type PermissionOption, type PermissionOptionKind } from './acp-types.ts';
import { attachmentUrl, isThumbnailable } from '../../lib/attachments.ts';
import { TASK_NOTIFICATION_PART } from '../../lib/task-notifications.ts';
import {
  toolOutputText,
  type ApprovalState,
  type AttachmentPart,
  type Message,
  type TaskPart,
  type ToolPart,
} from './translate.ts';

/** Converts the thread's message model into the shape the assistant-ui runtime reads. */

/** The assistant-ui approval kind for each ACP permission kind. */
const KIND: Record<PermissionOptionKind, ToolApprovalOption['kind']> = {
  allow_once: 'allow-once',
  allow_always: 'allow-always',
  reject_once: 'reject-once',
  reject_always: 'reject-always',
};

/** One ACP permission option as an approval option. */
function approvalOption(option: PermissionOption): ToolApprovalOption {
  return {
    id: option.optionId,
    // Passes through a kind this build does not know.
    kind: KIND[option.kind] ?? option.kind,
    label: option.name,
  };
}

/** An approval as the tool-call part carries it. */
function approval(state: ApprovalState): NonNullable<
  Extract<ThreadMessageLike['content'][number] & object, { type: 'tool-call' }>['approval']
> {
  const options = state.options.map(approvalOption);
  const chosen = state.optionId
    ? state.options.find((o) => o.optionId === state.optionId)
    : undefined;
  return {
    id: state.id,
    options,
    ...(state.optionId ? { optionId: state.optionId } : {}),
    ...(chosen ? { approved: chosen.kind.startsWith('allow') } : {}),
    ...(state.resolution ? { resolution: state.resolution } : {}),
  };
}

/** The args object of a tool-call part. */
type JsonObject = NonNullable<
  Extract<ThreadMessageLike['content'][number] & object, { type: 'tool-call' }>['args']
>;

/**
 * A tool call's raw input as an args object.
 *
 * The value arrived as parsed JSON, so the cast needs no validation.
 * Anything that is not a plain object gives empty args.
 */
function asArgs(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/**
 * Whether the permission question on a call is still open.
 *
 * Mirrors the runtime's own test: an approval counts as answered once it
 * carries the option that was picked, or the resolution that cancelled it.
 */
function awaitingApproval(part: ToolPart): boolean {
  const state = part.approval;
  return state !== undefined && state.optionId === undefined && state.resolution === undefined;
}

/** One tool part as a tool-call message part. */
function toolPart(part: ToolPart) {
  const output = toolOutputText(part);
  // A call that awaits permission gets no result, even with content: the
  // runtime treats any result as a finished call and then hides the
  // question. A finished call gets a result even when it is empty.
  const finished =
    !awaitingApproval(part) &&
    (output !== '' || part.status === 'completed' || part.status === 'failed');
  return {
    type: 'tool-call' as const,
    toolCallId: part.toolCallId,
    toolName: part.name ?? part.title,
    args: asArgs(part.rawInput),
    ...(part.rawInput === undefined ? {} : { argsText: JSON.stringify(part.rawInput) }),
    ...(finished ? { result: output } : {}),
    ...(part.status === 'failed' ? { isError: true } : {}),
    ...(part.approval ? { approval: approval(part.approval) } : {}),
  };
}

/** An image source as an image part, in the shape the runtime reads. */
function imagePart(src: string) {
  return { type: 'image' as const, image: src };
}

/**
 * An attached file as a part the thread can draw.
 *
 * An image becomes the picture, loaded from the endpoint that serves the
 * box's workspace. Any other file becomes a chip that links to the same
 * endpoint. `sourceType: 'id'` marks the data as a reference, not the bytes.
 *
 * Without a box id, every file becomes a chip that carries its path.
 */
function attachmentPart(part: AttachmentPart, boxId?: string) {
  if (boxId && isThumbnailable(part.mimeType)) {
    return { type: 'image' as const, image: attachmentUrl(boxId, part.path) };
  }
  return {
    type: 'file' as const,
    data: boxId ? attachmentUrl(boxId, part.path) : part.path,
    mimeType: part.mimeType,
    filename: part.name,
    sourceType: 'id' as const,
  };
}

/**
 * A background task's report, as a data part the thread has a renderer for.
 *
 * The renderer is keyed by `name`, so the part's own `type` is dropped.
 */
function taskPart({ type: _type, ...notification }: TaskPart) {
  return { type: 'data' as const, name: TASK_NOTIFICATION_PART, data: notification };
}

/**
 * The images a tool call produced, as parts that follow the tool-call part.
 *
 * A tool-call part cannot contain an image. The images come from the call's
 * content on every conversion, so an update that replaces the content
 * replaces the images too.
 *
 * An image between two tool calls splits the group that the thread forms
 * from adjacent calls.
 */
function toolImages(part: ToolPart) {
  return part.content.flatMap((c) => {
    if (c.type !== 'content') return [];
    const src = imageSrc(c.content);
    return src ? [imagePart(src)] : [];
  });
}

/**
 * One part of a message, in the shape the runtime reads.
 *
 * The explicit type lets one part convert to several of these.
 */
type ConvertedPart = ThreadMessageLike['content'][number] & object;

/**
 * One message of the model, as the runtime reads it.
 *
 * `boxId` is where attachments load from. Without it, attachments show as
 * chips that carry their path.
 */
export function convertMessage(message: Message, boxId?: string): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.parts.flatMap((part): ConvertedPart[] => {
      if (part.type === 'text') return [{ type: 'text' as const, text: part.text }];
      if (part.type === 'reasoning') return [{ type: 'reasoning' as const, text: part.text }];
      if (part.type === 'image') return [imagePart(part.src)];
      if (part.type === 'attachment') return [attachmentPart(part, boxId)];
      if (part.type === 'task') return [taskPart(part)];
      return [toolPart(part), ...toolImages(part)];
    }),
  };
}
