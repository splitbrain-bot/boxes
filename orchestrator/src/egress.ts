/** The orchestrator side of the egress proxy: its policy and key material. */

import { randomBytes } from 'node:crypto';
import { generateCACertificate } from 'mockttp';
import type {
  EgressCredential,
  EgressHealth,
  EgressPolicy,
  EgressStatus,
} from '../../shared/types.ts';
import type { ApiKeyRow, ApiKeyStore } from './api-keys.ts';
import type { Config, CredentialSpec } from './config.ts';
import {
  type CredentialId,
  type CredentialMethod,
  type CredentialRow,
  type CredentialStore,
  deliverableSecret,
} from './credentials.ts';
import { type Db, readAppKey, writeAppKey } from './db.ts';
import { log } from './log.ts';

/** The app key under which the CA and the control token are stored. */
const APP_KEY = 'egress';

/** How long a control-channel call may take, in milliseconds. */
const CONTROL_TIMEOUT_MS = 5_000;

/**
 * Everything generated once and then reused for the life of a deployment.
 * Running boxes trust the CA, so it must survive a restart.
 */
export interface EgressMaterial {
  /** The deployment CA. The certificate is public, and the key is secret. */
  ca: { key: string; cert: string };
  /** The bearer token that authenticates the calls of the orchestrator on the control channel. */
  controlToken: string;
}

/**
 * Loads the deployment's egress material, generating and storing it on first
 * use. Deleting the row rotates it.
 *
 * @param db The database that holds the material.
 * @returns The material.
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
 * Gives the id of a credential in the policy. The owner is the prefix, because
 * the ids must be unique and each user can store each credential. The empty
 * user has no prefix.
 *
 * @param owner The owner of the credential.
 * @param id The id of the credential for its owner.
 * @returns The id in the policy.
 */
export function policyId(owner: string, id: string): string {
  return owner === '' ? id : `${owner}/${id}`;
}

/**
 * Gives the id of an API key in the policy.
 *
 * @param key The API key.
 * @returns The id in the policy.
 */
function apiKeyPolicyId(key: ApiKeyRow): string {
  return `api-key:${policyId(key.owner, key.name)}`;
}

/**
 * Builds the policy the proxy runs, from the deployment's settings, the
 * stored material and the current rows of the credential store and the API
 * key store, for every user.
 *
 * The policy always carries the CA, as boxes created before the first
 * credential already trust it. The proxy intercepts a host only while a
 * credential for it has a deliverable secret. One host can have a credential
 * of each user. The proxy selects the credential whose placeholder is in the
 * request. An API key names no header, so the proxy swaps it in whatever
 * header carries its placeholder.
 *
 * @param cfg The configuration of the deployment.
 * @param material The CA and the control token.
 * @param stored The rows of the credential store.
 * @param apiKeys The rows of the API key store.
 * @returns The policy for the proxy.
 */
export function composePolicy(
  cfg: Config,
  material: EgressMaterial,
  stored: readonly CredentialRow[],
  apiKeys: readonly ApiKeyRow[],
): EgressPolicy {
  const credentials: EgressCredential[] = [];
  const configured = new Set<CredentialSpec>();
  for (const spec of cfg.credentialSet) {
    for (const row of stored) {
      // A credential with no deliverable secret counts as absent.
      const secret = row.id === spec.id ? deliverableSecret(row) : null;
      if (!secret) continue;
      configured.add(spec);
      credentials.push({
        id: policyId(row.owner, spec.id),
        hosts: [...spec.hosts],
        headers: [...spec.headers],
        ...(spec.passthroughSchemes ? { passthroughSchemes: [...spec.passthroughSchemes] } : {}),
        placeholder: row.placeholder,
        secret,
      });
    }
  }
  for (const key of apiKeys) {
    credentials.push({
      id: apiKeyPolicyId(key),
      hosts: [...key.hosts],
      headers: [],
      placeholder: key.placeholder,
      secret: key.secret,
    });
  }

  // The proxy allows a credential's own hosts. The other hosts its tools
  // need are added here, so an allowlist cannot break an OAuth refresh.
  const implied = [...configured].flatMap((spec) => [...spec.alsoAllow]);
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

/**
 * Pushes a policy to the proxy.
 *
 * @param cfg The configuration of the deployment, with the URL of the control channel.
 * @param material The material with the control token.
 * @param policy The policy to push.
 * @returns The status that the proxy reports back.
 * @throws Error When the call fails or the proxy answers with an error status.
 */
export async function pushPolicy(
  cfg: Config,
  material: EgressMaterial,
  policy: EgressPolicy,
): Promise<EgressStatus> {
  return controlCall(cfg, material, 'POST', '/policy', policy);
}

/**
 * Makes one authenticated call on the control channel.
 *
 * @param cfg The configuration of the deployment, with the URL of the control channel.
 * @param material The material with the control token.
 * @param method The HTTP method.
 * @param path The path on the control channel.
 * @param body The JSON body, or undefined for a call without a body.
 * @returns The status that the proxy reports back.
 * @throws Error When the call fails, times out after CONTROL_TIMEOUT_MS, or the proxy answers with an error status.
 */
async function controlCall(
  cfg: Config,
  material: EgressMaterial,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<EgressStatus> {
  const url = new URL(path, cfg.EGRESS_CONTROL_URL);
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
 * The owner of the composed egress policy, which it pushes to the proxy.
 *
 * Real credentials leave this process only over the control channel, into
 * the proxy's memory. A proxy restart loses the policy, and the push is
 * idempotent, so the reconciler pushes it again on every tick.
 */
export class EgressManager {
  /** The loaded material, or null before prepare(). */
  private material: EgressMaterial | null = null;
  /** The health that the last push reported, or null before the first push. */
  private health: EgressHealth | null = null;

  /**
   * @param cfg The configuration of the deployment.
   * @param credentials The source of the secrets.
   * @param apiKeys The source of the API keys.
   * @param db The database that holds the CA and the control token.
   */
  constructor(
    /** The deployment's configuration. */
    private readonly cfg: Config,
    /** The source of the secrets, read on every compose. */
    private readonly credentials: CredentialStore,
    /** The source of the API keys, read on every compose. */
    private readonly apiKeys: ApiKeyStore,
    /** Where the CA and the control token are kept. */
    private readonly db: Db,
  ) {}

  /** Loads the material, without talking to the proxy. */
  async prepare(): Promise<void> {
    this.material = await resolveEgressMaterial(this.db);
  }

  /**
   * Returns the CA certificate that a box trusts.
   *
   * @returns The certificate, without the key.
   * @throws Error Before prepare().
   */
  caCertificate(): string {
    return this.prepared().ca.cert;
  }

  /**
   * Returns the prepared material. It throws before prepare(), so no box is built
   * without the CA.
   *
   * @returns The material.
   * @throws Error Before prepare().
   */
  private prepared(): EgressMaterial {
    if (!this.material) throw new Error('the egress policy has not been prepared yet');
    return this.material;
  }

  /**
   * Returns the placeholder that stands for a credential of a user in a box.
   * The empty string drops the variable from the environment of the box.
   *
   * @param owner The user.
   * @param id The id of the credential.
   * @returns The placeholder, or the empty string for a credential that is not stored.
   */
  placeholderFor(owner: string, id: string): string {
    return this.credentials.placeholderFor(owner, id);
  }

  /**
   * Returns the placeholder of each stored API key of a user.
   *
   * @param owner The user.
   * @returns The placeholders, by the name of the variable in a box.
   */
  apiKeyEnv(owner: string): Record<string, string> {
    return Object.fromEntries(this.apiKeys.list(owner).map((key) => [key.name, key.placeholder]));
  }

  /**
   * Returns how a stored credential of a user was obtained.
   *
   * @param owner The user.
   * @param id The id of the credential.
   * @returns The method, or null for a credential that is not stored.
   */
  methodFor(owner: string, id: CredentialId): CredentialMethod | null {
    return this.credentials.get(owner, id)?.method ?? null;
  }

  /**
   * Returns the last health that the proxy reported.
   *
   * @returns The health, or null before the first push.
   */
  status(): EgressHealth | null {
    return this.health;
  }

  /**
   * Returns the last health that the proxy reported, with only the credential
   * ids of one user, for /healthz. The ids of the other users name those users.
   *
   * @param owner The user.
   * @returns The health, or null before the first push.
   */
  statusFor(owner: string): EgressHealth | null {
    if (!this.health) return null;
    const own = new Set([
      ...this.credentials.list(owner).map((row) => policyId(owner, row.id)),
      ...this.apiKeys.list(owner).map(apiKeyPolicyId),
    ]);
    return {
      ...this.health,
      credentialIds: this.health.credentialIds.filter((id) => own.has(id)),
    };
  }

  /**
   * Recomposes the policy from the store, pushes it, and records what the
   * proxy reported. The boot, every store write and every reconciler tick call it.
   *
   * @throws Error When the push fails. The health then records the error.
   */
  async sync(): Promise<void> {
    if (!this.material) await this.prepare();
    const material = this.prepared();
    const composed = composePolicy(
      this.cfg,
      material,
      this.credentials.listAll(),
      this.apiKeys.listAll(),
    );

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
