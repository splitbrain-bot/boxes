# Code review

The review tool lets you inspect, edit, and comment on the files in a box's
workspace. A review covers the whole workspace, including every Git repository
inside it.

## Opening a review

Select **Review** on a box card, or select **Review this box's code** in a
thread header. The review opens for that box's workspace. Select a file in the
tree to open it. On a phone, the file replaces the tree; use **Back** to return
to the tree.

## Comparing changes

The file tree shows every workspace file. Git status markers identify modified,
staged, untracked, added, deleted, and conflicted files. The code pane marks
changed lines. Use the change and comment buttons in its header to move between
them. Select a changed line number to view its complete diff hunk.

By default, each repository is compared with its own `HEAD` - eg. highlighting
changes made in the workspace since the last commit. Optionally select the
comparison control and enter a branch, tag, or commit to compare with instead.

## Opening or downloading files

Select **Open in a new tab** in the file header to open the original workspace
file outside the review tool. The browser displays the file when it supports
that type, or downloads it when it does not. This is useful for binary files,
which the review tool cannot display.

## Modes

The review has commenting and editing modes. It opens in commenting mode.

### Commenting

Select a source line to open the comment form. Write the comment, then select
**Comment** or press `Ctrl`/`Cmd`+`Enter` to save it. Use the edit or delete
button on an existing comment card to change it. Comments are saved in a
`REVIEW.md` at the workspace root.

When the review was opened from a thread and has comments, select **Hand to
agent** to quickly switch back to the thread with a prepared prompt for the
agent to read your review.

Use the **Start a new review** button to delete the `REVIEW.md` and all
comments, and start over.

### Editing

Select the pencil button in the file header to switch to editing mode. Edit the
file, then select **Save** in the header. Select the pencil again to return to
commenting mode.

The tool refuses to edit binary, deleted, truncated, or very long files. If the
file changes on disk while you are editing, choose **Save anyway** to replace
the changed file, or **Drop my changes** to reload it.

