/** The store of the secrets of the remote MCP servers of the agent sets. */

import { randomBytes } from 'node:crypto';
import type { AgentMcpAuth, AgentMcpHeader, AgentMcpTokenStatus } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { HttpError } from './http-error.ts';

/** The header, in lower case, that holds the token of an OAuth server. */
export const OAUTH_HEADER = 'authorization';

/** The number of random bytes in a placeholder. */
const PLACEHOLDER_BYTES = 32;

/** One row of the agent_mcp_secrets table, with one secret header of a server. */
export interface McpSecretRow {
  /** The set of the server. */
  set_id: string;
  /** The name of the server. */
  server: string;
  /** The header name in lower case. */
  header: string;
  /** The full header value, for example "Bearer <token>", or '' for an OAuth server without a token. */
  secret: string;
  /** The value that the box gets in place of the secret. It stays the same while the row exists. */
  placeholder: string;
  /** The JSON document of the OAuth login, or null for a server without OAuth or before the first connect. */
  oauth: string | null;
  /** The expiry of the OAuth token in epoch milliseconds, or null for a token without a known expiry. */
  expires_at: number | null;
  /** The time of the last token from a login or a refresh, in epoch milliseconds, or null. */
  refreshed_at: number | null;
  /** The status of the OAuth token. A secret without OAuth always has the status `ok`. */
  status: AgentMcpTokenStatus;
  /** The reason of the last failure of the OAuth token, or null. */
  last_error: string | null;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last write. */
  updated_at: number;
}

/** A secret row, with the facts of its server that the egress policy and the OAuth client need. */
export interface McpSecretEntry extends McpSecretRow {
  /** The owner of the set of the server. */
  owner: string;
  /** The URL of the server. */
  url: string;
  /** The auth mode of the server. */
  auth: AgentMcpAuth;
}

/** The query of the secret rows with the facts of their servers. */
const ENTRY_QUERY = `
  SELECT s.*, a.owner AS owner, m.url AS url, m.auth AS auth
    FROM agent_mcp_secrets s
    JOIN agent_mcp_servers m ON m.set_id = s.set_id AND m.name = s.server
    JOIN agent_sets a ON a.id = s.set_id`;

/** The store of the agent_mcp_secrets table. */
export class McpSecretStore {
  /**
   * @param db The database that holds the table.
   * @param onChange The function that the store calls after each write of a token or a status.
   */
  constructor(
    /** The database that holds the table. */
    private readonly db: Db,
    /** Pushes the egress policy again, so a new token applies at once. */
    private readonly onChange: () => void,
  ) {}

  /**
   * Gives one secret row with the facts of its server.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   * @param header The header name in lower case.
   * @returns The row, or undefined when the server has no secret for the header.
   */
  get(setId: string, server: string, header: string): McpSecretEntry | undefined {
    return this.db
      .prepare(`${ENTRY_QUERY} WHERE s.set_id = ? AND s.server = ? AND s.header = ?`)
      .get(setId, server, header) as McpSecretEntry | undefined;
  }

  /**
   * Lists the secret rows of one server.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   * @returns The rows.
   */
  forServer(setId: string, server: string): McpSecretRow[] {
    return this.db
      .prepare('SELECT * FROM agent_mcp_secrets WHERE set_id = ? AND server = ?')
      .all(setId, server) as McpSecretRow[];
  }

  /**
   * Lists the secret rows of every user, for the egress policy and the refresh.
   *
   * @returns The rows with the facts of their servers.
   */
  listAll(): McpSecretEntry[] {
    return this.db.prepare(ENTRY_QUERY).all() as McpSecretEntry[];
  }

  /**
   * Writes the secret rows of a server after a save of the server. An OAuth
   * server gets a row without a token, when it has no row yet. A secret
   * header with a new value gets the value, and a secret header with an
   * empty value keeps the stored value. The method deletes each other row of
   * the server.
   *
   * The method runs in the transaction of the save, so the caller pushes the
   * egress policy after the commit.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   * @param auth The auth mode of the server.
   * @param headers The checked headers of the save, with the new values of the secret headers.
   * @throws {HttpError} A 400 when a secret header without a stored value has an empty value.
   */
  writeForServer(
    setId: string,
    server: string,
    auth: AgentMcpAuth,
    headers: readonly AgentMcpHeader[],
  ): void {
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO agent_mcp_secrets (set_id, server, header, secret, placeholder, status,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(set_id, server, header) DO UPDATE SET
         secret = excluded.secret, updated_at = excluded.updated_at`,
    );
    const stored = new Set(this.forServer(setId, server).map((row) => row.header));
    const wanted = new Set<string>();

    if (auth === 'oauth') {
      wanted.add(OAUTH_HEADER);
      if (!stored.has(OAUTH_HEADER)) {
        insert.run(setId, server, OAUTH_HEADER, '', placeholder(), 'disconnected', now, now);
      }
    }
    for (const header of headers) {
      if (!header.secret) continue;
      const lower = header.name.toLowerCase();
      wanted.add(lower);
      if (header.value !== '') {
        insert.run(setId, server, lower, header.value, placeholder(), 'ok', now, now);
      } else if (!stored.has(lower)) {
        throw new HttpError(400, `headers: enter the value of the secret header ${header.name}`);
      }
    }

    const remove = this.db.prepare(
      'DELETE FROM agent_mcp_secrets WHERE set_id = ? AND server = ? AND header = ?',
    );
    for (const header of stored) {
      if (!wanted.has(header)) remove.run(setId, server, header);
    }
  }

  /**
   * Stores a new OAuth token of a server, and sets the status `ok`.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   * @param token The header value with the token, the OAuth document and the times of the token.
   * @throws {HttpError} A 404 when the server or its row does not exist.
   */
  putToken(
    setId: string,
    server: string,
    token: Pick<McpSecretRow, 'secret' | 'oauth' | 'expires_at' | 'refreshed_at'>,
  ): void {
    const info = this.db
      .prepare(
        `UPDATE agent_mcp_secrets SET secret = ?, oauth = ?, expires_at = ?, refreshed_at = ?,
           status = 'ok', last_error = NULL, updated_at = ?
         WHERE set_id = ? AND server = ? AND header = ?`,
      )
      .run(
        token.secret,
        token.oauth,
        token.expires_at,
        token.refreshed_at,
        Date.now(),
        setId,
        server,
        OAUTH_HEADER,
      );
    if (info.changes === 0) throw new HttpError(404, 'No such MCP server');
    this.onChange();
  }

  /**
   * Stores the OAuth document of a server, for example after a new client
   * registration. The token and the status stay.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   * @param oauth The JSON document.
   */
  putOAuth(setId: string, server: string, oauth: string): void {
    this.db
      .prepare(
        `UPDATE agent_mcp_secrets SET oauth = ?, updated_at = ?
          WHERE set_id = ? AND server = ? AND header = ?`,
      )
      .run(oauth, Date.now(), setId, server, OAUTH_HEADER);
  }

  /**
   * Records the status of the OAuth token of a server. The token stays,
   * because the proxy can still send it.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   * @param status The new status.
   * @param error The reason of the failure, or null.
   */
  markStatus(
    setId: string,
    server: string,
    status: AgentMcpTokenStatus,
    error: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE agent_mcp_secrets SET status = ?, last_error = ?, updated_at = ?
          WHERE set_id = ? AND server = ? AND header = ?`,
      )
      .run(status, error, Date.now(), setId, server, OAUTH_HEADER);
    this.onChange();
  }
}

/**
 * Makes a new placeholder. An adapter sends a header value as it is, so the
 * placeholder needs no prefix of a real token.
 *
 * @returns 32 random bytes in hex.
 */
function placeholder(): string {
  return randomBytes(PLACEHOLDER_BYTES).toString('hex');
}
