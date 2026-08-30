import type { ThreadMessageLike, ToolApprovalOption } from '@assistant-ui/react';
import type { PermissionOption, PermissionOptionKind } from './acp-types.ts';
import { toolOutputText, type ApprovalState, type Message, type ToolPart } from './translate.ts';

/**
 * Our message model, in the shape the runtime reads.
 *
 * The two vocabularies line up almost exactly; the only translation with any
 * content is the permission one, and even that is a rename.
 */

/**
 * ACP permission kinds are assistant-ui's approval kinds with underscores.
 * The rest of the option is a rename too: optionId → id, name → label.
 */
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
    // An adapter may offer a kind this build predates; pass it through rather
    // than guessing, which is what the open union is for.
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

/**
 * A tool call's raw input as an args object.
 *
 * The value arrived as JSON over the wire, so it is JSON by construction;
 * the cast says that rather than re-validating a tree we already parsed.
 * Anything that is not a plain object has no args to show.
 */
type JsonObject = NonNullable<
  Extract<ThreadMessageLike['content'][number] & object, { type: 'tool-call' }>['args']
>;

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
  // A call still waiting on its permission question has no result, whatever
  // content it has already sent: what an unapproved edit carries is the diff
  // it proposes, not work it did. The runtime reads any result at all as
  // proof the call finished, and a finished call is never the one being
  // asked about, so reporting one here hides the question and leaves the
  // turn blocked with no way to answer it.
  //
  // An empty result on a finished call is still a result: it says the tool
  // produced nothing, which is different from still running.
  const finished =
    !awaitingApproval(part) &&
    (output !== '' || part.status === 'completed' || part.status === 'failed');
  return {
    type: 'tool-call' as const,
    toolCallId: part.toolCallId,
    // The programmatic name when the adapter sends one, else the title it
    // does send. The header needs something to say either way.
    toolName: part.name ?? part.title,
    args: asArgs(part.rawInput),
    ...(part.rawInput === undefined ? {} : { argsText: JSON.stringify(part.rawInput) }),
    ...(finished ? { result: output } : {}),
    ...(part.status === 'failed' ? { isError: true } : {}),
    ...(part.approval ? { approval: approval(part.approval) } : {}),
  };
}

/** One of our messages, as the runtime reads it. */
export function convertMessage(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.parts.map((part) => {
      if (part.type === 'text') return { type: 'text' as const, text: part.text };
      if (part.type === 'reasoning') return { type: 'reasoning' as const, text: part.text };
      return toolPart(part);
    }),
  };
}
