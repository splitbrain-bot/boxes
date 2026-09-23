import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { Screen } from './screen.ts';

/**
 * The renderer, against the movements a redrawing UI actually makes.
 *
 * The fixture is a recording of `claude setup-token` in a box container,
 * taken with a code it refused, because the refusal is the one message whose
 * every character is known and whose rendering was provably wrong before.
 */

const ESC = String.fromCharCode(27);
const FIXTURE = join(import.meta.dirname, 'testdata', 'claude-setup-token.bin');

/** The stripping this replaces, kept here to show what it does to the same bytes. */
function stripAnsi(text: string): string {
  return text
    .replace(new RegExp(`${ESC}\\][^\\u0007]*\\u0007`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[[0-9;?>]*[A-Za-z]`, 'g'), '')
    .replace(/\r\n?/g, '\n');
}

test('a character the UI did not resend is still on the screen', () => {
  // The UI writes `c` at one column and `de` two along, leaving the `o` it
  // put there in an earlier frame untouched.
  const screen = new Screen();
  screen.write('the full code was copied');
  screen.write(`\r${ESC}[10Gc${ESC}[12Gde`);
  assert.match(screen.text, /the full code was copied/);
});

test('the real box reads as the sentences it drew', () => {
  const raw = readFileSync(FIXTURE, 'latin1');
  const screen = new Screen();
  // Read the way the flow reads it: the screen after every chunk, because
  // what the flow is looking for may be drawn and then drawn over. The URL
  // and the prompt are both gone from the last frame.
  const frames: string[] = [];
  for (let i = 0; i < raw.length; i += 64) {
    screen.write(raw.slice(i, i + 64));
    frames.push(screen.text);
  }
  const seen = (re: RegExp): boolean => frames.some((f) => re.test(f));

  // What the CLI said, whole. Stripping the escapes loses a letter of it.
  assert.ok(seen(/Invalid code\. Please make sure the full code was copied/));
  assert.ok(!stripAnsi(raw).includes('full code was copied'));

  // And the two things the flow reads off this screen.
  assert.ok(seen(/Paste code here if prompted/));
  assert.ok(seen(/https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/));
});

test('an erase takes back what it covers', () => {
  const screen = new Screen();
  screen.write('keep this');
  screen.write(`\r${ESC}[5G${ESC}[K`);
  assert.equal(screen.text, 'keep');
});

test('a sequence split across chunks is still one sequence', () => {
  const screen = new Screen();
  screen.write('ab');
  screen.write(`${ESC}[`);
  screen.write('1Gz');
  assert.equal(screen.text, 'zb');
});
