/** The directory in the box where the agent session starts, and where a relative path in a message starts. */
const WORKSPACE_DIR = '/workspace';

/**
 * The URL that serves the bytes of one file of the box, with a content type from its name.
 *
 * @param boxId The id of the box.
 * @param path The absolute path of the file in the box.
 * @returns The URL path.
 */
export function fileUrl(boxId: string, path: string): string {
  return `/api/boxes/${encodeURIComponent(boxId)}/files/raw?path=${encodeURIComponent(path)}`;
}

/**
 * The URL that serves the bytes of one workspace file.
 *
 * @param boxId The id of the box.
 * @param relPath The workspace-relative path of the file.
 * @returns The URL path.
 */
export function workspaceFileUrl(boxId: string, relPath: string): string {
  return fileUrl(boxId, `${WORKSPACE_DIR}/${relPath}`);
}

/**
 * Finds the file in the box that a URL in a message names.
 *
 * An absolute path and a relative path name a file. A relative path starts
 * from the workspace, because the agent session starts there. A URL with a
 * scheme, and a URL with only a fragment or a query, name no file. The
 * fragment and the query after a path are dropped.
 *
 * @param url The URL from the message.
 * @returns The absolute path of the file in the box, or null when the URL names no file.
 */
export function filePath(url: string): string | null {
  const path = url.replace(/[?#].*$/s, '');
  // A colon before the first slash starts a scheme.
  if (path === '' || /^[^/]*:/.test(path)) return null;
  const absolute = path.startsWith('/') ? path : `${WORKSPACE_DIR}/${path.replace(/^(\.\/)+/, '')}`;
  try {
    return decodeURIComponent(absolute);
  } catch {
    // A stray percent sign stays as it is.
    return absolute;
  }
}
