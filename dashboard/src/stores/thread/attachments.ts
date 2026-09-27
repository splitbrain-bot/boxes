import { generateId, type AttachmentAdapter, type PendingAttachment } from '@assistant-ui/react';
import { api } from '../../api.ts';

/** Which of assistant-ui's three tiles a file is shown as. */
function kindOf(type: string): PendingAttachment['type'] {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/') || type === 'application/pdf' || type === 'application/json') {
    return 'document';
  }
  return 'file';
}

/**
 * Builds the composer's attachment adapter for one box.
 *
 * Every file is uploaded into the box's workspace, and the prompt carries
 * only its path, so the agent opens it with its own tools. The upload runs
 * on send, so a file the user removes again never reaches the workspace.
 *
 * `onError` reports a failed upload, because the send button does not await
 * the upload.
 */
export function createAttachmentAdapter(
  boxId: string,
  onError: (message: string) => void,
): AttachmentAdapter {
  return {
    // Every type: the agent decides what it can read.
    accept: '*',

    async add({ file }) {
      return {
        id: generateId(),
        type: kindOf(file.type),
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        file,
        status: { type: 'requires-action', reason: 'composer-send' },
      };
    },

    async send(attachment) {
      try {
        const stored = await api.uploadAttachment(boxId, attachment.file);
        return {
          ...attachment,
          status: { type: 'complete' },
          // `sourceType: 'id'` marks the workspace path as a reference, not
          // the bytes.
          content: [
            {
              type: 'file' as const,
              data: stored.path,
              mimeType: attachment.contentType || 'application/octet-stream',
              filename: stored.name,
              sourceType: 'id' as const,
            },
          ],
        };
      } catch (err) {
        onError(`${attachment.name}: ${(err as Error).message}`);
        throw err;
      }
    },

    // Nothing to undo: a removed attachment was never uploaded.
    async remove() {},
  };
}
