import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rehypeBlocks } from './markdown-blocks.ts';

/** A hast node, as the tests build it. */
interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { line: number }; end: { line: number } };
}

/**
 * Makes an element with a position.
 *
 * @param tagName The tag.
 * @param start The first source line.
 * @param end The last source line.
 * @param children The children.
 * @returns The element.
 */
function element(tagName: string, start: number, end: number, children: Node[] = []): Node {
  return {
    type: 'element',
    tagName,
    properties: {},
    children,
    position: { start: { line: start }, end: { line: end } },
  };
}

test('each top level element is wrapped in a block with its lines', () => {
  const tree: Node = {
    type: 'root',
    children: [
      element('h1', 1, 1, [{ type: 'text', value: 'Title' }]),
      { type: 'text', value: '\n' },
      element('p', 3, 4, [{ type: 'text', value: 'two lines' }]),
    ],
  };
  rehypeBlocks()(tree);

  assert.equal(tree.children?.length, 3);
  const [heading, newline, paragraph] = tree.children as Node[];
  assert.equal(newline?.type, 'text');
  assert.equal(heading?.tagName, 'div');
  assert.deepEqual(heading?.properties, { dataBlock: 'h1', dataLine: 1, dataLineEnd: 1 });
  assert.equal(heading?.children?.[0]?.tagName, 'h1');
  assert.deepEqual(heading?.children?.[0]?.properties, { dataLine: 1, dataLineEnd: 1 });
  assert.deepEqual(paragraph?.properties, { dataBlock: 'p', dataLine: 3, dataLineEnd: 4 });
});

test('nested blocks get their lines, and inline elements do not', () => {
  const link = element('a', 6, 6, [{ type: 'text', value: 'link' }]);
  const inner = element('p', 6, 6, [link]);
  const item = element('li', 5, 6, [{ type: 'text', value: 'item' }, inner]);
  const list = element('ul', 5, 6, [item]);
  const tree: Node = { type: 'root', children: [list] };
  rehypeBlocks()(tree);

  assert.deepEqual(list.properties, { dataLine: 5, dataLineEnd: 6 });
  assert.deepEqual(item.properties, { dataLine: 5, dataLineEnd: 6 });
  assert.deepEqual(inner.properties, { dataLine: 6, dataLineEnd: 6 });
  assert.deepEqual(link.properties, {});
});

test('an element without a position keeps its properties and gets no lines', () => {
  const paragraph: Node = {
    type: 'element',
    tagName: 'p',
    properties: { className: ['kept'] },
    children: [],
  };
  const tree: Node = { type: 'root', children: [paragraph] };
  rehypeBlocks()(tree);

  assert.deepEqual(paragraph.properties, { className: ['kept'] });
  assert.deepEqual(tree.children?.[0]?.properties, {
    dataBlock: 'p',
    dataLine: undefined,
    dataLineEnd: undefined,
  });
});
