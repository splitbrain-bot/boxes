# REVIEW.md fixtures

These files were written by the desktop [`review`](https://github.com/splitbrain/review)
tool's own `internal/store`, and they are the reason `store.ts` can claim the
format is a contract rather than a resemblance: `store.test.ts` builds the same
review from the same inputs and asserts the bytes match, then parses each file
and asserts writing it back changes nothing. A review started in one tool has to
be continuable in the other, so an approximate match would not be enough.

Regenerating them, against a checkout of that repository at the revision the
port was made from (`96101bd`):

```go
// internal/store/fixturegen_test.go, in the review checkout
func TestGenerateFixtures(t *testing.T) {
    out := os.Getenv("REVIEW_FIXTURE_DIR")
    if out == "" { t.Skip("REVIEW_FIXTURE_DIR not set") }
    // for each case: write the sources into t.TempDir(), Load the store,
    // pin st.started, Set every annotation, then copy REVIEW.md to out/<name>.md
}
```

```
REVIEW_FIXTURE_DIR=…/orchestrator/src/review/fixtures \
  go test ./internal/store/ -run TestGenerateFixtures
```

The cases and their inputs are listed in `FIXTURE_INPUTS` in
`../store.test.ts`, which also asserts that no fixture exists without them — a
file added here without its inputs would be round-tripped but never built from
scratch, which is the half of the contract that matters.

What each covers:

| Fixture | Covers |
|---|---|
| `plain.md` | The shape of the document: heading, start date, one file, one annotation with its context |
| `many-files-and-lines.md` | Files sorted lexicographically, lines numerically, regardless of insertion order |
| `structural-markdown-in-comment.md` | A comment holding a line heading, a file heading and a horizontal rule, and where the escaping backslash goes |
| `comment-ending-in-numbered-block.md` | The case the `context` marker exists for: a comment whose own code sample looks exactly like a context block |
| `no-language-for-the-file.md` | A file whose extension names no language, so the fence carries the marker alone |
| `line-out-of-range-has-no-context.md` | An annotation past the end of its file, which records no context and writes no fence |
| `blank-and-indented-context.md` | Blank and indented context lines, including the trailing space a blank one leaves behind |
