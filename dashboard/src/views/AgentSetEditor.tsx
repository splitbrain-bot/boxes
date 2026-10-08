import { FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type {
  AgentBundlePreview,
  AgentItem,
  AgentRepo,
  AgentSetDetail,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BackLink } from '@/components/BackLink';
import { useUp } from '@/hooks/use-up';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Editor for one agent set: its AGENTS.md and its skills.
 *
 * Each section saves on its own. Saved changes reach a box the next time the
 * box starts.
 */
export function AgentSetEditor() {
  const { setId = '' } = useParams();
  /** Leaves for the list of sets. */
  const up = useUp('/agents');

  const [set, setSet] = useState<AgentSetDetail | null>(null);
  const [preview, setPreview] = useState<AgentBundlePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The AGENTS.md text as edited. The Save button compares it with the saved text. */
  const [agentsMd, setAgentsMd] = useState('');
  const [name, setName] = useState('');

  const [editing, setEditing] = useState<{ item: AgentItem | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AgentItem | null>(null);
  const [confirmRepo, setConfirmRepo] = useState<AgentRepo | null>(null);

  /**
   * Loads the set and, for a non-global set, the merged result.
   *
   * @param seed Fills the AGENTS.md and name buffers from the answer. Only the
   *   first load seeds them, so a reload after another save keeps unsaved text.
   */
  const load = useCallback(
    async (seed = false): Promise<void> => {
      try {
        const detail = await api.getAgentSet(setId);
        setSet(detail);
        if (seed) {
          setAgentsMd(detail.agentsMd);
          setName(detail.name);
        }
        setPreview(detail.global ? null : await api.agentSetPreview(setId));
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [setId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  /**
   * Runs one mutation, then reloads the set.
   *
   * @returns Whether the mutation succeeded.
   */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!set) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink up={up} label="Agent configuration" />
        {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : <Loading />}
      </div>
    );
  }

  const overridden = new Set(preview?.overrides ?? []);

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Agent configuration" />

      <h1 className="text-xl font-semibold">{set.name}</h1>

      <p className="text-sm text-muted-foreground">
        {set.global
          ? 'Everything here goes into every box.'
          : 'A box that names this set gets it on top of the global set.'}{' '}
        Changes reach a box the next time it starts.
      </p>

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      {/* The global set can be renamed too, because its name is only a label. */}
      <Card className="flex flex-col gap-3 p-4">
        <Label htmlFor="set-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="set-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || name.trim() === '' || name === set.name}
            onClick={() => void act(() => api.updateAgentSet(setId, { name: name.trim() }))}
          >
            Rename
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">AGENTS.md</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Standing instructions. Installed as the agent&apos;s own memory, so it applies wherever
          in the box the agent is working, not only in a checked-out project.
        </p>
        <Textarea
          value={agentsMd}
          // field-sizing-content ignores rows, so min-h sets the empty size.
          className="min-h-40 font-mono text-xs"
          placeholder={"# House rules\n\n- Run the tests before you say you are done.\n"}
          onChange={(e) => setAgentsMd(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={busy || agentsMd === set.agentsMd}
            onClick={() => void act(() => api.updateAgentSet(setId, { agentsMd }))}
          >
            {agentsMd === set.agentsMd ? 'Saved' : 'Save AGENTS.md'}
          </Button>
        </div>
      </Card>

      <ItemSection
        title="Skills"
        blurb="A SKILL.md the agent loads on its own when the work matches, or when you type its name after a slash in the composer. It needs YAML front matter with a name and a description — that description is the only thing the agent sees before deciding to read it."
        items={set.items}
        overridden={overridden}
        busy={busy}
        onAdd={() => setEditing({ item: null })}
        onEdit={(item) => setEditing({ item })}
        onDelete={setConfirmDelete}
      />

      <RepoSection
        repos={set.repos}
        busy={busy}
        onAdd={(url, ref) => act(() => api.addAgentRepo(setId, { url, ref }))}
        onPull={(repo) => void act(() => api.pullAgentRepo(setId, repo.id))}
        onDelete={setConfirmRepo}
      />

      {preview ? <Merged preview={preview} /> : null}

      {editing ? (
        <ItemDialog
          item={editing.item}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            if (await act(() => api.putAgentItem(setId, body))) setEditing(null);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete skill ${confirmDelete.name}?`}
          description="It is removed from this set, and from every box that uses the set at its next start."
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() =>
            void act(async () => {
              await api.deleteAgentItem(setId, confirmDelete.name);
              setConfirmDelete(null);
            })
          }
        />
      ) : null}

      {confirmRepo ? (
        <ConfirmDialog
          title="Remove repository?"
          description={`Its skills are removed from this set, and from every box that uses the set at its next start. ${confirmRepo.url}`}
          confirmLabel="Remove"
          danger
          busy={busy}
          onCancel={() => setConfirmRepo(null)}
          onConfirm={() =>
            void act(async () => {
              await api.deleteAgentRepo(setId, confirmRepo.id);
              setConfirmRepo(null);
            })
          }
        />
      ) : null}
    </div>
  );
}

/** The list of skills, with its own add button. */
function ItemSection({
  title,
  blurb,
  items,
  overridden,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string;
  blurb: string;
  items: AgentItem[];
  /** Names of the skills this set takes over from the global one. */
  overridden: Set<string>;
  busy: boolean;
  onAdd: () => void;
  onEdit: (item: AgentItem) => void;
  onDelete: (item: AgentItem) => void;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{blurb}</p>

      {items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">None in this set.</p>
      ) : null}

      {items.map((item) => (
        <div
          key={item.name}
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {item.name}
          </span>
          {overridden.has(item.name) ? (
            <span className="shrink-0 text-xs text-muted-foreground">replaces the global one</span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Edit ${item.name}`}
            disabled={busy}
            onClick={() => onEdit(item)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete ${item.name}`}
            className="text-danger"
            disabled={busy}
            onClick={() => onDelete(item)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </Card>
  );
}

/** The repositories a set takes skills from, with a form to add one. */
function RepoSection({
  repos,
  busy,
  onAdd,
  onPull,
  onDelete,
}: {
  repos: AgentRepo[];
  busy: boolean;
  /** Adds and pulls a repository. Resolves to whether that succeeded. */
  onAdd: (url: string, ref: string) => Promise<boolean>;
  onPull: (repo: AgentRepo) => void;
  onDelete: (repo: AgentRepo) => void;
}) {
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');

  /** Adds the repository in the form, and empties the form when that worked. */
  const add = async (): Promise<void> => {
    if (await onAdd(url.trim(), ref.trim())) {
      setUrl('');
      setRef('');
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-medium">Repositories</h2>
      <p className="text-xs text-muted-foreground">
        Git repositories to take more skills from. Every directory with a SKILL.md becomes a skill,
        with all its files. The repositories are pulled once a day. A skill above wins over a
        repository skill of the same name, and a repository higher in the list wins over a lower
        one. Private repositories on GitHub use the GitHub credential.
      </p>

      {repos.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">None in this set.</p>
      ) : null}

      {repos.map((repo) => (
        <div key={repo.id} className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-mono text-xs">{repo.url}</span>
            <span className="text-xs text-muted-foreground">
              {repo.ref === '' ? 'default branch' : repo.ref}
              {repo.commit ? ` · ${repo.commit.slice(0, 7)}` : ''}
              {repo.pulledAt ? ` · pulled ${new Date(repo.pulledAt).toLocaleString()}` : ''}
            </span>
            <span className="font-mono text-xs break-words">
              {repo.skills.length === 0 ? 'no skills' : repo.skills.join(', ')}
            </span>
            {repo.error ? <span className="text-xs text-warn">{repo.error}</span> : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Pull ${repo.url}`}
            disabled={busy}
            onClick={() => onPull(repo)}
          >
            <RefreshCw />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${repo.url}`}
            className="text-danger"
            disabled={busy}
            onClick={() => onDelete(repo)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Repository URL"
          value={url}
          maxLength={500}
          placeholder="https://github.com/anthropics/skills"
          className="sm:flex-1"
          onChange={(e) => setUrl(e.target.value)}
        />
        <Input
          aria-label="Branch, tag or commit"
          value={ref}
          maxLength={200}
          placeholder="branch, tag or commit"
          className="sm:w-48"
          onChange={(e) => setRef(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || url.trim() === ''}
          onClick={() => void add()}
        >
          <Plus />
          Add
        </Button>
      </div>
    </Card>
  );
}

/** Summary of the merged set that a box using this set gets. */
function Merged({ preview }: { preview: AgentBundlePreview }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-medium">Merged result</h2>
      <p className="text-xs text-muted-foreground">
        The global set with this one laid over it — which is what is actually installed.
      </p>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-xs text-muted-foreground">AGENTS.md</dt>
        <dd className="text-xs">
          {preview.agentsMd === ''
            ? 'none'
            : `${preview.agentsMd.split('\n').length} lines, global first`}
        </dd>
        <dt className="text-xs text-muted-foreground">Skills</dt>
        <dd className="font-mono text-xs break-words">
          {preview.skills.length === 0 ? 'none' : preview.skills.map((s) => s.name).join(', ')}
        </dd>
      </dl>
    </Card>
  );
}

/**
 * Dialog that edits one skill.
 *
 * The name is fixed once the skill exists. A rename in place would leave the
 * old skill installed in every box until its next start.
 */
function ItemDialog({
  item,
  busy,
  onCancel,
  onSave,
}: {
  item: AgentItem | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { name: string; content: string }) => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [content, setContent] = useState(item?.content ?? '');

  // A skill without front matter fails silently in the box, so the dialog warns here.
  const missingFrontMatter = content.trim() !== '' && !content.startsWith('---');

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {item ? `Edit skill ${item.name}` : 'New skill'}
          </DialogTitle>
          <DialogDescription>Installed as skills/&lt;name&gt;/SKILL.md.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="flex flex-col gap-2">
            <Label htmlFor="item-name">Name</Label>
            <Input
              id="item-name"
              value={name}
              disabled={item !== null}
              maxLength={64}
              placeholder="review-go"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {item
                ? 'A name is fixed once it exists. Delete it and add it again to rename it.'
                : 'Lowercase letters, digits and dashes.'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="item-content">SKILL.md</Label>
            <Textarea
              id="item-content"
              value={content}
              className="min-h-64 font-mono text-xs"
              placeholder={
                '---\nname: review-go\ndescription: Review Go code against the house style.\n---\n\nRead the diff and…\n'
              }
              onChange={(e) => setContent(e.target.value)}
            />
            {missingFrontMatter ? (
              <p className="text-xs text-warn">
                A SKILL.md without <code className="font-mono">---</code> front matter naming the
                skill and describing it is not loaded at all.
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || name.trim() === ''}
            onClick={() => onSave({ name: name.trim(), content })}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
