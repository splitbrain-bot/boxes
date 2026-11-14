/** The directory in the box where the agent session starts, and where a relative path in a message starts. */
export const WORKSPACE_DIR = '/workspace';

/**
 * The URL that serves the bytes of one file of the box, with a content type from its name.
 *
 * @param boxId The id of the box.
 * @param path The absolute path of the file in the box.
 * @param view A number that makes the URL different from the URL of an earlier view of the same file, so the
 *   browser loads the file again. Undefined for a URL without it.
 * @returns The URL path.
 */
export function fileUrl(boxId: string, path: string, view?: number): string {
  const query = `path=${encodeURIComponent(path)}${view === undefined ? '' : `&view=${view}`}`;
  return `/api/boxes/${encodeURIComponent(boxId)}/files/raw?${query}`;
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

/** The file types that the review shows like the thread does, by file extension in lower case. */
const PREVIEW_KINDS: Readonly<Record<string, 'image' | 'markdown'>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  md: 'markdown',
  markdown: 'markdown',
};

/**
 * Finds how the review previews a file.
 *
 * @param path The path of the file.
 * @returns "image" for the lightbox, "markdown" for the rendered text, or null for a file without a preview.
 */
export function previewKind(path: string): 'image' | 'markdown' | null {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return (extension && PREVIEW_KINDS[extension]) || null;
}

/**
 * Finds the file in the box that a URL in markdown names.
 *
 * An absolute path and a relative path name a file. A relative path starts
 * from a base directory, which is the workspace for a message, because the
 * agent session starts there. A URL with a scheme, and a URL with only a
 * fragment or a query, name no file. The fragment and the query after a path
 * are dropped.
 *
 * @param url The URL from the markdown.
 * @param baseDir The absolute directory where a relative path starts.
 * @returns The absolute path of the file in the box, or null when the URL names no file.
 */
export function filePath(url: string, baseDir = WORKSPACE_DIR): string | null {
  const path = url.replace(/[?#].*$/s, '');
  // A colon before the first slash starts a scheme.
  if (path === '' || /^[^/]*:/.test(path)) return null;
  const absolute = normalizePath(path.startsWith('/') ? path : `${baseDir}/${path}`);
  try {
    return decodeURIComponent(absolute);
  } catch {
    // A stray percent sign stays as it is.
    return absolute;
  }
}

/**
 * Removes the "." and ".." parts and the empty parts from an absolute path, because the file service refuses them.
 *
 * @param path The absolute path.
 * @returns The path without those parts. A ".." at the root stays at the root.
 */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '' && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}
