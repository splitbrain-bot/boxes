import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import {
  annotationCounts,
  checkDrift,
  contextAround,
  deleteAnnotation,
  detectLang,
  parseReview,
  serializeReview,
  setAnnotation,
  todayStamp,
  type Annotation,
  type Review,
} from './store.ts';

/**
 * The REVIEW.md contract, against the implementation that defines it.
 *
 * `fixtures/` holds REVIEW.md files written by the desktop tool's own Go code
 * (see fixtures/README.md for how they were produced). The format is the
 * contract between the two tools, so those files are asserted byte-for-byte
 * rather than approximately: a review started in one has to be continued in
 * the other. The rest of the tables here are ports of the Go
 * round-trip, parse and drift tests.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Splits source text the way an annotation's context is taken from it. */
function lines(text: string): string[] {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

/** An empty review with a pinned start date, so a serialization is stable. */
function emptyReview(started: string): Review {
  return { data: new Map(), started };
}

// --- byte-for-byte against files the Go tool wrote ---------------------------

/**
 * The inputs each fixture was built from, mirroring the generator that wrote
 * them. Building the same review here and serializing it must produce the
 * fixture's bytes exactly.
 */
const FIXTURE_INPUTS: Record<
  string,
  {
    started: string;
    sources: Record<string, string>;
    set: Array<[file: string, line: number, comment: string]>;
  }
> = {
  plain: {
    started: '2026-08-31',
    sources: { 'src/app.ts': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' },
    set: [['src/app.ts', 5, 'the comment, as written']],
  },
  'many-files-and-lines': {
    started: '2020-01-01',
    sources: {
      'b.go': 'x1\nx2\nx3\nx4\nx5\n',
      'a.go': 'l1\nl2\nl3\nl4\nl5\nl6\n',
      'zz/deep.py': 'p1\np2\np3\n',
    },
    set: [
      ['b.go', 2, 'second file, first comment'],
      ['a.go', 5, 'later line'],
      ['a.go', 1, 'earlier line'],
      ['zz/deep.py', 3, 'last file'],
    ],
  },
  'structural-markdown-in-comment': {
    started: '2026-08-31',
    sources: { 'a.go': 'l1\nl2\nl3\nl4\nl5\n' },
    set: [
      ['a.go', 3, 'See below.\n\n#### Line 99\n\nA sample:\n\n```md\n#### Line 42\n```'],
      ['a.go', 4, '## `other.go`\n\nnot a real header'],
      ['a.go', 5, 'first\n\n---\n\nsecond'],
    ],
  },
  'comment-ending-in-numbered-block': {
    started: '2026-08-31',
    sources: { 'a.go': 'l1\nl2\nl3\nl4\nl5\n' },
    set: [['a.go', 3, 'The numbering is off here:\n\n```\n1: first\n2: second\n```']],
  },
  'no-language-for-the-file': {
    started: '2026-08-31',
    sources: { 'notes.unknownext': 'x\ny\nz\n' },
    set: [['notes.unknownext', 2, 'another note']],
  },
  'line-out-of-range-has-no-context': {
    started: '2026-08-31',
    sources: { 'a.go': 'l1\nl2\n' },
    set: [['a.go', 99, 'past the end of the file']],
  },
  'blank-and-indented-context': {
    started: '2026-08-31',
    sources: { 'a.go': 'package main\n\n    indented\n\nfunc main() {}\n\n\n' },
    set: [['a.go', 3, 'trailing spaces in context must survive']],
  },
};

describe('the format, against files the desktop tool wrote', () => {
  // README.md documents the fixtures' provenance; it is not one of them.
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.slice(0, -3));

  test('every fixture has inputs to build it from', () => {
    // A fixture added without its inputs would otherwise be silently
    // half-tested: parsed and re-serialized, but never built from scratch.
    assert.deepEqual(names.toSorted(), Object.keys(FIXTURE_INPUTS).toSorted());
  });

  for (const name of names) {
    const want = readFileSync(join(FIXTURES, `${name}.md`), 'utf8');

    test(`${name}: writing the same review produces the same bytes`, () => {
      const input = FIXTURE_INPUTS[name]!;
      const review = emptyReview(input.started);
      for (const [file, line, comment] of input.set) {
        const source = input.sources[file];
        setAnnotation(review, file, line, comment, source ? lines(source) : null);
      }
      assert.equal(serializeReview(review), want);
    });

    test(`${name}: reading and writing it back changes nothing`, () => {
      assert.equal(serializeReview(parseReview(want)), want);
    });

    test(`${name}: a second round trip is still identical`, () => {
      // The first pass could normalise something; the second proves it does
      // not, which is what keeps two tools editing one file honest.
      const once = serializeReview(parseReview(want));
      assert.equal(serializeReview(parseReview(once)), once);
    });
  }
});

// --- parsing ----------------------------------------------------------------

describe('parseReview', () => {
  test('captures the context block with its first line number', () => {
    const review = parseReview(
      [
        '# Code Review',
        '',
        '_Started: 2026-03-22_',
        '',
        '---',
        '',
        '## `test.go`',
        '',
        '#### Line 5',
        '',
        'This is a comment',
        '',
        '```go',
        '3: func main() {',
        '4: \tx := 1',
        '5: \tfmt.Println(x)',
        '6: \ty := 2',
        '7: \tfmt.Println(y)',
        '```',
        '',
      ].join('\n'),
    );
    const ann = review.data.get('test.go')?.get(5);
    assert.ok(ann);
    assert.equal(ann.comment, 'This is a comment');
    assert.equal(ann.contextFrom, 3);
    assert.deepEqual(ann.context, [
      'func main() {',
      '\tx := 1',
      '\tfmt.Println(x)',
      '\ty := 2',
      '\tfmt.Println(y)',
    ]);
  });

  test('reads the outdated marker, and its absence', () => {
    const head = '# Code Review\n\n_Started: 2026-03-22_\n\n---\n\n## `test.go`\n\n';
    const outdated = parseReview(`${head}#### Line 5 (outdated)\n\nThis is outdated\n`);
    assert.equal(outdated.data.get('test.go')?.get(5)?.outdated, true);
    const normal = parseReview(`${head}#### Line 5\n\nNormal comment\n`);
    assert.equal(normal.data.get('test.go')?.get(5)?.outdated, false);
  });

  test('an empty document is an empty review', () => {
    // What a session with no REVIEW.md yet reads as.
    const review = parseReview('');
    assert.equal(review.data.size, 0);
    assert.equal(review.started, '');
  });

  test('the start date is read back rather than replaced', () => {
    const review = parseReview(
      '# Code Review\n\n_Started: 2020-01-01_\n\n---\n\n## `test.go`\n\n#### Line 1\n\n> old comment\n',
    );
    assert.equal(review.started, '2020-01-01');
    setAnnotation(review, 'test.go', 2, 'new comment', ['a', 'b', 'c']);
    assert.match(serializeReview(review), /_Started: 2020-01-01_/);
  });

  test('a file written before the context was stored still reads', () => {
    const review = parseReview(
      '# Code Review\n\n_Started: 2020-01-01_\n\n---\n\n## `a.go`\n\n' +
        '#### Line 1\n\nfirst comment\n\n#### Line 5\n\nsecond comment\n\n---\n\n' +
        '## `b.go`\n\n#### Line 2\n\nthird comment\n',
    );
    assert.equal(review.started, '2020-01-01');
    assert.equal(review.data.get('a.go')?.get(1)?.comment, 'first comment');
    assert.equal(review.data.get('a.go')?.get(5)?.comment, 'second comment');
    assert.equal(review.data.get('b.go')?.get(2)?.comment, 'third comment');
  });

  test('an unmarked context block is still recognised', () => {
    // Review files written before the marker existed carry none; there the
    // numbered source lines are what identify the block.
    const review = parseReview(
      '# Code Review\n\n_Started: 2020-01-01_\n\n---\n\n## `a.go`\n\n' +
        '#### Line 5 (outdated)\n\nan older comment\n\n```go\n4: was here\n5: and here\n```\n',
    );
    const ann = review.data.get('a.go')?.get(5);
    assert.ok(ann);
    assert.equal(ann.comment, 'an older comment');
    assert.equal(ann.contextFrom, 4);
    assert.deepEqual(ann.context, ['was here', 'and here']);
    assert.equal(ann.outdated, true);
  });

  test('a line heading before any file heading is not structure', () => {
    const review = parseReview('# Code Review\n\n#### Line 5\n\nstray\n');
    assert.equal(review.data.size, 0);
  });

  test('a rule with no file section after it is text, not a separator', () => {
    const review = parseReview(
      '# Code Review\n\n_Started: 2020-01-01_\n\n---\n\n## `a.go`\n\n#### Line 1\n\nbefore\n\n---\n\nafter\n',
    );
    assert.equal(review.data.get('a.go')?.get(1)?.comment, 'before\n\n---\n\nafter');
  });
});

// --- round trips ------------------------------------------------------------

describe('a comment survives a write and a read', () => {
  const cases: Record<string, string> = {
    plain: 'just a comment',
    'code fence': 'use this instead:\n\n```go\nfoo()\n```\n\nsee?',
    'horizontal rule': 'first\n\n---\n\nsecond',
    'line heading': '#### Line 99\n\nnot a real header',
    'file heading': '## `other.go`\n\nnot a real header',
    'context lines': '1: foo\n2: bar',
    blockquote: '> already quoted\n> twice',
    indentation: 'look at:\n    indented\n\tand tabbed',
    'numbered block': 'The numbering is off here:\n\n```\n1: first\n2: second\n```',
    'tilde fence': 'try:\n\n~~~go\nfoo()\n~~~\n\ndone',
    'nested fences': 'outer:\n\n````md\n```go\nfoo()\n```\n````',
    'trailing whitespace inside a fence': 'see:\n\n```\nx   \n```',
    'unicode': 'schöner Kommentar — mit Gedankenstrich und 🎉',
  };

  for (const [name, comment] of Object.entries(cases)) {
    test(name, () => {
      const source = lines('l1\nl2\nl3\nl4\nl5\n');
      const review = emptyReview('2026-08-31');
      setAnnotation(review, 'a.go', 3, comment, source);
      const back = parseReview(serializeReview(review));
      assert.equal(back.data.get('a.go')?.get(3)?.comment, comment);
    });
  }

  test('neighbouring annotations stay separated', () => {
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 1, 'first\n\n```\n#### Line 42\n```', lines('l1\nl2\nl3\nl4\nl5\n'));
    setAnnotation(review, 'a.go', 4, 'second', lines('l1\nl2\nl3\nl4\nl5\n'));
    setAnnotation(review, 'b.go', 2, 'third\n---', lines('x1\nx2\nx3\n'));

    const back = parseReview(serializeReview(review));
    assert.equal(back.data.size, 2);
    assert.equal(back.data.get('a.go')?.size, 2);
    assert.equal(back.data.get('a.go')?.get(4)?.comment, 'second');
    assert.equal(back.data.get('b.go')?.get(2)?.comment, 'third\n---');
  });

  test('a very long line is annotated and read back whole', () => {
    // Minified and generated files are exactly what a workspace holds.
    const long = 'x'.repeat(200_000);
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'bundle.js', 2, 'this line is huge', ['first', long, 'last']);
    const ann = parseReview(serializeReview(review)).data.get('bundle.js')?.get(2);
    assert.equal(ann?.context.length, 3);
    assert.equal(ann?.context[1], long);
  });

  test('the comment is written as prose, never quoted', () => {
    const comment = 'Prefer a logger:\n\n```go\nlog.Println("hi")\n```\n\nIt keeps output consistent.';
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 3, comment, lines('l1\nl2\nl3\nl4\nl5\n'));
    const written = serializeReview(review);
    assert.ok(written.includes(`\n${comment}\n`));
    assert.ok(!written.includes('\n> '));
  });

  test('only the lines that would read as headings are escaped', () => {
    const comment = 'See below.\n\n#### Line 99\n\nA sample:\n\n```md\n#### Line 42\n```';
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 2, comment, lines('l1\nl2\nl3\n'));
    const written = serializeReview(review);
    assert.ok(written.includes('\\#### Line 99'));
    // Inside a fence nothing is structure, so nothing needs escaping.
    assert.ok(!written.includes('\\#### Line 42'));
    assert.ok(written.includes('See below.'));
    assert.equal(parseReview(written).data.get('a.go')?.get(2)?.comment, comment);
  });

  test('a context block says what it is, and keeps its language', () => {
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 2, 'a note', lines('l1\nl2\nl3\n'));
    setAnnotation(review, 'notes.unknownext', 2, 'another note', lines('x\ny\nz\n'));
    const written = serializeReview(review);
    assert.ok(written.includes('```go context\n'));
    assert.ok(written.includes('```context\n'));
  });
});

// --- mutation ---------------------------------------------------------------

describe('mutation', () => {
  test('setting a comment twice replaces it', () => {
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 2, 'first', lines('l1\nl2\nl3\n'));
    setAnnotation(review, 'a.go', 2, 'second', lines('l1\nl2\nl3\n'));
    assert.equal(review.data.get('a.go')?.size, 1);
    assert.equal(review.data.get('a.go')?.get(2)?.comment, 'second');
  });

  test('a comment is stored trimmed', () => {
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 2, '  \n padded \n  ', lines('l1\nl2\nl3\n'));
    assert.equal(review.data.get('a.go')?.get(2)?.comment, 'padded');
  });

  test('an unreadable source leaves the annotation without context', () => {
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'gone.go', 2, 'still worth saying', null);
    const ann = review.data.get('gone.go')?.get(2);
    assert.deepEqual(ann?.context, []);
    assert.equal(ann?.contextFrom, 0);
    // And it survives a round trip, since the fence is simply absent.
    assert.equal(
      parseReview(serializeReview(review)).data.get('gone.go')?.get(2)?.comment,
      'still worth saying',
    );
  });

  test('deleting the last comment of a file drops the file', () => {
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 2, 'one', lines('l1\nl2\nl3\n'));
    setAnnotation(review, 'a.go', 3, 'two', lines('l1\nl2\nl3\n'));
    deleteAnnotation(review, 'a.go', 2);
    assert.equal(review.data.get('a.go')?.size, 1);
    deleteAnnotation(review, 'a.go', 3);
    assert.ok(!review.data.has('a.go'));
    // An empty review still writes a valid document.
    assert.equal(serializeReview(review), '# Code Review\n\n_Started: 2026-08-31_\n');
  });

  test('deleting what is not there is not an error', () => {
    const review = emptyReview('2026-08-31');
    deleteAnnotation(review, 'nosuch.go', 1);
    deleteAnnotation(review, 'nosuch.go', 1);
    assert.equal(review.data.size, 0);
  });

  test('counts are per annotated file', () => {
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'a.go', 1, 'x', null);
    setAnnotation(review, 'a.go', 2, 'y', null);
    setAnnotation(review, 'b.go', 1, 'z', null);
    assert.deepEqual(
      [...annotationCounts(review).entries()].toSorted(),
      [
        ['a.go', 2],
        ['b.go', 1],
      ],
    );
  });

  test('context is taken with radius 3 and clamped to the file', () => {
    const five = ['l1', 'l2', 'l3', 'l4', 'l5'];
    assert.deepEqual(contextAround(five, 3), { context: five, from: 1 });
    assert.deepEqual(contextAround(five, 1), { context: ['l1', 'l2', 'l3', 'l4'], from: 1 });
    assert.deepEqual(contextAround(five, 5), { context: ['l2', 'l3', 'l4', 'l5'], from: 2 });
    // Out of range records nothing rather than guessing.
    assert.deepEqual(contextAround(five, 0), { context: [], from: 0 });
    assert.deepEqual(contextAround(five, 6), { context: [], from: 0 });
  });
});

// --- drift ------------------------------------------------------------------

/** One annotation with stored context, as a drift check meets it. */
function annotated(
  line: number,
  context: string[],
  contextFrom: number,
  outdated = false,
): Map<number, Annotation> {
  return new Map([[line, { comment: 'test comment', context, contextFrom, outdated }]]);
}

describe('checkDrift', () => {
  test('context still in place is no change', () => {
    const anns = annotated(3, ['line2', 'line3', 'line4'], 2);
    assert.equal(checkDrift(anns, ['line1', 'line2', 'line3', 'line4', 'line5']), false);
  });

  test('context that moved relocates the annotation with it', () => {
    const anns = annotated(3, ['line2', 'line3', 'line4'], 2);
    // Two lines inserted at the top.
    const changed = checkDrift(anns, [
      'new1',
      'new2',
      'line1',
      'line2',
      'line3',
      'line4',
      'line5',
    ]);
    assert.equal(changed, true);
    assert.ok(anns.has(5));
    assert.ok(!anns.has(3));
  });

  test('context that is gone is marked outdated, and kept', () => {
    const anns = annotated(3, ['line2', 'line3', 'line4'], 2);
    assert.equal(checkDrift(anns, ['completely', 'different', 'content']), true);
    assert.equal(anns.get(3)?.outdated, true);
    assert.equal(anns.get(3)?.comment, 'test comment');
  });

  test('a deleted file marks every annotation on it outdated', () => {
    const anns = annotated(3, ['line2', 'line3', 'line4'], 2);
    assert.equal(checkDrift(anns, null), true);
    assert.equal(anns.get(3)?.outdated, true);
    // And says so only once: a second check has nothing left to change.
    assert.equal(checkDrift(anns, null), false);
  });

  test('context that came back clears the outdated mark', () => {
    const anns = annotated(3, ['line2', 'line3', 'line4'], 2, true);
    assert.equal(checkDrift(anns, ['line1', 'line2', 'line3', 'line4']), true);
    assert.equal(anns.get(3)?.outdated, false);
  });

  test('an annotation with no context adopts the current source', () => {
    const anns = new Map<number, Annotation>([
      [1, { comment: 'no context', context: [], contextFrom: 0, outdated: false }],
    ]);
    assert.equal(checkDrift(anns, ['line1', 'line2']), true);
    const ann = anns.get(1)!;
    assert.equal(ann.contextFrom, 1);
    assert.equal(ann.context.length, 2);
    assert.equal(ann.outdated, false);
  });

  test('an empty file has nothing to drift', () => {
    assert.equal(checkDrift(new Map(), ['a']), false);
  });

  test('repeated code relocates to the nearest copy, not the first', () => {
    // The same three lines open a block at 1, 6 and 11. Code that repeats
    // itself would otherwise pull every annotation to the first copy.
    const source = [
      '}',
      '',
      'func f() {',
      '\tbody',
      '',
      '}',
      '',
      'func f() {',
      '\tbody',
      '',
      '}',
      '',
      'func f() {',
      '\tbody',
    ];
    const context = ['}', '', 'func f() {'];
    for (const [near, want] of [
      [1, 1],
      [3, 1],
      [4, 6],
      [6, 6],
      [8, 6],
      [11, 11],
      [99, 11],
    ] as const) {
      // The annotation sits on the block's own first line, so relocation is
      // visible as the key moving to `want`.
      const anns = annotated(near, context, near);
      checkDrift(anns, source);
      assert.ok(anns.has(want), `searching from ${near} should land on ${want}`);
    }
  });

  test('inserting above an annotation moves it to its own code', () => {
    const block = ['func x() {', '\treturn', '}'];
    const review = emptyReview('2026-08-31');
    setAnnotation(review, 'test.go', 5, 'the second one', [...block, ...block]);
    // Push everything down by one.
    const anns = review.data.get('test.go')!;
    assert.equal(checkDrift(anns, ['// header', ...block, ...block]), true);
    assert.ok(anns.has(6));
  });

  test('the outdated mark survives being written and read back', () => {
    const review = emptyReview('2026-08-31');
    const before = ['l1', 'l2', 'l3', 'TARGET', 'l5', 'l6', 'l7'];
    setAnnotation(review, 'test.go', 4, 'look at this', before);

    const after = ['l1', 'l2', 'l3', 'REPLACED', 'l5', 'l6', 'l7'];
    assert.equal(checkDrift(review.data.get('test.go')!, after), true);
    assert.equal(review.data.get('test.go')?.get(4)?.outdated, true);

    // The stored context must stay the code the comment was about, not the
    // code that took its place — else the next read clears the mark.
    const reloaded = parseReview(serializeReview(review));
    assert.equal(reloaded.data.get('test.go')?.get(4)?.outdated, true);
    assert.equal(checkDrift(reloaded.data.get('test.go')!, after), false);
    assert.equal(reloaded.data.get('test.go')?.get(4)?.outdated, true);
  });

  test('a context longer than the file matches nothing', () => {
    const anns = annotated(1, ['a', 'b'], 1);
    assert.equal(checkDrift(anns, ['a']), true);
    assert.equal(anns.get(1)?.outdated, true);
  });

  test('a relocation that would land above line 1 is refused', () => {
    // The context moved up further than the annotation's offset into it,
    // which has no valid line to point at.
    const anns = annotated(1, ['b', 'c'], 5);
    checkDrift(anns, ['b', 'c', 'd']);
    assert.ok(!anns.has(-3));
  });
});

// --- odds and ends ----------------------------------------------------------

describe('detectLang', () => {
  test('names the languages the fence info string uses', () => {
    assert.equal(detectLang('src/app.ts'), 'typescript');
    assert.equal(detectLang('a/b/main.go'), 'go');
    assert.equal(detectLang('script.sh'), 'bash');
    assert.equal(detectLang('Dockerfile'), 'docker');
    assert.equal(detectLang('deep/Makefile'), 'makefile');
  });

  test('an unknown extension has no language', () => {
    assert.equal(detectLang('notes.unknownext'), '');
    assert.equal(detectLang('LICENSE'), '');
    // A dotfile is a name, not an extension.
    assert.equal(detectLang('.gitignore'), '');
  });
});

test('todayStamp is the date format REVIEW.md records', () => {
  assert.equal(todayStamp(new Date(2026, 7, 31)), '2026-08-31');
  assert.equal(todayStamp(new Date(2026, 0, 1)), '2026-01-01');
});
