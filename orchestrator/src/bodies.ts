import { z } from 'zod';
import type { HarnessId } from '../../shared/types.ts';
import { HttpError } from './http-error.ts';

/**
 * What each route that takes a JSON body checks that body against, and the
 * check itself.
 *
 * A body is whatever the client sent. Read without a check, a field that is
 * missing or of the wrong type becomes a cast that misbehaves further in, or
 * a 500 that says nothing the caller can act on. Each schema below states one
 * route's body and nothing more: how long a name may be, whether a revision
 * resolves, whether a box exists, all stay with the code that knows.
 *
 * Unknown fields are dropped rather than refused, so a newer client talking to
 * an older orchestrator is served rather than rejected.
 *
 * The attachment upload has no schema here. It carries raw bytes rather than
 * JSON, and the route checks them itself.
 */

/**
 * Reads a request body, or refuses it with a 400 naming the field and what is
 * wrong with it.
 *
 * A request carrying no body at all is read as an empty object. A route whose
 * fields are all optional therefore takes one, and a route with a required
 * field answers that the field is missing.
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const field = issue.path.join('.');
  throw new HttpError(400, field ? `${field}: ${issue.message}` : issue.message);
}

/** A string that has to carry something, for a field an empty value cannot name. */
const filled = z.string().min(1, 'must not be empty');

/**
 * What a new thread runs: the harness, and its mode and settings when the
 * dialog chose them. Whether the harness is one this deployment has is the
 * box manager's check, which is where the registry is.
 */
const threadOptions = z.object({
  harness: z.custom<HarnessId>((id) => typeof id === 'string', 'must be a string'),
  modeId: z.string().optional(),
  config: z.record(z.string(), z.string()).optional(),
});

/** POST /api/boxes — the box to create, and what its first thread runs. */
export const createBoxBody = z.object({
  name: z.string(),
  profile: z.string().optional(),
  agentSet: z.string().nullable().optional(),
  thread: threadOptions.optional(),
});

/** POST /api/boxes/:id/threads — the conversation to add. */
export const createThreadBody = z.object({
  from: z.string().optional(),
  options: threadOptions.optional(),
});

/** POST /api/boxes/:id/threads/:threadId/done — the mark to set or clear. */
export const threadDoneBody = z.object({
  done: z.boolean(),
});

/**
 * POST /api/boxes/:id/threads/:threadId/background/stop — which process to
 * kill. Without one, everything that thread is running stops.
 */
export const backgroundStopBody = z.object({
  processId: z.string().optional(),
});

/**
 * PUT /api/boxes/:id/review/file — the whole file, and the hash it was read
 * at. An absent hash matches nothing, so the save is refused as a stale one.
 */
export const reviewFileBody = z.object({
  path: filled,
  content: z.string(),
  hash: z.string().optional(),
});

/**
 * PUT /api/boxes/:id/review/annotations — the comment on one line.
 *
 * `line` is coerced, so a client that sends its line number as a string is
 * still understood. Which numbers are lines is the review service's rule.
 */
export const reviewAnnotationBody = z.object({
  path: filled,
  line: z.coerce.number(),
  comment: z.string(),
});

/**
 * PUT /api/boxes/:id/review/base — the revision to compare against. Null
 * and absent both clear the base back to each repository's working tree.
 */
export const reviewBaseBody = z.object({
  rev: z.string().nullable().optional(),
});

/** POST /api/agent-sets — the set to create. */
export const createAgentSetBody = z.object({
  name: z.string(),
});

/** PATCH /api/agent-sets/:setId — the fields to change. An absent one is left alone. */
export const updateAgentSetBody = z.object({
  name: z.string().optional(),
  agentsMd: z.string().optional(),
});

/** PUT /api/agent-sets/:setId/items — the skill or command to write. */
export const agentItemBody = z.object({
  kind: z.enum(['skill', 'command']),
  name: z.string(),
  content: z.string(),
});

/**
 * POST /api/push/subscribe — a browser's push subscription, shaped like its
 * own PushSubscription.toJSON(). Whether the endpoint may be posted to and
 * whether the keys are the right size is the route's own check.
 */
export const pushSubscribeBody = z.object({
  endpoint: z.string(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
  label: z.string().optional(),
});

/** DELETE /api/push/subscribe — the subscription to forget. */
export const pushUnsubscribeBody = z.object({
  endpoint: z.string(),
});

/**
 * PUT /api/credentials/:id — the secret to store and how it was obtained.
 *
 * The method defaults to a pasted token, which is what a settings page that
 * names none is sending. Whether the id is a credential this deployment
 * knows is the route's own check.
 */
export const putCredentialBody = z.object({
  method: z.enum(['token', 'api_key', 'oauth']).default('token'),
  secret: z.string().trim().min(1, 'must not be empty'),
});

/** POST /api/credentials/:id/login/:loginId/code — the code the CLI asked for. */
export const loginCodeBody = z.object({
  code: filled,
});

/** One dialog's remembered choices, as the thread dialog last left them. */
const threadDialogDefaults = z.object({
  modeId: z.string().optional(),
  config: z.record(z.string(), z.string()).optional(),
});

/**
 * PATCH /api/settings — the settings to write.
 *
 * Every field is optional: the git identity and a dialog's last choice are
 * written by different screens, and neither should carry the other's values
 * to be able to save.
 */
export const patchSettingsBody = z.object({
  gitName: z.string().optional(),
  gitEmail: z.string().optional(),
  dialogs: z.record(z.string(), threadDialogDefaults).optional(),
});
