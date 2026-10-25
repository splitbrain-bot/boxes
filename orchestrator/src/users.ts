/**
 * The user of a request, and the claim of the data that has no owner.
 *
 * The reverse proxy in front of the orchestrator authenticates each user and
 * sends the username in the header that AUTH_USER_HEADER names.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { log } from './log.ts';

/** The maximum length of a username, in characters. */
const MAX_USERNAME = 200;

/**
 * The tables with an owner column. The claim changes the owner of the rows in
 * these tables. The threads, the permission requests, the tunnels, the skills
 * and the repositories belong to a box or to a set, so they follow their parent.
 */
const OWNED_TABLES = [
  'boxes',
  'credentials',
  'api_keys',
  'agent_sets',
  'egress_profiles',
  'settings',
  'push_subscriptions',
] as const;

/**
 * Checks if the deployment runs in multi-user mode.
 *
 * @param cfg The config of the deployment.
 * @returns True when AUTH_USER_HEADER names a header.
 */
export function isMultiUser(cfg: Pick<Config, 'AUTH_USER_HEADER'>): boolean {
  return cfg.AUTH_USER_HEADER !== '';
}

/**
 * Gives the owner whose boxes a user can see.
 *
 * @param cfg The config of the deployment.
 * @param user The user.
 * @returns The user in multi-user mode, or null in single user mode, in which the user sees every box.
 */
export function boxScope(cfg: Pick<Config, 'AUTH_USER_HEADER'>, user: string): string | null {
  return isMultiUser(cfg) ? user : null;
}

/**
 * Reads the user of a request from its headers.
 *
 * The username is trimmed and in lowercase, so the comparison of two names is
 * not case-sensitive.
 *
 * @param headers The headers of the request.
 * @param header The name of the header in lowercase, or the empty string for single user mode.
 * @returns The username, the empty user in single user mode, or null when the
 *   header is missing or does not hold a valid username.
 */
export function requestUser(headers: IncomingHttpHeaders, header: string): string | null {
  if (header === '') return '';
  const raw = headers[header];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? '';
  if (value === '' || value.length > MAX_USERNAME) return null;
  return value;
}

/**
 * Checks if a row of an owned table has the empty user as its owner.
 *
 * @param db The database.
 * @returns True when the claim has data to move.
 */
export function hasUnownedData(db: Db): boolean {
  return OWNED_TABLES.some(
    (table) => db.prepare(`SELECT 1 FROM ${table} WHERE owner = '' LIMIT 1`).get() !== undefined,
  );
}

/**
 * Gives the data of the empty user to a user, in one transaction.
 *
 * When two users claim at the same time, the transaction of the second user
 * finds no rows of the empty user. A row whose key the user has already, for
 * example a second credential for the same service, stays with the empty user.
 *
 * @param db The database.
 * @param user The username that gets the data.
 * @returns The number of rows that changed the owner.
 */
export function claimUnownedData(db: Db, user: string): number {
  const moved = db.transaction(() => {
    let count = 0;
    for (const table of OWNED_TABLES) {
      count += db
        .prepare(`UPDATE OR IGNORE ${table} SET owner = ? WHERE owner = ''`)
        .run(user).changes;
    }
    return count;
  })();
  if (moved > 0) log.info('gave the data without an owner to a user', { user, rows: moved });
  return moved;
}

/** The page that a browser gets when the request has no valid username. */
export const NO_USER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boxes: no user</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { width: min(28rem, 90vw); text-align: center; }
  p { opacity: 0.7; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<h1>No user</h1>
<p>The reverse proxy in front of Boxes did not send a username with this request.
Log in again, or tell the operator of this deployment.</p>
</main>
</body>
</html>
`;

/** The content security policy of the page without a user. */
export const NO_USER_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
