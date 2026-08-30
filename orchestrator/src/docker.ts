import Docker from 'dockerode';
import { PassThrough, Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { Config, SessionProfile } from './config.ts';
import { log } from './log.ts';

/**
 * Container, network and volume lifecycle, plus the long-lived adapter exec.
 *
 * The HostConfig below is a fixed template that user input never reaches. The
 * caller supplies only the server-generated session id and the values a
 * session is to hold in place of the deployment's credentials.
 */

/** Docker label carrying the session id on every object Boxes creates. */
export const LABEL = 'boxes.session';

/** The session's writable volume, and the working directory of everything in it. */
export const WORKSPACE_DIR = '/workspace';

let client: Docker | null = null;

/** The shared Docker client, connected to the host socket on first use. */
export function docker(): Docker {
  if (!client) client = new Docker({ socketPath: '/var/run/docker.sock' });
  return client;
}

/** Test seam: install a client, or null to reset. */
export function setDockerForTests(d: Docker | null): void {
  client = d;
}

/** Docker object names derived from a session id. */
export const names = {
  container: (id: string) => `session-${id}`,
  network: (id: string) => `sn-${id}`,
  wsVolume: (id: string) => `ws-${id}`,
  homeVolume: (id: string) => `home-${id}`,
};

/**
 * What a session is handed in place of the deployment's real credentials.
 *
 * Where translation is on these are placeholders and the proxy swaps them for
 * the real thing on the wire, so nothing inside the container is worth
 * stealing. Where it is off — a credential this deployment did not configure —
 * they are whatever the profile holds, which is today's behavior.
 */
export interface SessionEgress {
  claudeOauthToken: string;
  ghToken: string;
  /**
   * PEM of the deployment CA the session must trust, or '' when nothing is
   * intercepted and no extra trust is needed.
   */
  caCertificate: string;
}

/** Everything createContainer needs to know about one session. */
export interface CreateContainerSpec {
  sessionId: string;
  image: string;
  networkName: string;
  subnet: string;
  wsVolume: string;
  homeVolume: string;
  profile: SessionProfile;
  egress: SessionEgress;
}

/** Where the entrypoint writes the CA, and where the CA env vars point. */
const CA_PATH = '/home/agent/.boxes/proxy-ca.crt';

/**
 * Environment of a session container.
 *
 * This is the only delivery path for a session's credentials, and with
 * translation on it carries no real one. The CA travels here too, as a PEM
 * rather than a mount, so the proxy's trust anchor needs no volume and no file
 * on the host.
 */
export function sessionEnv(spec: CreateContainerSpec, cfg: Config): string[] {
  const proxyUrl = `http://${cfg.EGRESS_PROXY_ALIAS}:${cfg.EGRESS_PROXY_PORT}`;
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: spec.egress.claudeOauthToken,
    GH_TOKEN: spec.egress.ghToken,
    GIT_NAME: spec.profile.gitName,
    GIT_EMAIL: spec.profile.gitEmail,
    TERM: 'dumb',
    CLAUDE_CONFIG_DIR: '/home/agent/.claude',
    // Every proxy-aware client honours these; anything else has no route
    // out, which is the intended failure mode.
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };

  if (spec.egress.caCertificate !== '') {
    // The entrypoint writes the PEM to CA_PATH; these are the four variables
    // that point node, gh, git and curl at it. A tool honouring none of them
    // fails TLS against the intercepted hosts and nothing else — the shape the
    // README's troubleshooting table describes.
    env['BOXES_PROXY_CA'] = spec.egress.caCertificate;
    env['NODE_EXTRA_CA_CERTS'] = CA_PATH;
    env['SSL_CERT_FILE'] = CA_PATH;
    env['GIT_SSL_CAINFO'] = CA_PATH;
    env['CURL_CA_BUNDLE'] = CA_PATH;
  }

  return Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);
}

/** Converts a Docker-style memory limit such as 4g into bytes. */
function memoryBytes(limit: string): number {
  const match = /^(\d+)([kmgKMG]?)$/.exec(limit);
  if (!match) throw new Error(`Invalid memory limit: ${limit}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return value * scale;
}

/** Creates a session network. Internal, so it has no NAT and no default route. */
export async function createNetwork(networkName: string, subnet: string, sessionId: string): Promise<void> {
  await docker().createNetwork({
    Name: networkName,
    Driver: 'bridge',
    Internal: true,
    CheckDuplicate: true,
    IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
    Labels: { [LABEL]: sessionId },
  });
}

/**
 * Attaches the egress proxy to a session network under its alias, and reports
 * whether it is attached. The check runs every time, because compose can
 * recreate the proxy container and drop its dynamic attachments.
 */
export async function ensureProxyAttached(networkName: string, cfg: Config): Promise<boolean> {
  const net = docker().getNetwork(networkName);
  let info: Docker.NetworkInspectInfo;
  try {
    info = await net.inspect();
  } catch {
    return false;
  }
  const attached = Object.values(info.Containers ?? {}).some(
    (c) => c.Name === cfg.EGRESS_PROXY_CONTAINER,
  );
  if (attached) return true;
  try {
    await net.connect({
      Container: cfg.EGRESS_PROXY_CONTAINER,
      EndpointConfig: { Aliases: [cfg.EGRESS_PROXY_ALIAS] },
    });
    log.info('attached egress proxy to session network', { network: networkName });
    return true;
  } catch (err) {
    log.warn('could not attach egress proxy', {
      network: networkName,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Whether the egress proxy is attached to a session network right now. */
export async function isProxyAttached(networkName: string, cfg: Config): Promise<boolean> {
  try {
    const info = await docker().getNetwork(networkName).inspect();
    return Object.values(info.Containers ?? {}).some(
      (c) => c.Name === cfg.EGRESS_PROXY_CONTAINER,
    );
  } catch {
    return false;
  }
}

/** Creates a volume labelled with its session. */
export async function createVolume(name: string, sessionId: string): Promise<void> {
  await docker().createVolume({ Name: name, Labels: { [LABEL]: sessionId } });
}

/** Creates a session container from the fixed, hardened HostConfig template. */
export async function createContainer(spec: CreateContainerSpec, cfg: Config): Promise<string> {
  const container = await docker().createContainer({
    name: names.container(spec.sessionId),
    Image: spec.image,
    User: 'agent',
    WorkingDir: WORKSPACE_DIR,
    Env: sessionEnv(spec, cfg),
    Labels: { [LABEL]: spec.sessionId },
    // The adapter is a separate exec; PID 1 only holds the container open.
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    HostConfig: {
      NetworkMode: spec.networkName,
      Binds: [
        `${spec.wsVolume}:${WORKSPACE_DIR}`,
        `${spec.homeVolume}:/home/agent`,
      ],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=512m,mode=1777' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: memoryBytes(cfg.SESSION_MEM_LIMIT),
      NanoCpus: Math.round(cfg.SESSION_CPUS * 1e9),
      PidsLimit: cfg.SESSION_PIDS_LIMIT,
      RestartPolicy: { Name: 'no' },
      // The kernel discards default-disposition signals for PID 1, so the
      // entrypoint's sleep never sees SIGTERM. docker-init forwards the signal
      // and reaps, which keeps stops prompt.
      Init: true,
      // Stated explicitly so a later edit cannot loosen them by omission.
      Privileged: false,
      PublishAllPorts: false,
    },
  });
  return container.id;
}

/** Starts a container, tolerating one that already runs. */
export async function startContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).start();
  } catch (err) {
    // 304 means the container is already started.
    if ((err as { statusCode?: number }).statusCode !== 304) throw err;
  }
}

/** Stops a container with a 10 second grace period, tolerating one already gone. */
export async function stopContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).stop({ t: 10 });
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 304 && code !== 404) throw err;
  }
}

/** Removes a container and keeps its volumes. */
export async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).remove({ force: true, v: false });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/** Removes a session network, detaching the egress proxy first. */
export async function removeNetwork(networkName: string, cfg: Config): Promise<void> {
  const net = docker().getNetwork(networkName);
  // Disconnect the proxy first, else Docker refuses to remove the network.
  try {
    await net.disconnect({ Container: cfg.EGRESS_PROXY_CONTAINER, Force: true });
  } catch {
    // Not attached, or already gone.
  }
  try {
    await net.remove();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/** Removes a volume, tolerating one that is already gone. */
export async function removeVolume(name: string): Promise<void> {
  try {
    await docker().getVolume(name).remove();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/** What Docker reports about a container. */
export type DockerContainerState = 'running' | 'exited' | 'missing' | 'unknown';

/** Resolves a container's live state, mapping every lookup failure onto a state. */
export async function containerState(containerId: string | null): Promise<DockerContainerState> {
  if (!containerId) return 'missing';
  try {
    const info = await docker().getContainer(containerId).inspect();
    if (info.State?.Running) return 'running';
    return 'exited';
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return 'missing';
    return 'unknown';
  }
}

/** Every labelled session container Docker knows about, for boot reconciliation. */
export async function listSessionContainers(): Promise<
  Array<{ id: string; sessionId: string; running: boolean }>
> {
  const containers = await docker().listContainers({
    all: true,
    filters: { label: [LABEL] },
  });
  return containers.flatMap((c) => {
    const sessionId = c.Labels?.[LABEL];
    if (!sessionId) return [];
    return [{ id: c.Id, sessionId, running: c.State === 'running' }];
  });
}

/**
 * A demuxed, long-lived exec carrying the ACP adapter's stdio.
 *
 * Tty is false, so Docker frames stdout and stderr into a single stream that
 * has to be demuxed. stdout carries newline-delimited JSON-RPC and nothing
 * else; the adapter sends all its logging to stderr.
 */
export interface AdapterExec {
  /** Newline-delimited JSON-RPC from the adapter. */
  stdout: Readable;
  /** Log-only. */
  stderr: Readable;
  /** Write newline-delimited JSON-RPC to the adapter. */
  stdin: Duplex;
  /** Resolves when the exec's stream ends, with the exit code if known. */
  exited: Promise<number | null>;
  kill(): void;
}

/** Starts the adapter inside a running container and demuxes its streams. */
export async function spawnAdapterExec(
  containerId: string,
  cmd: string[],
  workingDir: string,
): Promise<AdapterExec> {
  const exec = await docker().getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: 'agent',
    WorkingDir: workingDir,
  });

  const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker().modem.demuxStream(stream, stdout, stderr);

  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });

  const finish = async (): Promise<void> => {
    stdout.end();
    stderr.end();
    try {
      const info = await exec.inspect();
      settle(info.ExitCode ?? null);
    } catch {
      settle(null);
    }
  };

  stream.on('end', () => void finish());
  stream.on('close', () => void finish());
  stream.on('error', (err) => {
    log.warn('adapter exec stream error', { error: err.message });
    void finish();
  });

  return {
    stdout,
    stderr,
    stdin: stream,
    exited,
    kill: () => {
      try {
        stream.destroy();
      } catch {
        // already gone
      }
    },
  };
}

/** A one-off exec whose combined output is streamed back. */
export interface CommandExec {
  /** stdout and stderr, demuxed and merged in arrival order. */
  output: Readable;
  /** Resolves with the exit code once the stream ends, or null if unknown. */
  exited: Promise<number | null>;
  kill(): void;
}

/**
 * Runs one command in a session container as the agent user.
 *
 * The command travels as an argument to `bash -lc`, never as part of a
 * command line the host assembles, and it runs inside the container's
 * existing isolation: internal network, read-only rootfs, capabilities
 * dropped. No new privilege is introduced by running it.
 */
export async function runCommandExec(
  containerId: string,
  command: string,
  workingDir: string,
): Promise<CommandExec> {
  const exec = await docker().getContainer(containerId).exec({
    Cmd: ['bash', '-lc', command],
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: 'agent',
    WorkingDir: workingDir,
  });

  const stream = (await exec.start({ hijack: true, stdin: false })) as Duplex;
  // One stream for the caller: a shell's stderr is part of its output, and
  // splitting them would lose the order they were written in.
  const output = new PassThrough();
  docker().modem.demuxStream(stream, output, output);

  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });

  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    output.end();
    try {
      const info = await exec.inspect();
      settle(info.ExitCode ?? null);
    } catch {
      settle(null);
    }
  };

  stream.on('end', () => void finish());
  stream.on('close', () => void finish());
  stream.on('error', () => void finish());

  return {
    output,
    exited,
    kill: () => {
      try {
        stream.destroy();
      } catch {
        // already gone
      }
    },
  };
}
