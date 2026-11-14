import { TextMessagePartProvider } from '@assistant-ui/react';
import { MarkdownText } from '@/components/assistant-ui/elements/markdown-text';
import { WORKSPACE_DIR } from '@/lib/files';

/**
 * The pane that shows a markdown file of the review rendered, as the thread shows a message.
 *
 * @param path The workspace-relative path of the file.
 * @param content The markdown text.
 */
export function MarkdownPreview({
  path,
  content,
}: {
  /** The workspace-relative path of the file. */
  path: string;
  /** The markdown text. */
  content: string;
}) {
  // A relative path in the file starts from the directory of the file.
  const baseDir = `${WORKSPACE_DIR}/${path}`.replace(/\/[^/]*$/, '');
  return (
    // The container lets a wide table or code block grow to the width of the pane.
    <div data-slot="review-preview" className="@container min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[44rem] px-4 py-4">
        <TextMessagePartProvider text={content}>
          <MarkdownText baseDir={baseDir} />
        </TextMessagePartProvider>
      </div>
    </div>
  );
}
