# Code review

The review tool lets you inspect, edit, and comment on the files in a box's [workspace](storage.md). A review covers the
whole workspace, including every Git repository inside it.

## Opening a review

Select **Review** on a [box card](boxes.md), or select **Review this box's code** in a [thread](threads.md) header. The
review opens for that box's workspace. Select a file in the tree to open it. On a phone, the file replaces the tree; use
**Back** to return to the tree.

## Comparing changes

The file tree shows every workspace file. Git status markers identify modified, staged, untracked, added, deleted, and
conflicted files. The code pane marks changed lines. Use the change and comment buttons in its header to move between
them. Select a changed line number to view its complete diff hunk.

By default, each repository is compared with its own `HEAD`: the view highlights the changes made in the workspace since
the last commit. To compare with a different base, select the comparison control and enter a branch, tag, or commit.

## Opening or downloading files

Select **Open in a new tab** in the file header to open the original workspace file outside the review tool. The browser
displays the file when it supports that type, or downloads it when it does not. This is useful for binary files, which
the review tool cannot display.

## Modes

The review has commenting and editing modes. It opens in commenting mode.

### Commenting

Select a source line to open the comment form. Write the comment, then select **Comment** or press `Ctrl`/`Cmd`+`Enter`
to save it. Use the buttons on an existing comment card to edit or delete it. Comments are saved in the `REVIEW.md` file
at the workspace root.

When the review was opened from a thread and has comments, select **Hand to agent** to switch back to the thread with a
prepared prompt that asks the agent to read your review.

Use the **Start a new review** button to delete the `REVIEW.md` and all comments, and start over.

### Editing

Select the pencil button in the file header to switch to editing mode. Edit the file, then select **Save** in the
header. Select the pencil again to return to commenting mode.

The tool refuses to edit binary, deleted, truncated, or very long files. If the file changes on disk while you are
editing, choose **Save anyway** to replace the changed file, or **Drop my changes** to reload it.

## Technical internals

The review code lives in `orchestrator/src/review/`.

### REVIEW.md is the only store

There is no annotation table. Every mutation reads, parses, applies, serializes and writes the whole `REVIEW.md` under a
per-box lock, with the file's hash checked between read and write. A hash that changed means the agent wrote in between;
the mutation is re-read and re-applied once. Writes are atomic and keep the file's permissions, and the file is chowned
to the box user so the agent can edit or delete it. The format matches the desktop
[`review`](https://github.com/splitbrain/review) tool byte for byte — the test fixtures are files that tool wrote.

### One workspace, many repositories

The review covers the whole workspace, not one repository. Repository discovery walks the tree breadth-first, skips the
dependency and build directories a repository is usually not in, and confirms a candidate — a directory holding a `.git`
file or directory — with git itself. The longest-prefix match attributes each path to a repository: a nested repository
wins over its parent, and a file that no repository claims is shown without git.

Git's answers are one snapshot per review — the repository map, the base of each repository, and the status of every
changed file — taken when a reader arrives, after a save, or after a base change, rather than per folder. Opening a
folder is then one directory read and nothing else.

A comparison base such as `main` is stored as the expression only. It is resolved per repository through the merge base
with that repository's HEAD; a repository where the expression names nothing falls back to its own HEAD, and the request
fails only when it resolves nowhere.

### Git runs in the box

Every git invocation is a `docker exec` into the box's own container, as the box user, with a fixed argument vector
built in `review/git.ts`. The orchestrator never runs git on the workspace itself: a repository's configuration can name
programs for git to run (a clean filter is sufficient), and in the box such a command has only the agent's own
privileges. This is why review endpoints that need git start a stopped box.

### Containment

The orchestrator reads a tree the agent controls, so every client path goes through `resolveInRoot` in `review/fs.ts`:
the path must stay under the workspace's real path, and the orchestrator refuses a symlink as the final component. The
same check applies to the file endpoints and the attachment endpoint. The orchestrator caps file reads at 2 MiB; a NUL
byte marks a file as binary.

### Drift

Each comment stores three lines of context above and below its line. The drift check compares the stored context with
the current source: an exact match elsewhere relocates the comment, no match marks it `(outdated)`. Drift runs when a
reader arrives, on every file view, and after every comment write.

### Editing

A save sends the whole file and the hash it was read at. The orchestrator refuses a save over a file that changed in
between with a 412 — the one refusal the reviewer can overrule, because both versions still exist at that moment. It
refuses outright a file that the endpoint could not read fully: saving back a truncated read would delete the rest. A
separate limit applies only in the browser: past 8,000 lines the file renders as one plain block, without line comments
or edit mode.

