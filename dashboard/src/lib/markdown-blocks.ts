/**
 * A rehype plugin that gives the blocks of a rendered markdown file their source lines, so the review can
 * address a block like a row of the code pane.
 */

/** The tags of the block elements that get their source lines. */
const BLOCK_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'tr',
  'blockquote',
  'hr',
  'pre',
  'ul',
  'ol',
  'table',
]);

/** The part of a hast node that the plugin reads and writes. */
interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { line: number }; end: { line: number } };
}

/**
 * Makes the transformer of the plugin.
 *
 * Every block element gets `data-line` with its first source line and `data-line-end` with its last one.
 * Each element at the top of the tree is wrapped in a div with `data-block` set to the tag of the element and
 * the same two attributes, so one component can render the frame of every block.
 *
 * @returns The transformer, which changes the tree in place.
 */
export function rehypeBlocks(): (tree: unknown) => void {
  return (tree) => {
    const root = tree as Node;
    if (!root.children) return;
    mark(root.children);
    root.children = root.children.map((child) => (child.type === 'element' ? wrap(child) : child));
  };
}

/**
 * Writes the source lines of each block element in a subtree.
 *
 * @param nodes The nodes to walk.
 */
function mark(nodes: Node[]): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    if (node.tagName && BLOCK_TAGS.has(node.tagName))
      Object.assign(node, { properties: lines(node) });
    if (node.children) mark(node.children);
  }
}

/**
 * Gives the properties of an element with its source lines added.
 *
 * @param node The element.
 * @returns The properties, with the lines when the element has a position.
 */
function lines(node: Node): Record<string, unknown> {
  const properties = { ...node.properties };
  if (node.position) {
    properties.dataLine = node.position.start.line;
    properties.dataLineEnd = node.position.end.line;
  }
  return properties;
}

/**
 * Wraps a top level element in the block div.
 *
 * @param node The element.
 * @returns The div, with the element as its only child.
 */
function wrap(node: Node): Node {
  const { dataLine, dataLineEnd } = lines(node);
  return {
    type: 'element',
    tagName: 'div',
    properties: { dataBlock: node.tagName, dataLine, dataLineEnd },
    children: [node],
    position: node.position,
  };
}
