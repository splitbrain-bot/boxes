import assert from 'node:assert/strict';
import { test } from 'vitest';
import { filePath, fileUrl, previewKind, workspaceFileUrl } from './files.ts';

test('a file is fetched by its path in the box, from its box', () => {
  assert.equal(
    fileUrl('abc123', '/tmp/cake/slice.png'),
    '/api/boxes/abc123/files/raw?path=%2Ftmp%2Fcake%2Fslice.png',
  );
  assert.equal(
    fileUrl('abc123', '/tmp/cake/slice.png', 7),
    '/api/boxes/abc123/files/raw?path=%2Ftmp%2Fcake%2Fslice.png&view=7',
  );
  assert.equal(
    workspaceFileUrl('abc123', '.boxes/attachments/shot.png'),
    '/api/boxes/abc123/files/raw?path=%2Fworkspace%2F.boxes%2Fattachments%2Fshot.png',
  );
});

test('an absolute path and a relative path name a file in the box', () => {
  assert.equal(filePath('/workspace/docs/chart.png'), '/workspace/docs/chart.png');
  assert.equal(filePath('/tmp/cake/slice.png'), '/tmp/cake/slice.png');
  assert.equal(filePath('/home/agent/shot.png'), '/home/agent/shot.png');
  assert.equal(filePath('docs/chart.png'), '/workspace/docs/chart.png');
  assert.equal(filePath('./chart.png'), '/workspace/chart.png');
  // The markdown parser encodes a space in a URL.
  assert.equal(filePath('my%20chart.png'), '/workspace/my chart.png');
  assert.equal(filePath('notes.md#usage'), '/workspace/notes.md');
});

test('a relative path starts from the base directory, and dot parts are resolved', () => {
  assert.equal(
    filePath('img/chart.png', '/workspace/repo/doc'),
    '/workspace/repo/doc/img/chart.png',
  );
  assert.equal(
    filePath('../img/chart.png', '/workspace/repo/doc'),
    '/workspace/repo/img/chart.png',
  );
  assert.equal(filePath('/tmp/chart.png', '/workspace/repo/doc'), '/tmp/chart.png');
  assert.equal(filePath('docs/./a//b.png'), '/workspace/docs/a/b.png');
  assert.equal(filePath('../../../chart.png'), '/chart.png');
});

test('images and markdown files have a preview', () => {
  assert.equal(previewKind('doc/chart.PNG'), 'image');
  assert.equal(previewKind('logo.svg'), 'image');
  assert.equal(previewKind('README.md'), 'markdown');
  assert.equal(previewKind('notes.markdown'), 'markdown');
  assert.equal(previewKind('main.ts'), null);
  assert.equal(previewKind('Makefile'), null);
  assert.equal(previewKind('.md/notes'), null);
});

test('a URL with a scheme, or without a path, names no file', () => {
  for (const url of [
    'https://example.com/chart.png',
    'mailto:someone@example.com',
    'data:image/png;base64,AAAA',
    '#usage',
    '?page=2',
  ]) {
    assert.equal(filePath(url), null, url);
  }
});
