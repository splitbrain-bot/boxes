/**
 * The dev tunnels that processes in boxes host: which box serves which
 * tunnel, and the removal of the tunnels that no box serves any more.
 *
 * A box serves a tunnel while a `devtunnel host <id>.<region>` process runs
 * in it. The orchestrator remembers every tunnel it has seen served, and
 * deletes only those. The account is the GitHub account of a person, and the
 * orchestrator must not delete its other tunnels.
 */

import type { BoxTunnel } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { log } from './log.ts';

/** How long a remembered tunnel may go unserved before it is deleted, in milliseconds. */
export const TUNNEL_GRACE_MS = 5 * 60_000;

/** The API version the service's own CLI and SDK use. */
const API_VERSION = '2023-09-27-preview';

/** How long one API call may take, in milliseconds. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The id and region of a tunnel, as `devtunnel host` names it. */
export interface TunnelRef {
  /** The tunnel id. */
  id: string;
  /** The region it lives in, such as `euw`. */
  cluster: string;
}

/** A tunnel as the API describes it, reduced to what this module reads. */
export interface RemoteTunnel extends TunnelRef {
  /** The tunnel's labels. */
  labels: string[];
  /** Its ports, each with the public URL the service gave it. */
  ports: Array<{ port: number; url: string | null }>;
}

/** The Dev Tunnels API calls this module makes. An interface, so tests can fake it. */
export interface TunnelApi {
  /**
   * Checks if a token is stored, which every call needs.
   *
   * @returns True when a token is stored.
   */
  available(): boolean;
  /**
   * Returns one tunnel with its ports.
   *
   * @param ref The tunnel.
   * @returns The tunnel, or null when it does not exist.
   * @throws Error when the call fails.
   */
  get(ref: TunnelRef): Promise<RemoteTunnel | null>;
  /**
   * Replaces a tunnel's labels.
   *
   * @param ref The tunnel.
   * @param labels The new labels.
   * @throws Error when the call fails.
   */
  setLabels(ref: TunnelRef, labels: string[]): Promise<void>;
  /**
   * Deletes a tunnel. A tunnel that is already gone counts as deleted.
   *
   * @param ref The tunnel.
   * @throws Error when the call fails.
   */
  remove(ref: TunnelRef): Promise<void>;
}

/**
 * What one reading of a box found: the command lines running in it, or null
 * when the box could not be read and so serves an unknown set of tunnels.
 */
export interface BoxReading {
  /** The box id. */
  boxId: string;
  /** Every process command line, empty for a box that is not running, or null. */
  commands: string[] | null;
}

/**
 * Returns the tunnels that `devtunnel host` processes serve, from their command
 * lines. Only the `<id>.<region>` form counts, because every later call
 * needs the region.
 *
 * @param commands The command lines of the processes in a box.
 * @returns The tunnels, one per tunnel id.
 */
export function hostedTunnels(commands: readonly string[]): TunnelRef[] {
  const found = new Map<string, TunnelRef>();
  for (const command of commands) {
    const match = /(?:^|[\s/])devtunnel\s+host\s+([a-z0-9]+)\.([a-z0-9]+)(?=\s|$)/i.exec(command);
    if (match?.[1] && match[2]) {
      const id = match[1].toLowerCase();
      found.set(id, { id, cluster: match[2].toLowerCase() });
    }
  }
  return [...found.values()];
}

/**
 * Returns the label that marks a tunnel as one this deployment watches.
 *
 * @param deploymentId The id of the deployment.
 * @returns The label.
 */
export function deploymentLabel(deploymentId: string): string {
  return `boxes-${deploymentId}`;
}

/**
 * Returns the label that names the box a tunnel belongs to.
 *
 * @param deploymentId The id of the deployment.
 * @param boxId The box id.
 * @returns The label.
 */
export function boxLabel(deploymentId: string, boxId: string): string {
  return `boxes-${deploymentId}-box-${boxId}`;
}

/**
 * Returns the API calls against the real service, authenticated with the stored GitHub token.
 *
 * @param token Returns the stored GitHub token, or null when none is stored.
 * @returns The API.
 */
export function devTunnelsApi(token: () => string | null): TunnelApi {
  /**
   * Sends one request.
   *
   * @param host The API host.
   * @param path The path, with an optional query.
   * @param init The method and the JSON body.
   * @returns The response.
   * @throws Error when no token is stored.
   */
  const call = async (
    host: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> => {
    const secret = token();
    if (!secret) throw new Error('no Dev Tunnels login is stored');
    const separator = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://${host}${path}${separator}api-version=${API_VERSION}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `github ${secret}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json', 'if-match': '*' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res;
  };
  /**
   * Returns the API host of one region.
   *
   * @param cluster The region.
   * @returns The host name.
   */
  const regional = (cluster: string): string => `${cluster}.rel.tunnels.api.visualstudio.com`;

  return {
    available: () => Boolean(token()),

    async get(ref) {
      const res = await call(regional(ref.cluster), `/tunnels/${ref.id}?includePorts=true`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} reading tunnel ${ref.id}`);
      return toRemote(await res.json());
    },

    async setLabels(ref, labels) {
      // Only the fields sent change.
      const res = await call(regional(ref.cluster), `/tunnels/${ref.id}`, {
        method: 'PUT',
        body: { tunnelId: ref.id, labels },
      });
      if (!res.ok) throw new Error(`${res.status} labelling tunnel ${ref.id}`);
    },

    async remove(ref) {
      const res = await call(regional(ref.cluster), `/tunnels/${ref.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`${res.status} deleting tunnel ${ref.id}`);
    },
  };
}

/**
 * Reads one tunnel object from an API answer.
 *
 * @param raw The parsed JSON of the answer.
 * @returns The tunnel.
 */
export function toRemote(raw: unknown): RemoteTunnel {
  const t = (raw ?? {}) as {
    tunnelId?: unknown;
    clusterId?: unknown;
    labels?: unknown;
    ports?: Array<{ portNumber?: unknown; portForwardingUris?: unknown }>;
  };
  return {
    id: String(t.tunnelId ?? ''),
    cluster: String(t.clusterId ?? ''),
    labels: Array.isArray(t.labels)
      ? t.labels.filter((l): l is string => typeof l === 'string')
      : [],
    ports: (t.ports ?? []).map((p) => ({
      port: Number(p.portNumber ?? 0),
      url: Array.isArray(p.portForwardingUris)
        ? (p.portForwardingUris.find(
            (u): u is string => typeof u === 'string' && onDefaultPort(u),
          ) ?? null)
        : null,
    })),
  };
}

/**
 * Checks if a URL names no port of its own. The service also offers
 * the URL of each port on that port number, which the network of a visitor
 * can block.
 *
 * @param url The URL.
 * @returns True for a URL on the default port of its scheme.
 */
function onDefaultPort(url: string): boolean {
  try {
    return new URL(url).port === '';
  } catch {
    return false;
  }
}

/** One row of the tunnels table. */
interface TunnelRow {
  /** The tunnel id. */
  id: string;
  /** Its region. */
  cluster: string;
  /** The box that served it last. */
  box_id: string;
  /** Its ports, as JSON: an array of `{ port, url }`. */
  ports: string;
  /** When it was first found unserved, in epoch milliseconds, or null while served. */
  unserved_since: number | null;
  /** When it was first seen served, in epoch milliseconds. */
  created_at: number;
}

/**
 * Keeps the tunnels table in line with what the boxes serve, and deletes the
 * remembered tunnels that no box has served for TUNNEL_GRACE_MS.
 *
 * The reconciler calls the API only when a box starts serving a tunnel that
 * is not remembered for that box, and when it deletes a tunnel.
 */
export class TunnelReconciler {
  /**
   * @param db The database that holds the tunnels table.
   * @param api The Dev Tunnels API.
   * @param deploymentId The id that the labels of this deployment carry.
   * @param readBoxes Reads every box that has not been deleted.
   * @param now The clock, in epoch milliseconds.
   */
  constructor(
    /** The database that holds the tunnels table. */
    private readonly db: Db,
    /** The Dev Tunnels API. */
    private readonly api: TunnelApi,
    /** The id this deployment's labels carry. */
    private readonly deploymentId: string,
    /** Reads every box that has not been deleted. */
    private readonly readBoxes: () => Promise<BoxReading[]>,
    /** The clock, in epoch milliseconds. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns the ports of the tunnels a box serves.
   *
   * @param boxId The box id.
   * @returns One entry per port, in the order the tunnels were first seen.
   */
  forBox(boxId: string): BoxTunnel[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tunnels WHERE box_id = ? AND unserved_since IS NULL ORDER BY created_at',
      )
      .all(boxId) as TunnelRow[];
    return rows.flatMap((row) => toBoxTunnels(row));
  }

  /**
   * Records the tunnels a box serves, as a tick does, for tests.
   *
   * @param boxId The box id.
   * @param tunnels The tunnels with their ports.
   */
  setServedForTests(boxId: string, tunnels: BoxTunnel[]): void {
    for (const t of tunnels) {
      this.remember(boxId, { id: t.id, cluster: t.cluster }, [{ port: t.port, url: t.url }]);
    }
  }

  /**
   * Reads every box, remembers the tunnels the boxes serve, and deletes the
   * remembered tunnels that have gone unserved for TUNNEL_GRACE_MS.
   */
  async tick(): Promise<void> {
    if (!this.api.available()) return;
    const readings = await this.readBoxes();
    // A box that could not be read keeps its tunnels as they are, because the
    // reading says nothing about them.
    const unknownBoxes = new Set(readings.filter((r) => r.commands === null).map((r) => r.boxId));
    const servedIds = new Set<string>();

    for (const reading of readings) {
      for (const ref of hostedTunnels(reading.commands ?? [])) {
        servedIds.add(ref.id);
        await this.serve(reading.boxId, ref);
      }
    }

    const now = this.now();
    const rows = this.db.prepare('SELECT * FROM tunnels').all() as TunnelRow[];
    for (const row of rows) {
      if (servedIds.has(row.id) || unknownBoxes.has(row.box_id)) continue;
      if (row.unserved_since === null) {
        this.db.prepare('UPDATE tunnels SET unserved_since = ? WHERE id = ?').run(now, row.id);
        continue;
      }
      if (now - row.unserved_since < TUNNEL_GRACE_MS) continue;
      try {
        await this.api.remove(row);
        this.db.prepare('DELETE FROM tunnels WHERE id = ?').run(row.id);
        log.info('deleted a tunnel no box serves any more', { tunnel: row.id, box: row.box_id });
      } catch (err) {
        log.warn('could not delete an unserved tunnel', {
          tunnel: row.id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Marks a remembered tunnel as served by a box, or reads and labels a new
   * one and remembers it. A tunnel the API does not know is skipped.
   *
   * @param boxId The box id.
   * @param ref The tunnel.
   */
  private async serve(boxId: string, ref: TunnelRef): Promise<void> {
    const row = this.db.prepare('SELECT * FROM tunnels WHERE id = ?').get(ref.id) as
      | TunnelRow
      | undefined;
    if (row && row.box_id === boxId) {
      if (row.unserved_since !== null) {
        this.db.prepare('UPDATE tunnels SET unserved_since = NULL WHERE id = ?').run(ref.id);
      }
      return;
    }

    let remote: RemoteTunnel | null;
    try {
      remote = await this.api.get(ref);
    } catch (err) {
      log.warn('could not read a tunnel a box hosts', {
        box: boxId,
        tunnel: ref.id,
        error: (err as Error).message,
      });
      return;
    }
    if (!remote) return;

    // The labels that this deployment set for another box are removed, so that
    // a tunnel names one box.
    const mine = deploymentLabel(this.deploymentId);
    const labels = [
      ...remote.labels.filter((l) => l !== mine && !l.startsWith(`${mine}-box-`)),
      mine,
      boxLabel(this.deploymentId, boxId),
    ];
    try {
      await this.api.setLabels(ref, labels);
    } catch (err) {
      // The cleanup works without the label.
      log.warn('could not label a tunnel a box hosts', {
        box: boxId,
        tunnel: ref.id,
        error: (err as Error).message,
      });
    }
    this.remember(boxId, ref, remote.ports);
  }

  /**
   * Writes a tunnel as served by a box, replacing what was remembered about it.
   *
   * @param boxId The box id.
   * @param ref The tunnel.
   * @param ports The ports of the tunnel.
   */
  private remember(boxId: string, ref: TunnelRef, ports: RemoteTunnel['ports']): void {
    this.db
      .prepare(
        `INSERT INTO tunnels (id, cluster, box_id, ports, unserved_since, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET cluster = excluded.cluster, box_id = excluded.box_id,
           ports = excluded.ports, unserved_since = NULL`,
      )
      .run(ref.id, ref.cluster, boxId, JSON.stringify(ports), this.now());
  }
}

/**
 * Returns the ports of one remembered tunnel, as the dashboard shows them.
 *
 * @param row The row of the tunnel.
 * @returns One entry per port, or none when the stored ports cannot be read.
 */
function toBoxTunnels(row: TunnelRow): BoxTunnel[] {
  let ports: RemoteTunnel['ports'];
  try {
    ports = JSON.parse(row.ports) as RemoteTunnel['ports'];
  } catch {
    return [];
  }
  return ports.map((p) => ({
    id: row.id,
    cluster: row.cluster,
    port: p.port,
    url:
      p.url !== null && onDefaultPort(p.url)
        ? p.url
        : `https://${row.id}-${p.port}.${row.cluster}.devtunnels.ms/`,
  }));
}
