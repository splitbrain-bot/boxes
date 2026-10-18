import { type AttachmentAdapter, generateId, type PendingAttachment } from '@assistant-ui/react';
import { api } from '../../api.ts';

/**
 * Picks the assistant-ui tile type that shows a file.
 *
 * @param type The MIME type of the file.
 * @returns The tile type.
 */
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
 * @param boxId The id of the box.
 * @param onError Receives the message of a failed upload. The send button does
 *   not await the upload, so the adapter reports the failure itself.
 * @returns The attachment adapter.
 */
export function createAttachmentAdapter(
  boxId: string,
  onError: (message: string) => void,
): AttachmentAdapter {
  return {
    // Accepts every type, because the agent decides what it can read.
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

    // Has nothing to undo, because the upload runs only on send.
    async remove() {},
  };
}
