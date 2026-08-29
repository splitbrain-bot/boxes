import Docker from 'dockerode';
import { PassThrough, Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { Config, SessionProfile } from './config.ts';
import { log } from './log.ts';

/**
 * Container / network / volume lifecycle plus the long-lived adapter exec
 * (plan §8.2, §8.3).
 *
 * The HostConfig here is a fixed template: user input never reaches it. The
 * only caller-supplied values are the session id (server-generated), the
 * repo URL (validated https, passed as an env var, never as argv) and the
 * profile secrets.
 */

export const LABEL = 'boxes.session';

let client: Docker | null = null;

export function docker(): Docker {
  if (!client) client = new Docker({ socketPath: '/var/run/docker.sock' });
  return client;
}

export function setDockerForTests(d: Docker | null): void {
  client = d;
}

export const names = {
  container: (id: string) => `session-${id}`,
  network: (id: string) => `sn-${id}`,
  wsVolume: (id: string) => `ws-${id}`,
  homeVolume: (id: string) => `home-${id}`,
};

export interface CreateContainerSpec {
  sessionId: string;
  image: string;
  networkName: string;
  subnet: string;
  wsVolume: string;
  homeVolume: string;
  repoUrl: string | null;
  profile: SessionProfile;
}

/** Env injected at create (plan §8.1). Secrets go here and nowhere else. */
function sessionEnv(spec: CreateContainerSpec, cfg: Config): string[] {
  const proxyUrl = `http://${cfg.EGRESS_PROXY_ALIAS}:${cfg.EGRESS_PROXY_PORT}`;
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: spec.profile.claudeOauthToken,
    GH_TOKEN: spec.profile.ghToken,
    GIT_NAME: spec.profile.gitName,
    GIT_EMAIL: spec.profile.gitEmail,
    REPO_URL: spec.repoUrl ?? '',
    TERM: 'dumb',
    CLAUDE_CONFIG_DIR: '/home/agent/.claude',
    // Every proxy-aware client honours these; anything else simply has no
    // route out, which is the intended failure mode (plan §8.4).
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
  return Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);
}

function memoryBytes(limit: string): number {
  const match = /^(\d+)([kmgKMG]?)$/.exec(limit);
  if (!match) throw new Error(`Invalid memory limit: ${limit}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return value * scale;
}

/** Step 2: an `internal` network — no NAT, no default route (plan §8.4). */
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
 * Step 3 / reconciliation: attach the egress proxy to a session network with
 * the `proxy` alias. Idempotent by check, because `compose up` may recreate
 * the proxy container and drop its dynamic attachments (plan §8.4).
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

export async function createVolume(name: string, sessionId: string): Promise<void> {
  await docker().createVolume({ Name: name, Labels: { [LABEL]: sessionId } });
}

/** Step 5: the fixed, hardened HostConfig template. */
export async function createContainer(spec: CreateContainerSpec, cfg: Config): Promise<string> {
  const container = await docker().createContainer({
    name: names.container(spec.sessionId),
    Image: spec.image,
    User: 'agent',
    WorkingDir: '/workspace',
    Env: sessionEnv(spec, cfg),
    Labels: { [LABEL]: spec.sessionId },
    // The adapter is a separate exec; PID 1 just holds the container.
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    HostConfig: {
      NetworkMode: spec.networkName,
      Binds: [
        `${spec.wsVolume}:/workspace`,
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
      // Explicitly nothing else: no bind mounts of host paths, no
      // docker.sock, no published ports, no extra devices.
      Privileged: false,
      PublishAllPorts: false,
    },
  });
  return container.id;
}

export async function startContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).start();
  } catch (err) {
    // 304 = already started, which is success for our purposes.
    if ((err as { statusCode?: number }).statusCode !== 304) throw err;
  }
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).stop({ t: 10 });
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 304 && code !== 404) throw err;
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).remove({ force: true, v: false });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

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

export async function removeVolume(name: string): Promise<void> {
  try {
    await docker().getVolume(name).remove();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

export type DockerContainerState = 'running' | 'exited' | 'missing' | 'unknown';

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

/** Boot reconciliation input: everything Docker knows about our sessions. */
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

/** Does the session container already have a checked-out repo to work in? */
export async function hasRepoDir(containerId: string): Promise<boolean> {
  const exec = await docker().getContainer(containerId).exec({
    Cmd: ['test', '-d', '/workspace/repo'],
    AttachStdout: true,
    AttachStderr: true,
    User: 'agent',
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.resume();
  });
  const info = await exec.inspect();
  return info.ExitCode === 0;
}

/**
 * A demuxed, long-lived exec: the ACP adapter's stdio.
 *
 * Tty is false, so Docker frames stdout and stderr into one stream and we
 * must demux (plan §8.3). stdout carries newline-delimited JSON-RPC and
 * nothing else; the adapter's entrypoint sends all logging to stderr, which
 * we treat as log-only.
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
