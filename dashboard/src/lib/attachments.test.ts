import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  attachmentUrl,
  buildEnvelope,
  formatBytes,
  isThumbnailable,
  parseEnvelope,
} from './attachments.ts';

const ENTRY = {
  path: '.boxes/attachments/shot.png',
  name: 'shot.png',
  mimeType: 'image/png',
  size: '1.2 MB',
};

test('an envelope parses back into the entries it was built from', () => {
  const parsed = parseEnvelope(buildEnvelope([ENTRY]));
  assert.deepEqual(parsed?.entries, [ENTRY]);
});

test('several entries keep their order, their types and their sizes', () => {
  const pdf = {
    path: '.boxes/attachments/report.pdf',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: '840.0 KB',
  };
  const parsed = parseEnvelope(buildEnvelope([ENTRY, pdf]));
  assert.deepEqual(parsed?.entries, [ENTRY, pdf]);
});

test('the name is the last segment of the path, which is what a chip shows', () => {
  const parsed = parseEnvelope(buildEnvelope([ENTRY]));
  assert.equal(parsed?.entries[0]?.name, 'shot.png');
});

test('text around an envelope is kept', () => {
  const text = `before\n${buildEnvelope([ENTRY])}\nafter`;
  const parsed = parseEnvelope(text);
  assert.equal(parsed?.before, 'before');
  assert.equal(parsed?.after, 'after');
});

test('ordinary prose is not an envelope', () => {
  assert.equal(parseEnvelope('have a look at the screenshot'), null);
  // An opening marker with nothing closing it is somebody talking about the
  // format, not using it.
  assert.equal(parseEnvelope('<attachments> what are those?'), null);
});

test('an envelope this build cannot read is left alone as text', () => {
  // A later build's extra field, for example.
  const unknown = '<attachments>\n- a.png (image/png, 1 B, 20 pages)\n</attachments>';
  assert.equal(parseEnvelope(unknown), null);
});

test('sizes are formatted in the units a person would say', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('an attachment is fetched back by name, from its box', () => {
  assert.equal(
    attachmentUrl('abc123', '.boxes/attachments/shot.png'),
    '/api/boxes/abc123/attachments/shot.png',
  );
});

test('only the image types the endpoint serves inline are shown as pictures', () => {
  assert.equal(isThumbnailable('image/png'), true);
  assert.equal(isThumbnailable('IMAGE/JPEG'), true);
  // The endpoint serves SVG inline under a sandboxing CSP.
  assert.equal(isThumbnailable('image/svg+xml'), true);
  // A PDF is not an image, so it stays a chip.
  assert.equal(isThumbnailable('application/pdf'), false);
});
