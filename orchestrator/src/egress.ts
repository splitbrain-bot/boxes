import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCACertificate } from 'mockttp';
import type {
  EgressCredential,
  EgressHealth,
  EgressPolicy,
  EgressStatus,
} from '../../shared/types.ts';
import { CREDENTIAL_SET, type Config } from './config.ts';
import { deliverableSecret, type CredentialRow, type CredentialStore } from './credentials.ts';
import { log } from './log.ts';
import { writeSecretFile } from './secret.ts';

/**
 * The orchestrator's half of token translation: what the proxy is told, and
 * the key material that has to outlive a restart.
 *
 * Real credentials come from the credential store and never leave this
 * process except over the control channel, into the proxy's memory. A session
 * is given a placeholder in their place, so nothing inside a session container
 * is worth stealing.
 *
 * Two pieces of material must survive a restart, because running sessions hold
 * them in their environment and trust store: the CA the proxy mints
 * interception certificates from, and the placeholders themselves. They live
 * beside the generated WebSocket token, on the orchestrator's own data volume,
 * and are never handed to the proxy as a file.
 */

/** Filename under DATA_DIR holding the CA and the placeholders. */
const MATERIAL_FILE = 'egress-secrets.json';

/** Random bytes in a generated placeholder, before its prefix. */
const PLACEHOLDER_BYTES = 24;

/** How long a control-channel call may take, in milliseconds. */
const CONTROL_TIMEOUT_MS = 5_000;

/** Everything generated once and then reused for the life of a deployment. */
export interface EgressMaterial {
  /** The deployment CA. Its certificate is public; its key is not. */
  ca: { key: string; cert: string };
  /** One placeholder per credential id. Worth nothing on their own. */
  placeholders: Record<string, string>;
  /** Bearer the orchestrator authenticates its pushes with. */
  controlToken: string;
}

/** A placeholder shaped like the credential it stands in for. */
function generatePlaceholder(prefix: string): string {
  return `${prefix}${randomBytes(PLACEHOLDER_BYTES).toString('base64url')}`;
}

/**
 * Loads the deployment's egress material, generating and storing whatever is
 * missing.
 *
 * A running session holds this CA's certificate in the trust file its tools
 * were pointed at, so a CA regenerated on every boot would break TLS against
 * every intercepted host. Rotating it means deleting this file.
 */
export async function resolveEgressMaterial(
  dataDir: string,
  credentials: readonly { id: string; placeholderPrefix: string }[],
): Promise<EgressMaterial> {
  const path = join(dataDir, MATERIAL_FILE);

  let stored: Partial<EgressMaterial> = {};
  if (existsSync(path)) {
    try {
      stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<EgressMaterial>;
    } catch (err) {
      log.warn('stored egress material is unreadable; generating a replacement', {
        path,
        error: (err as Error).message,
      });
    }
  }

  let changed = false;

  let ca = stored.ca;
  if (!ca?.key || !ca?.cert) {
    // Generated with the engine's own helper, so the key the proxy signs
    // interception certificates with is one it is guaranteed to accept.
    ca = await generateCACertificate({ subject: { commonName: 'Boxes egress proxy CA' } });
    changed = true;
    log.info('generated an egress CA for this deployment', { path });
  }

  // Placeholders are per deployment rather than per session, so the policy
  // does not change as sessions come and go.
  const placeholders: Record<string, string> = { ...stored.placeholders };
  for (const { id, placeholderPrefix } of credentials) {
    if (placeholders[id]) continue;
    placeholders[id] = generatePlaceholder(placeholderPrefix);
    changed = true;
  }

  const controlToken = stored.controlToken || randomBytes(32).toString('hex');
  if (controlToken !== stored.controlToken) changed = true;

  const material: EgressMaterial = { ca, placeholders, controlToken };
  if (changed) writeMaterial(dataDir, material);
  return material;
}

/** Writes the material back, readable only by the orchestrator. */
function writeMaterial(dataDir: string, material: EgressMaterial): void {
  writeSecretFile(join(dataDir, MATERIAL_FILE), `${JSON.stringify(material, null, 2)}\n`);
}

/**
 * Builds the policy the proxy runs, from the deployment's settings, the
 * stored material and whatever the credential store currently holds.
 *
 * Composed again on every sync rather than once at boot, because the store
 * changes while the process runs: a credential entered on the settings page
 * has to be live within the second, not at the next tick.
 *
 * The CA travels unconditionally. A box is given it when it is created and
 * holds it for as long as it lives, so a policy that withheld it until the
 * first credential existed would leave every box created before that failing
 * TLS on every intercepted host afterwards. A host is still only intercepted
 * while its credential is stored, which is the credentials list below.
 */
export function composePolicy(
  cfg: Config,
  material: EgressMaterial,
  stored: readonly CredentialRow[],
): EgressPolicy {
  // What a box can be given rather than what is stored: a subscription
  // obtained by logging in is a document rather than a header value, and the
  // traffic it authenticates does not pass through the swap at all. See
  // deliverableSecret() for the whole of why, and PLAN.md section 3, verify
  // step 10, for what is still undecided about it. A credential with nothing
  // deliverable leaves its hosts unintercepted, exactly as an absent one does.
  const secrets = new Map(stored.map((row) => [row.id, deliverableSecret(row) ?? '']));
  const configured = CREDENTIAL_SET.filter((spec) => (secrets.get(spec.id) ?? '') !== '');

  const credentials: EgressCredential[] = configured.map((spec) => {
    const placeholder = material.placeholders[spec.id];
    if (!placeholder) {
      throw new Error(`no placeholder was generated for the ${spec.id} credential`);
    }
    return {
      id: spec.id,
      hosts: [...spec.hosts],
      headers: [...spec.headers],
      placeholder,
      secret: secrets.get(spec.id) ?? '',
    };
  });

  // A configured credential's own hosts are implied by the proxy; the hosts
  // its tools merely need are added here, so a narrow allowlist cannot break
  // an OAuth refresh or a tarball download.
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

/** One authenticated call on the control channel. */
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
 * The proxy has nothing at rest, so a restart leaves it with no policy at
 * all. Re-pushing on every reconcile tick closes that window, so the push is
 * cheap and idempotent.
 */
export class EgressManager {
  private material: EgressMaterial | null = null;
  private composed: EgressPolicy | null = null;
  private health: EgressHealth | null = null;

  constructor(
    private readonly cfg: Config,
    /**
     * Where the secrets come from. The manager reads it on every compose and
     * writes to it never; the store calls sync() when it changes.
     */
    private readonly credentials: CredentialStore,
  ) {}

  /** Loads the material and composes the policy, without talking to the proxy. */
  async prepare(): Promise<void> {
    // The whole set rather than the configured part of it: a box holds a
    // placeholder for every credential this deployment could ever translate,
    // because its environment is fixed when it is created and a credential
    // entered afterwards has to reach it.
    this.material = await resolveEgressMaterial(this.cfg.DATA_DIR, CREDENTIAL_SET);
    this.composed = composePolicy(this.cfg, this.material, this.credentials.list());
  }

  /** The CA certificate a session is given to trust. Public, never the key. */
  caCertificate(): string {
    return this.prepared().material.ca.cert;
  }

  /**
   * The prepared state, or a refusal.
   *
   * Every caller here decides what a session container will hold, and an
   * unprepared manager holds neither the placeholders nor the CA. Answering
   * with nothing would build a box that can never authenticate and never
   * trust an intercepted host, and say so nowhere, so this refuses instead.
   */
  private prepared(): { material: EgressMaterial; composed: EgressPolicy } {
    if (!this.material || !this.composed) {
      throw new Error('the egress policy has not been prepared yet');
    }
    return { material: this.material, composed: this.composed };
  }

  /**
   * What a box holds in place of a credential.
   *
   * Never a real value, and never conditional on the credential existing: the
   * placeholder is per deployment and is generated before its secret is, so a
   * box created today works with a token entered tomorrow. A placeholder for
   * a credential that is not configured leaves the box as a bearer to a host
   * nobody intercepts and is refused by the service, which is the intended
   * failure — the dashboard is what keeps a person from getting there.
   *
   * A credential this deployment cannot translate at all has no placeholder,
   * and the empty string is what then drops the variable from the box's
   * environment rather than setting it to nothing.
   */
  placeholderFor(id: string): string {
    return this.prepared().material.placeholders[id] ?? '';
  }

  /** The last thing the proxy reported, for /healthz. */
  status(): EgressHealth | null {
    return this.health;
  }

  /**
   * Recomposes the policy from the store and pushes it, recording what came
   * back.
   *
   * The recompose is what makes a credential live: this runs on the store's
   * every write as well as on the reconciler's tick, and the tick is then
   * only the retry for a proxy that was not listening.
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
