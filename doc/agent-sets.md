# Agent sets

An agent set is a named collection of agent configuration: an `AGENTS.md` file and skills. The orchestrator stores
sets in its [database](storage.md). The agent in a box reads its configuration from files in its
home directory. The orchestrator writes these files from the sets.

## The global set and named sets

There is one set with the id `global`. It is seeded when the database is created. The global set applies to every box
and cannot be deleted.

More sets can be added in the dashboard. A set has a display name, an optional `AGENTS.md`, and any number of skills.

A set is selected when a [box is created](boxes.md). The selection is stored with the box and cannot change later. A box
that selects no set gets the global set alone. Naming the global set is the same as naming nothing.

## Merging

A box always gets the global set. When another set is selected, the orchestrator merges the two. The two kinds of
content merge differently:

- The `AGENTS.md` files are concatenated: the global one first, the selected set's one after it, separated by a blank
  line.
- A skill is addressed by its name. When two skills have the same name, one wins. The order, highest first:
  1. a skill of the selected set
  2. a skill from a repository of the selected set, in the order of the repository list
  3. a skill of the global set
  4. a skill from a repository of the global set, in the order of the repository list

The editor of a named set shows the merged result under "Merged result".

## Skills

A skill is a directory with a `SKILL.md` file. The file needs YAML front matter with a `name` and a `description`. The
description is the only thing the agent sees before it decides to read the skill. A skill without front matter is not
loaded at all. The user can also invoke a skill in the composer by typing its name after a slash.

Skill names must be lowercase letters, digits, and dashes, start with a letter or digit, and be 64 characters or fewer.
A name is fixed once the skill exists. To rename a skill, delete it and add it again.

A set holds at most 100 skills. An `AGENTS.md` or one skill's content may be at most 100,000 characters.

## Skills from repositories

A set can also take skills from Git repositories, for example a Claude plugin repository. Such a skill can have more
files than its `SKILL.md`, for example references or scripts.

A repository is added by its HTTPS URL. A branch, a tag, or a full commit hash is optional. Without one, the default
branch is used. To change the URL or the branch, remove the repository and add it again.

The orchestrator pulls a repository when it is added, once a day, and when the user selects the pull button. Each
directory with a `SKILL.md` file is one skill, at any depth. The directory name is the skill name. A `SKILL.md` at the
root gets the name of the repository. The orchestrator copies the full directory, but no links.

Private repositories on `github.com` use the GitHub [credential](credentials.md).

When a pull fails, the editor shows the error on the repository. The skills of the last good pull stay in use.

A set takes skills from at most 20 repositories, and the orchestrator takes at most 100 skills from one repository.

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

The implementation is `orchestrator/src/agents.ts`, over the `agent_sets`, `agent_items` and `agent_repos` tables. The
database is the source of truth; the files are derived from it.

### Repository checkouts

`orchestrator/src/skill-repos.ts` fetches a repository into `DATA_DIR/skill-repos/<repo id>/tree`. Each pull is a
shallow fetch into a new git directory, and the new files replace the old checkout in one step. The `agent_repos` row
keeps the commit, the skills found, and the error of the last pull.

This is the one place where the orchestrator runs git itself. A repository cannot make git run a program here: the new
git directory has no hooks, the configuration that names filters and helpers is never fetched, no system or user
configuration is read, and submodules are not fetched.

### Materialization

The merged set is written to `DATA_DIR/agents/<box id>`, once per harness in the layouts the harness registry
(`orchestrator/src/harness.ts`) names. A box can hold threads of different harnesses, and neither agent reads the
other's directories:

| Content | Claude | Codex |
| --- | --- | --- |
| Instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` |
| Skills | `~/.claude/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |

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

The box's `agent_set_id` column references the set with `ON DELETE SET NULL`, and the set's items and repositories are
deleted with it, together with the repository checkouts. A box that named the deleted set keeps its installed files and
gets the global set alone at its next start.
