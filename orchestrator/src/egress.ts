import { randomBytes } from 'node:crypto';
import { generateCACertificate } from 'mockttp';
import type {
  EgressCredential,
  EgressHealth,
  EgressPolicy,
  EgressStatus,
} from '../../shared/types.ts';
import type { Config } from './config.ts';
import { deliverableSecret, type CredentialRow, type CredentialStore } from './credentials.ts';
import { readAppKey, writeAppKey, type Db } from './db.ts';
import { log } from './log.ts';

/** The orchestrator side of the egress proxy: its policy and key material. */

/** The app key under which the CA and the control token are stored. */
const APP_KEY = 'egress';

/** How long a control-channel call may take, in milliseconds. */
const CONTROL_TIMEOUT_MS = 5_000;

/**
 * Everything generated once and then reused for the life of a deployment.
 * Running boxes trust the CA, so it must survive a restart.
 */
export interface EgressMaterial {
  /** The deployment CA. Its certificate is public; its key is not. */
  ca: { key: string; cert: string };
  /** Bearer the orchestrator authenticates its pushes with. */
  controlToken: string;
}

/**
 * Loads the deployment's egress material, generating and storing it on first
 * use. Deleting the row rotates it.
 */
export async function resolveEgressMaterial(db: Db): Promise<EgressMaterial> {
  const stored = readAppKey<EgressMaterial>(db, APP_KEY);
  if (stored) return stored;

  // The proxy's own library generates it, so the proxy accepts the key.
  const ca = await generateCACertificate({ subject: { commonName: 'Boxes egress proxy CA' } });
  const material: EgressMaterial = { ca, controlToken: randomBytes(32).toString('hex') };
  writeAppKey(db, APP_KEY, material);
  log.info('generated an egress CA for this deployment');
  return material;
}

/**
 * Builds the policy the proxy runs, from the deployment's settings, the
 * stored material and the current rows of the credential store.
 *
 * The policy always carries the CA, as boxes created before the first
 * credential already trust it. A host is only intercepted while its
 * credential has a deliverable secret.
 */
export function composePolicy(
  cfg: Config,
  material: EgressMaterial,
  stored: readonly CredentialRow[],
): EgressPolicy {
  // A credential with no deliverable secret counts as absent.
  const secrets = new Map(stored.map((row) => [row.id, deliverableSecret(row) ?? '']));
  const configured = cfg.credentialSet.filter((spec) => (secrets.get(spec.id) ?? '') !== '');

  const placeholders = new Map(stored.map((row) => [row.id, row.placeholder]));
  const credentials: EgressCredential[] = configured.map((spec) => ({
    id: spec.id,
    hosts: [...spec.hosts],
    headers: [...spec.headers],
    ...(spec.passthroughSchemes ? { passthroughSchemes: [...spec.passthroughSchemes] } : {}),
    placeholder: placeholders.get(spec.id) ?? '',
    secret: secrets.get(spec.id) ?? '',
  }));

  // The proxy allows a credential's own hosts. The other hosts its tools
  // need are added here, so an allowlist cannot break an OAuth refresh.
  const implied = configured.flatMap((spec) => [...spec.alsoAllow]);
  const allowedHosts =
    cfg.egressAllowedHosts.length === 0
      ? []
      : [...new Set([...cfg.egressAllowedHosts, ...implied])];

  return {
    allowedHosts,
    ca: material.ca,
    credentials,
  };
}

/** Pushes a policy to the proxy and returns what it reports back. */
export async function pushPolicy(
  cfg: Config,
  material: EgressMaterial,
  policy: EgressPolicy,
): Promise<EgressStatus> {
  return controlCall(cfg, material, 'POST', '/policy', policy);
}

/** One authenticated call on the control channel, returning the proxy's status. */
async function controlCall(
  cfg: Config,
  material: EgressMaterial,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<EgressStatus> {
  const url = `http://${cfg.EGRESS_PROXY_CONTAINER}:${cfg.EGRESS_CONTROL_PORT}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${material.controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    const detail = (() => {
      try {
        return (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        return text;
      }
    })();
    throw new Error(`proxy answered ${res.status}: ${detail.trim()}`);
  }
  return JSON.parse(text) as EgressStatus;
}

/**
 * Owns the composed policy and keeps the proxy holding it.
 *
 * Real credentials leave this process only over the control channel, into
 * the proxy's memory. A proxy restart loses the policy, and the push is
 * idempotent, so the reconciler pushes it again on every tick.
 */
export class EgressManager {
  /** The loaded material, or null before prepare(). */
  private material: EgressMaterial | null = null;
  /** The last composed policy, or null before prepare(). */
  private composed: EgressPolicy | null = null;
  /** What the last push reported, or null before the first. */
  private health: EgressHealth | null = null;

  constructor(
    /** The deployment's configuration. */
    private readonly cfg: Config,
    /**
     * Where the secrets come from. The manager only reads it, on every
     * compose.
     */
    private readonly credentials: CredentialStore,
    /** Where the CA and the control token are kept. */
    private readonly db: Db,
  ) {}

  /** Loads the material and composes the policy, without talking to the proxy. */
  async prepare(): Promise<void> {
    this.material = await resolveEgressMaterial(this.db);
    this.composed = composePolicy(this.cfg, this.material, this.credentials.list());
  }

  /** The CA certificate a box is given to trust. Public, never the key. */
  caCertificate(): string {
    return this.prepared().material.ca.cert;
  }

  /**
   * The prepared state. Throws before prepare(), so no box is built without
   * the placeholders and the CA.
   */
  private prepared(): { material: EgressMaterial; composed: EgressPolicy } {
    if (!this.material || !this.composed) {
      throw new Error('the egress policy has not been prepared yet');
    }
    return { material: this.material, composed: this.composed };
  }

  /**
   * What a box holds in place of a credential, or the empty string for one
   * that is not stored. The empty string drops the variable from the box's
   * environment.
   */
  placeholderFor(id: string): string {
    return this.credentials.placeholderFor(id);
  }

  /** The last thing the proxy reported, for /healthz. */
  status(): EgressHealth | null {
    return this.health;
  }

  /**
   * Recomposes the policy from the store, pushes it, and records what the
   * proxy reported. Every store write and every reconciler tick calls it.
   */
  async sync(): Promise<void> {
    if (!this.material) await this.prepare();
    const material = this.prepared().material;
    const composed = composePolicy(this.cfg, material, this.credentials.list());
    this.composed = composed;

    try {
      const status = await pushPolicy(this.cfg, material, composed);
      this.health = {
        inSync: status.applied,
        allowlistActive: composed.allowedHosts.length > 0,
        credentialIds: status.credentialIds,
        denials: status.denials,
        error: null,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.health = {
        inSync: false,
        allowlistActive: composed.allowedHosts.length > 0,
        credentialIds: [],
        denials: this.health?.denials ?? {},
        error: message,
      };
      throw err;
    }
  }
}
