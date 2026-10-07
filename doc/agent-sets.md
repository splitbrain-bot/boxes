# Agent sets

An agent set is a named collection of agent configuration: an `AGENTS.md` file, skills, and slash commands. The
orchestrator stores sets in its [database](storage.md). The agent in a box reads its configuration from files in its
home directory. The orchestrator writes these files from the sets.

## The global set and named sets

There is one set with the id `global`. It is seeded when the database is created. The global set applies to every box
and cannot be deleted.

More sets can be added in the dashboard. A set has a display name, an optional `AGENTS.md`, and any number of skills and
slash commands.

A set is selected when a [box is created](boxes.md). The selection is stored with the box and cannot change later. A box
that selects no set gets the global set alone. Naming the global set is the same as naming nothing.

## Merging

A box always gets the global set. When another set is selected, the orchestrator merges the two. The two kinds of
content merge differently:

- The `AGENTS.md` files are concatenated: the global one first, the selected set's one after it, separated by a blank
  line.
- A skill or command is addressed by its name. When the selected set has one of the same name as the global set, the
  selected set's one wins.

The editor of a named set shows the merged result under "Merged result".

## Skills and commands

A skill is a directory with a `SKILL.md` file. The file needs YAML front matter with a `name` and a `description`. The
description is the only thing the agent sees before it decides to read the skill. A skill without front matter is not
loaded at all.

A slash command is a markdown file. The user invokes it in the composer by typing its name after a slash.

Item names must be lowercase letters, digits, and dashes, start with a letter or digit, and be 64 characters or fewer. A
name is fixed once the item exists. To rename an item, delete it and add it again.

A set holds at most 100 items of each kind. An `AGENTS.md` or one item's content may be at most 100,000 characters.

## File installation into a box

When a box is created and before each start, the orchestrator writes the merged set into the box, once per
[harness](glossary.md) in the layout that harness reads. Files the agent wrote in its own home stay in place.

The practical effects:

- Changes to a set reach a box the next time the box starts. A running box keeps what it has.
- An item deleted from a set is removed from the box at the next start.
- When a set is deleted, the boxes that selected it keep what is already installed, and get the global set alone at the
  next start.

## Built-in skills

The box image carries skills for common tasks, for example how to install software with nix. The entrypoint installs
them into both skill layouts at every box start. A skill of the same name in the merged set wins: the entrypoint leaves
the image's copy out when the manifest names that skill. This is how a project overrides a built-in skill with its own
instructions.

The built-in skills are described in [Built-in skills](skills.md).

## Managing sets

Sets are managed in the dashboard. The agent configuration icon on the box list opens the set list; from there, one set
can be opened in its editor.

## Technical internals

The implementation is `orchestrator/src/agents.ts`, over the `agent_sets` and `agent_items` tables. The database is the
source of truth; the files are derived from it.

### Materialization

The merged set is written to `DATA_DIR/agents/<box id>`, once per harness in the layouts the harness registry
(`orchestrator/src/harness.ts`) names. A box can hold threads of different harnesses, and neither agent reads the
other's directories:

| Content | Claude | Codex |
| --- | --- | --- |
| Instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` |
| Skills | `~/.claude/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |
| Commands | `~/.claude/commands/<name>.md` | `~/.codex/prompts/<name>.md` |

The container mounts the directory read-only at `/boxes/agent`, and the entrypoint installs it into the home directory:
mounting the home's own subdirectories read-only would break the box, and mounting them writable would let the agent
edit what the dashboard shows as configured. New content is written before old entries are pruned, and the directory's
inode is kept, because a running container has it bind-mounted.

### The reversible install

A `manifest` file lists every installed path — a skill by its directory, so removal takes the whole directory. The
entrypoint removes exactly what the previous start recorded in `~/.boxes/managed`, then installs the current manifest.
Manifest lines are checked, not trusted: each line must stay inside one of the layout prefixes, a list written into the
entrypoint itself, so a manifest naming `.claude` or `.ssh` as a whole is refused rather than turned into a recursive
delete.

### Deleting a set

The box's `agent_set_id` column references the set with `ON DELETE SET NULL`, and the set's items are deleted with it. A
box that named the deleted set keeps its installed files and gets the global set alone at its next start.
