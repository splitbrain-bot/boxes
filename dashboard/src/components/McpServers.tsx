/** The MCP servers section of the set editor. */
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { hostMatches } from '../../../shared/hosts.ts';
import type { AgentMcpServer, AgentMcpServerState, ApiKeySummary } from '../../../shared/types.ts';

/** The ways of authentication that the dialog offers. */
type AuthKind = 'none' | 'bearer' | 'headers';

/** The pattern of an Authorization value that is a bearer token from one API key. */
const BEARER = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** The pattern of a reference to an API key in a header value. */
const KEY_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The select value that opens the dialog for a new key. The space keeps it
 * apart from every variable name.
 */
const NEW_KEY = 'new key';

/** The host and the port of a server URL. */
interface Target {
  /** The hostname or IP literal, without brackets. */
  host: string;
  /** The port, with the default port of the scheme when the URL names none. */
  port: number;
  /** The host pattern for an API key: the host, with the port when the URL names one. */
  pattern: string;
}

/**
 * Reads the host and the port of a server URL.
 *
 * @param raw The URL as typed.
 * @returns The target, or null when the text is not an http or https URL.
 */
function targetOf(raw: string): Target | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    pattern: url.port !== '' ? url.host : url.hostname,
  };
}

/**
 * The list of MCP servers, with its own add button.
 *
 * @param servers The servers of the set.
 * @param overridden The names of the servers in this set that replace a server of the global set.
 * @param busy True while a change runs, which disables the buttons.
 * @param onAdd Opens the dialog for a new server.
 * @param onEdit Opens the dialog for an existing server.
 * @param onDelete Asks to delete a server.
 */
export function McpSection({
  servers,
  overridden,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  servers: AgentMcpServerState[];
  overridden: Set<string>;
  busy: boolean;
  onAdd: () => void;
  onEdit: (server: AgentMcpServerState) => void;
  onDelete: (server: AgentMcpServerState) => void;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">MCP servers</h2>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Remote MCP servers that give the agent more tools. Each thread gets them over the Streamable
        HTTP transport. A secret, such as a token, goes into an API key. The egress proxy puts it
        into the requests, so it never goes into a box.
      </p>

      {servers.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">None in this set.</p>
      ) : null}

      {servers.map((server) => (
        <div
          key={server.name}
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-mono text-xs">{server.name}</span>
            <span className="truncate text-xs text-muted-foreground">{server.url}</span>
            {overridden.has(server.name) ? (
              <span className="text-xs text-muted-foreground">replaces the global one</span>
            ) : null}
            {server.warning ? <span className="text-xs text-warn">{server.warning}</span> : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Edit ${server.name}`}
            disabled={busy}
            onClick={() => onEdit(server)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete ${server.name}`}
            className="text-danger"
            disabled={busy}
            onClick={() => onDelete(server)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </Card>
  );
}

/**
 * Dialog that edits one MCP server.
 *
 * The user selects an API key, and the dialog writes the reference to it. The
 * name is fixed once the server exists, like the name of a skill.
 *
 * @param server The server to edit, or null for a new server.
 * @param keys The API keys of the user.
 * @param busy True while a save runs, which disables the buttons.
 * @param error The error of the last save, or null.
 * @param onCancel Closes the dialog without a save.
 * @param onSave Saves the server.
 * @param onSaveKey Stores an API key. Resolves to true when that succeeded.
 */
export function McpDialog({
  server,
  keys,
  busy,
  error,
  onCancel,
  onSave,
  onSaveKey,
}: {
  server: AgentMcpServer | null;
  keys: ApiKeySummary[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (body: AgentMcpServer) => void;
  onSaveKey: (name: string, hosts: string[], secret?: string) => Promise<boolean>;
}) {
  const initial = server?.headers ?? [];
  const bearer =
    initial.length === 1 && initial[0]?.name.toLowerCase() === 'authorization'
      ? BEARER.exec(initial[0].value)
      : null;

  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [auth, setAuth] = useState<AuthKind>(
    initial.length === 0 ? 'none' : bearer ? 'bearer' : 'headers',
  );
  const [bearerKey, setBearerKey] = useState(bearer?.[1] ?? '');
  const [headers, setHeaders] = useState(
    initial.length > 0 && !bearer ? initial : [{ name: '', value: '' }],
  );
  /** The header row that gets the new key, or 'bearer', while the key dialog is open. */
  const [newKeyFor, setNewKeyFor] = useState<number | 'bearer' | null>(null);
  /** The value fields of the header rows, for the insert at the cursor. */
  const valueFields = useRef<Array<HTMLInputElement | null>>([]);

  const target = targetOf(url);

  /** The headers that the save sends, from the selected way of authentication. */
  const body: AgentMcpServer['headers'] =
    auth === 'none'
      ? []
      : auth === 'bearer'
        ? [{ name: 'Authorization', value: `Bearer \${${bearerKey}}` }]
        : headers.filter((h) => h.name.trim() !== '' || h.value !== '');
  const referenced = [
    ...new Set(body.flatMap((h) => [...h.value.matchAll(KEY_REFERENCE)].map((m) => m[1] ?? ''))),
  ];
  /** The referenced keys without a host pattern for the host and the port of the server. */
  const mismatched = target
    ? keys.filter(
        (key) =>
          referenced.includes(key.name) &&
          !key.hosts.some((pattern) => hostMatches(target.host, target.port, pattern)),
      )
    : [];

  /**
   * Puts a reference to a key at the cursor of the value field of one header.
   *
   * @param row The index of the header.
   * @param key The environment variable name of the key.
   */
  const insertKey = (row: number, key: string): void => {
    const field = valueFields.current[row];
    setHeaders((rows) =>
      rows.map((h, i) => {
        if (i !== row) return h;
        const start = field?.selectionStart ?? h.value.length;
        const end = field?.selectionEnd ?? start;
        return { ...h, value: `${h.value.slice(0, start)}\${${key}}${h.value.slice(end)}` };
      }),
    );
  };

  /**
   * Sets one field of one header.
   *
   * @param row The index of the header.
   * @param field The field to set.
   * @param value The new value.
   */
  const setHeader = (row: number, field: 'name' | 'value', value: string): void =>
    setHeaders((rows) => rows.map((h, i) => (i === row ? { ...h, [field]: value } : h)));

  const ready =
    name.trim() !== '' &&
    target !== null &&
    (auth !== 'bearer' || bearerKey !== '') &&
    mismatched.length === 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{server ? `Edit MCP server ${server.name}` : 'New MCP server'}</DialogTitle>
          <DialogDescription>A remote server with the Streamable HTTP transport.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              disabled={server !== null}
              maxLength={32}
              placeholder="github"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {server
                ? 'A name is fixed once it exists. Delete it and add it again to rename it.'
                : 'Lowercase letters, digits and dashes. A server of this set replaces a global server with the same name.'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              value={url}
              placeholder="https://api.githubcopilot.com/mcp/"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-auth">Authentication</Label>
            <Select value={auth} onValueChange={(value) => setAuth(value as AuthKind)}>
              <SelectTrigger id="mcp-auth" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="headers">Custom headers</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {auth === 'bearer' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-key">API key</Label>
              <Select
                value={bearerKey}
                onValueChange={(value) =>
                  value === NEW_KEY ? setNewKeyFor('bearer') : setBearerKey(value)
                }
              >
                <SelectTrigger id="mcp-key" className="w-full font-mono">
                  <SelectValue placeholder="Select a key" />
                </SelectTrigger>
                <SelectContent>
                  {keys.map((key) => (
                    <SelectItem key={key.name} value={key.name} className="font-mono">
                      {key.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_KEY}>New key…</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The agent sends <code>Authorization: Bearer</code> with the key.
              </p>
            </div>
          ) : null}

          {auth === 'headers' ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Headers</span>
              <p className="text-xs text-muted-foreground">
                Put each secret into an API key, and insert the key into the value. A literal value,
                such as a tenant name, goes into the box as it is.
              </p>
              {headers.map((header, row) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the rows have no id
                <div key={row} className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    aria-label={`Header ${row + 1} name`}
                    value={header.name}
                    placeholder="X-API-Key"
                    className="font-mono sm:w-48"
                    onChange={(e) => setHeader(row, 'name', e.target.value)}
                  />
                  <Input
                    ref={(el) => {
                      valueFields.current[row] = el;
                    }}
                    aria-label={`Header ${row + 1} value`}
                    value={header.value}
                    placeholder="${INTERNAL_API_KEY}"
                    className="font-mono sm:flex-1"
                    onChange={(e) => setHeader(row, 'value', e.target.value)}
                  />
                  <Select
                    value=""
                    onValueChange={(value) =>
                      value === NEW_KEY ? setNewKeyFor(row) : insertKey(row, value)
                    }
                  >
                    <SelectTrigger
                      aria-label={`Insert key into header ${row + 1}`}
                      className="sm:w-36"
                    >
                      <SelectValue placeholder="Insert key" />
                    </SelectTrigger>
                    <SelectContent>
                      {keys.map((key) => (
                        <SelectItem key={key.name} value={key.name} className="font-mono">
                          {key.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_KEY}>New key…</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove header ${row + 1}`}
                    className="text-danger"
                    onClick={() => setHeaders((rows) => rows.filter((_, i) => i !== row))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setHeaders((rows) => [...rows, { name: '', value: '' }])}
                >
                  <Plus />
                  Add header
                </Button>
              </div>
            </div>
          ) : null}

          {target
            ? mismatched.map((key) => (
                <div key={key.name} className="flex flex-col gap-2 rounded-md border px-3 py-2">
                  <p className="text-xs text-danger">
                    The egress proxy puts the key <code>{key.name}</code> only into requests to{' '}
                    {key.hosts.join(', ')}, and not to {target.pattern}.
                  </p>
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void onSaveKey(key.name, [...key.hosts, target.pattern])}
                    >
                      Add host to key
                    </Button>
                  </div>
                </div>
              ))
            : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !ready}
            onClick={() => onSave({ name: name.trim(), url: url.trim(), headers: body })}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>

      {newKeyFor !== null ? (
        <KeyDialog
          pattern={target?.pattern ?? ''}
          busy={busy}
          onCancel={() => setNewKeyFor(null)}
          onSave={async (key, hosts, secret) => {
            if (!(await onSaveKey(key, hosts, secret))) return;
            if (newKeyFor === 'bearer') setBearerKey(key);
            else insertKey(newKeyFor, key);
            setNewKeyFor(null);
          }}
        />
      ) : null}
    </Dialog>
  );
}

/**
 * Dialog that adds an API key, with the same fields as the Other API keys card
 * on the Settings page.
 *
 * @param pattern The host pattern of the server, which the hosts field starts with.
 * @param busy True while the save runs, which disables the buttons.
 * @param onCancel Closes the dialog without a save.
 * @param onSave Stores the key.
 */
function KeyDialog({
  pattern,
  busy,
  onCancel,
  onSave,
}: {
  pattern: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, hosts: string[], secret: string) => void;
}) {
  const [name, setName] = useState('');
  const [hosts, setHosts] = useState(pattern);
  const [secret, setSecret] = useState('');
  const list = hosts.split(/[\s,]+/).filter((h) => h !== '');

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>
            The key goes into the Other API keys on the Settings page. The egress proxy puts it only
            into requests to its hosts.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mcp-key-name">Environment variable</Label>
          <Input
            id="mcp-key-name"
            className="font-mono"
            placeholder="GITHUB_MCP_TOKEN"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Label htmlFor="mcp-key-hosts">Hosts</Label>
          <Input
            id="mcp-key-hosts"
            placeholder="mcp.example.com"
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
          />
          <Label htmlFor="mcp-key-secret">Key</Label>
          <Input
            id="mcp-key-secret"
            type="password"
            autoComplete="off"
            className="font-mono"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || name.trim() === '' || list.length === 0 || secret.trim() === ''}
            onClick={() => onSave(name.trim(), list, secret.trim())}
          >
            Add key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
