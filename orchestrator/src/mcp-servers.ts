/**
 * Checks and resolution of the remote MCP servers of the agent sets.
 *
 * A header value refers to an API key of the owner as `${NAME}`, and the stored
 * value keeps the reference. Only the placeholder of the key reaches an adapter,
 * and only the egress proxy puts in the key.
 */

import net from 'node:net';
import type { McpServer } from '@agentclientprotocol/sdk';
import { isBlockedAddress } from '../../shared/cidr.ts';
import { hostMatches } from '../../shared/hosts.ts';
import type { AgentMcpServer } from '../../shared/types.ts';
import type { ApiKeyRow } from './api-keys.ts';
import { HttpError } from './http-error.ts';

/** The maximum number of MCP servers in one set. */
export const MAX_MCP_SERVERS = 20;

/** The maximum number of headers of one server. */
const MAX_HEADERS = 20;

/** The maximum length of one header value. */
const MAX_VALUE = 4096;

/** The maximum length of a server URL. */
const MAX_URL = 2048;

/**
 * The pattern of a server name. Claude names the tools of a server
 * `mcp__<server>__<tool>`, and the model API limits a tool name to 64
 * characters, so the name has at most 32 characters.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The pattern of a reference to an API key in a header value. */
const KEY_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The pattern of an HTTP header name, which is an HTTP token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The header names, in lower case, that the MCP client of the agent sets itself. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'transfer-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
]);

/** The API keys of an owner, which the checks of a server read. */
export interface McpContext {
  /** The API keys of the owner. */
  keys: readonly ApiKeyRow[];
}

/** The host and the port that the agent connects to for a server. */
interface Target {
  /** The hostname or IP literal, without brackets. */
  host: string;
  /** The port, with the default port of the scheme when the URL names none. */
  port: number;
}

/**
 * Gives the target of a server URL.
 *
 * @param url The parsed URL.
 * @returns The host and the port.
 */
function targetOf(url: URL): Target {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { host, port };
}

/**
 * Gives the host pattern that the egress proxy allows for a server. The
 * pattern always names the port.
 *
 * @param url The URL of the server.
 * @returns The pattern, as in mcp.example.com:443, or null when the URL is not valid.
 */
export function mcpHostPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const { port } = targetOf(parsed);
  // The hostname of an IPv6 literal keeps its brackets, as the pattern needs.
  return `${parsed.hostname.toLowerCase()}:${port}`;
}

/**
 * Lists the names of the API keys that a header value refers to.
 *
 * @param value The header value.
 * @returns The names, in the order of the references.
 */
function referencesOf(value: string): string[] {
  return [...value.matchAll(KEY_REFERENCE)].map((match) => match[1] ?? '');
}

/**
 * Checks a server that a user saves.
 *
 * @param body The server from the request.
 * @param ctx The keys of the owner.
 * @returns The server, with a trimmed name in lower case, a trimmed URL and trimmed header names.
 * @throws {HttpError} A 400 when a field is not valid.
 */
export function validMcpServer(body: AgentMcpServer, ctx: McpContext): AgentMcpServer {
  const name = body.name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      'name must be lowercase letters, digits and dashes, start with a letter or digit, ' +
        'and be 32 characters or fewer',
    );
  }

  const rawUrl = body.url.trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'url must be an absolute http or https URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(400, 'url must be an absolute http or https URL');
  }
  if (rawUrl.length > MAX_URL) {
    throw new HttpError(400, `url must be ${MAX_URL} characters or fewer`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpError(400, 'url must not contain credentials; put them into a header');
  }
  const target = targetOf(url);
  if (net.isIP(target.host) !== 0 && isBlockedAddress(target.host)) {
    throw new HttpError(400, 'url must not name a private address');
  }

  if (body.headers.length > MAX_HEADERS) {
    throw new HttpError(400, `A server has at most ${MAX_HEADERS} headers`);
  }
  const seen = new Set<string>();
  const headers = body.headers.map((header) => {
    const headerName = header.name.trim();
    const value = header.value;
    if (!HEADER_NAME.test(headerName)) {
      throw new HttpError(400, `headers: ${headerName || 'a name'} is not a valid header name`);
    }
    const lower = headerName.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      throw new HttpError(400, `headers: the agent sets ${headerName} itself`);
    }
    if (seen.has(lower)) throw new HttpError(400, `headers: ${headerName} is given twice`);
    seen.add(lower);
    if (value.length > MAX_VALUE) {
      throw new HttpError(400, `headers: the value of ${headerName} is longer than ${MAX_VALUE}`);
    }
    // A control character could end the header and start another one.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control characters
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new HttpError(400, `headers: the value of ${headerName} holds a control character`);
    }
    if (value.replace(KEY_REFERENCE, '').includes('${')) {
      throw new HttpError(
        400,
        `headers: the value of ${headerName} holds a \${ that is not a reference to an API key`,
      );
    }

    const refs = referencesOf(value);
    if (lower === 'authorization' && refs.length === 0) {
      throw new HttpError(
        400,
        'headers: put the token of the Authorization header into an API key, and refer to it',
      );
    }
    if (refs.length > 0 && url.protocol !== 'https:') {
      throw new HttpError(400, 'url must use https, because an API key goes only over https');
    }
    for (const ref of refs) {
      const key = ctx.keys.find((k) => k.name === ref);
      if (!key) throw new HttpError(400, `headers: there is no API key ${ref}`);
      if (!key.hosts.some((pattern) => hostMatches(target.host, target.port, pattern))) {
        throw new HttpError(
          400,
          `headers: the hosts of the API key ${ref} do not include ${url.host}`,
        );
      }
    }
    return { name: headerName, value };
  });

  return { name, url: rawUrl, headers };
}

/**
 * Finds the reason the agent will probably not reach a stored server. The
 * keys can change after the save.
 *
 * @param server The stored server.
 * @param ctx The keys of the owner.
 * @returns The reason, or null when no problem is known.
 */
export function mcpWarning(server: AgentMcpServer, ctx: McpContext): string | null {
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    return 'The URL is not valid';
  }
  const target = targetOf(url);
  const refs = server.headers.flatMap((header) => referencesOf(header.value));
  for (const ref of refs) {
    const key = ctx.keys.find((k) => k.name === ref);
    if (!key) return `The API key ${ref} does not exist, so the agent does not get this server`;
    if (!key.hosts.some((pattern) => hostMatches(target.host, target.port, pattern))) {
      return `The hosts of the API key ${ref} do not include ${url.host}`;
    }
  }
  return null;
}

/**
 * Makes the `mcpServers` list for an adapter. Each API key reference becomes
 * the placeholder of the key. A server that refers to a key that does not
 * exist is left out, because it would get no credential.
 *
 * @param servers The merged servers of the box, with the `${NAME}` references in the header values.
 * @param key The function that gives an API key of the owner by name.
 * @param skipped Receives the name of each left-out server and the name of its missing key.
 * @returns The list for the adapter.
 */
export function resolveMcpServers(
  servers: readonly AgentMcpServer[],
  key: (name: string) => ApiKeyRow | undefined,
  skipped: (server: string, missingKey: string) => void,
): McpServer[] {
  const resolved: McpServer[] = [];
  for (const server of servers) {
    const missing = server.headers
      .flatMap((header) => referencesOf(header.value))
      .find((ref) => key(ref) === undefined);
    if (missing !== undefined) {
      skipped(server.name, missing);
      continue;
    }
    resolved.push({
      type: 'http',
      name: server.name,
      url: server.url,
      headers: server.headers.map((header) => ({
        name: header.name,
        value: header.value.replace(KEY_REFERENCE, (_, ref: string) => key(ref)?.placeholder ?? ''),
      })),
    });
  }
  return resolved;
}
