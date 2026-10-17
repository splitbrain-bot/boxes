import { existsSync, readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { PassThrough, Readable } from 'node:stream';
import Docker from 'dockerode';
import type { ImageInfo } from '../../shared/types.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { readAll, withTimeout } from './runtime/exec.ts';
import {
  HOME_DIR,
  NIX_DIR,
  type ProcessStream,
  type PullEvent,
  type RunOptions,
  type RunOutput,
  WORKSPACE_DIR,
} from './runtime/runtime.ts';
import { boxOwner } from './workspaces.ts';

/**
 * The Docker layer: containers, networks, images and execs. Only the Docker
 * runtime uses it.
 */

/** Docker label carrying the box id on every object Boxes creates. */
export const LABEL = 'boxes.box';

/**
 * Label the box image carries in its own config. It still marks a copy that
 * a pull has left untagged, so the orchestrator can prune that copy without
 * touching images that other users of the host own.
 */
export const IMAGE_LABEL = 'boxes.image';

/** The value of that label on the box image. */
export const BOX_IMAGE_KIND = 'box';

/**
 * Docker label carrying the credential a throwaway login container belongs to.
 * A login container has no box label, so the sweep finds a left-over one by
 * this label.
 */
export const LOGIN_LABEL = 'boxes.login';

/**
 * The `uid:gid` every box process runs as, as Docker wants it written.
 *
 * Numbers rather than the image's `agent` user, so BOX_UID decides without an
 * image rebuild.
 */
function boxUser(): string {
  const { uid, gid } = boxOwner();
  return `${uid}:${gid}`;
}

/** The shared Docker client, or null before first use. */
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

/**
 * Docker object names derived from a box id.
 *
 * Workspaces, homes and Nix stores are directories, so they have no name here.
 */
export const names = {
  /** Name of the box container. */
  container: (id: string) => `box-${id}`,
  /** Name of the box network. */
  network: (id: string) => `bn-${id}`,
};

/** Everything createContainer needs to know about one box. */
export interface CreateContainerSpec {
  /** The server-generated box id. */
  boxId: string;
  /** The image to create the container from. */
  image: string;
  /** The box network the container joins. */
  networkName: string;
  /**
   * Host-side path bind-mounted at WORKSPACE_DIR. A path rather than a volume
   * name, because the orchestrator reads these files itself.
   */
  workspaceSource: string;
  /** Host-side path of the box's home directory, bound at `/home/agent`. */
  homeSource: string;
  /** Host-side path of the box's Nix store directory, bound at NIX_DIR. */
  nixSource: string;
  /** The full environment of the box, as built by boxEnv(). */
  env: Record<string, string>;
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

/** Creates a box network. Internal, so it has no NAT and no default route. */
export async function createNetwork(
  networkName: string,
  subnet: string,
  boxId: string,
): Promise<void> {
  await docker().createNetwork({
    Name: networkName,
    Driver: 'bridge',
    Internal: true,
    CheckDuplicate: true,
    IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
    Labels: { [LABEL]: boxId },
  });
}

/** Whether a network's inspect lists the egress proxy container on it. */
function proxyOn(info: Docker.NetworkInspectInfo, cfg: Config): boolean {
  return Object.values(info.Containers ?? {}).some((c) => c.Name === cfg.EGRESS_PROXY_CONTAINER);
}

/**
 * Attaches the egress proxy to a box network under its alias, and reports
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
  if (proxyOn(info, cfg)) return true;
  try {
    await net.connect({
      Container: cfg.EGRESS_PROXY_CONTAINER,
      EndpointConfig: { Aliases: [cfg.EGRESS_PROXY_ALIAS] },
    });
    log.info('attached egress proxy to box network', { network: networkName });
    return true;
  } catch (err) {
    log.warn('could not attach egress proxy', {
      network: networkName,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Whether the egress proxy is attached to a box network right now. */
export async function isProxyAttached(networkName: string, cfg: Config): Promise<boolean> {
  try {
    return proxyOn(await docker().getNetwork(networkName).inspect(), cfg);
  } catch {
    return false;
  }
}

// --- resolving this process's own host-side paths ---------------------------

/**
 * The container id a test installed for selfContainerId, or undefined to read
 * the real sources.
 */
let selfIdForTests: string | null | undefined = undefined;

/**
 * Test seam: makes selfContainerId return id. Undefined restores the real
 * sources.
 */
export function setSelfContainerIdForTests(id: string | null | undefined): void {
  selfIdForTests = id;
}

/**
 * This process's own container id, or null when it is not in a container.
 *
 * It tries three sources, as none of them holds everywhere. Mountinfo has the
 * id in the paths of the files Docker binds into every container. The cgroup
 * path has it only under some cgroup setups. The hostname is not an id when
 * compose sets it to the service name.
 */
export function selfContainerId(): string | null {
  if (selfIdForTests !== undefined) return selfIdForTests;
  const patterns: Array<[string, RegExp]> = [
    ['/proc/self/mountinfo', /\/containers\/([0-9a-f]{64})\//],
    ['/proc/self/cgroup', /(?:^|\/|docker-)([0-9a-f]{64})(?:\.scope)?$/m],
    ['/etc/hostname', /^([0-9a-f]{12,64})$/],
  ];
  for (const [file, pattern] of patterns) {
    try {
      const match = pattern.exec(readFileSync(file, 'utf8').trim());
      if (match?.[1]) return match[1];
    } catch {
      // not readable here; try the next source
    }
  }
  return null;
}

/**
 * Pulls an image, resolving once the daemon has finished with it.
 *
 * It passes no registry auth. A private registry needs credentials in the
 * daemon's own configuration.
 *
 * @param image The image reference to pull.
 * @param onProgress Called with each progress event of the pull.
 */
export async function pullImage(
  image: string,
  onProgress?: (event: PullEvent) => void,
): Promise<void> {
  const stream = await docker().pull(image);
  await new Promise<void>((resolve, reject) => {
    // The pull call returns when the transfer starts; the stream ends with it.
    docker().modem.followProgress(stream, (err) => (err ? reject(err) : resolve()), onProgress);
  });
}

/**
 * Reads something off an inspect, and returns null when the daemon answers
 * 404. Any other failure is rethrown, so no caller reads it as absence.
 */
async function inspecting<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/**
 * The id of an image on this host, or null when it is not here. Comparing ids
 * shows whether a moving tag has moved.
 */
export async function imageId(image: string): Promise<string | null> {
  return inspecting(async () => (await docker().getImage(image).inspect()).Id ?? null);
}

/**
 * The digest, build date and size of an image on this host, or null when it
 * is not here.
 *
 * The digest is the registry digest, so it matches what was published. An
 * image built on this host has none, and its local id is used instead. A build
 * date or size that cannot be read is null.
 */
export async function imageInfo(image: string): Promise<ImageInfo | null> {
  return inspecting(async () => {
    const info = await docker().getImage(image).inspect();
    const published = (info.RepoDigests ?? [])[0]?.split('@')[1];
    const builtAt = Date.parse(info.Created ?? '');
    return {
      digest: published ?? info.Id,
      builtAt: Number.isNaN(builtAt) ? null : builtAt,
      sizeBytes: typeof info.Size === 'number' ? info.Size : null,
    };
  });
}

/** The id of the image a container was created from, or null when it is gone. */
export async function containerImageId(container: string): Promise<string | null> {
  return inspecting(async () => (await docker().getContainer(container).inspect()).Image ?? null);
}

/** The full id of a container, by name or id, or null when it is gone. */
export async function containerId(container: string): Promise<string | null> {
  return inspecting(async () => (await docker().getContainer(container).inspect()).Id ?? null);
}

/** True when a network exists. */
export async function networkExists(networkName: string): Promise<boolean> {
  return (await inspecting(() => docker().getNetwork(networkName).inspect())) !== null;
}

/** The subnet of a network, or null when the network is gone or has none. */
export async function networkSubnet(networkName: string): Promise<string | null> {
  const info = await inspecting(() => docker().getNetwork(networkName).inspect());
  return info?.IPAM?.Config?.[0]?.Subnet ?? null;
}

/** Whether this process is running inside a container. */
export function inContainer(): boolean {
  return existsSync('/.dockerenv') || selfContainerId() !== null;
}

/**
 * The host-side path of a directory mounted into this process's own container,
 * or null when there is no such mount.
 *
 * The daemon resolves bind sources on the host, so a bind of a path under the
 * orchestrator's own /data must name this host-side path.
 */
export async function resolveHostMountSource(destination: string): Promise<string | null> {
  const self = selfContainerId();
  if (!self) return null;
  // A hostname that only looks like a container id finds no container.
  const info = await inspecting(() => docker().getContainer(self).inspect());
  if (!info) return null;
  const mount = (info.Mounts ?? []).find((m) => m.Destination === destination);
  return mount?.Source ?? null;
}

/**
 * Creates a box container from the fixed, hardened HostConfig template. User
 * input never reaches the HostConfig.
 */
export async function createContainer(spec: CreateContainerSpec, cfg: Config): Promise<string> {
  const container = await docker().createContainer({
    name: names.container(spec.boxId),
    Image: spec.image,
    User: boxUser(),
    WorkingDir: WORKSPACE_DIR,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: {
      [LABEL]: spec.boxId,
      // Keeps Watchtower away. Only the orchestrator replaces a box
      // container, and only while the box is stopped.
      'com.centurylinklabs.watchtower.enable': 'false',
    },
    // The adapter is a separate exec; PID 1 only holds the container open.
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    HostConfig: {
      NetworkMode: spec.networkName,
      Binds: [
        // Directories on the data volume, so the orchestrator can read a
        // box's files without a running container.
        `${spec.workspaceSource}:${WORKSPACE_DIR}`,
        `${spec.homeSource}:${HOME_DIR}`,
        `${spec.nixSource}:${NIX_DIR}`,
      ],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=512m,mode=1777' },
      // Chromium keeps its shared memory in /dev/shm, and Docker's 64 MB
      // default crashes large pages. The box image turns off Playwright's
      // --disable-dev-shm-usage, which would move it to TMPDIR on the home.
      // Like the tmpfs, it counts against the memory limit only as used.
      ShmSize: 512 * 1024 * 1024,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: memoryBytes(cfg.BOX_MEM_LIMIT),
      NanoCpus: Math.round(cfg.BOX_CPUS * 1e9),
      PidsLimit: cfg.BOX_PIDS_LIMIT,
      RestartPolicy: { Name: 'no' },
      // No `Init`: the image's entrypoint starts under tini, which reaps and
      // forwards SIGTERM. A docker-init in front of it would leave tini a
      // child that reaps nothing.
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

/**
 * Creates the throwaway container one login runs in.
 *
 * It gets no workspace, no agent configuration, no placeholder and no proxy.
 * It holds no deployment secret, so it sits on Docker's default bridge. It is
 * the only container Boxes creates with a direct route to the internet.
 *
 * The home is a tmpfs, because the rootfs is read-only and both CLIs write
 * their state under `$HOME`. The credential material goes with the container.
 */
export async function createLoginContainer(spec: {
  image: string;
  credentialId: string;
  env?: Record<string, string>;
}): Promise<string> {
  const container = await docker().createContainer({
    Image: spec.image,
    User: boxUser(),
    WorkingDir: '/home/agent',
    Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
    Labels: {
      [LOGIN_LABEL]: spec.credentialId,
      'com.centurylinklabs.watchtower.enable': 'false',
    },
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    HostConfig: {
      NetworkMode: 'bridge',
      ReadonlyRootfs: true,
      // `exec`, because a login CLI may run from the home's PATH. `mode=1777`,
      // because the box user must write to a tmpfs that root owns.
      Tmpfs: {
        '/home/agent': 'rw,exec,size=256m,mode=1777',
        '/tmp': 'rw,size=64m,mode=1777',
      },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      // No memory or CPU limit: a login is one short-lived CLI, and a low
      // limit can break a Node CLI.
      PidsLimit: 256,
      RestartPolicy: { Name: 'no' },
      Privileged: false,
      PublishAllPorts: false,
    },
  });
  return container.id;
}

/**
 * Every login container Docker still has, with its creation time in epoch
 * milliseconds. The orphan sweep reads it.
 */
export async function listLoginContainers(): Promise<
  Array<{ id: string; credentialId: string; createdAt: number }>
> {
  const containers = await docker().listContainers({
    all: true,
    filters: { label: [LOGIN_LABEL] },
  });
  return containers.flatMap((c) => {
    const credentialId = c.Labels?.[LOGIN_LABEL];
    if (!credentialId) return [];
    // Docker reports creation in epoch seconds.
    return [{ id: c.Id, credentialId, createdAt: (c.Created ?? 0) * 1000 }];
  });
}

/** Removes a box network, detaching the egress proxy first. */
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

/**
 * The state Docker reports for a container. `missing` means the daemon does
 * not have it, `unknown` that the daemon did not answer.
 */
export type ContainerState = 'running' | 'exited' | 'missing' | 'unknown';

/** Resolves a container's live state, mapping every lookup failure onto a state. */
export async function containerState(container: string): Promise<ContainerState> {
  try {
    const info = await docker().getContainer(container).inspect();
    if (info.State?.Running) return 'running';
    return 'exited';
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return 'missing';
    return 'unknown';
  }
}

/**
 * Runs one command in a container as the agent user and collects its output.
 *
 * The command is an argument vector, never a shell line. `timeoutMs` is
 * enforced inside the container by `timeout`, because the daemon cannot
 * signal a running exec. The limit is rounded up to whole seconds. A command
 * that survives SIGTERM is killed five seconds later. Without `timeoutMs`,
 * the command is unbounded.
 */
export async function execInContainer(
  containerId: string,
  cmd: readonly string[],
  opts: RunOptions = {},
): Promise<RunOutput> {
  const { stdout, stderr, exited } = await runExec(containerId, cmd, opts);
  const [out, err, code] = await Promise.all([
    readAll(stdout, opts.maxOutput),
    readAll(stderr, opts.maxOutput),
    exited,
  ]);
  return { stdout: out, stderr: err, code };
}

/** One short exec with its stdout and its stderr demuxed apart. */
async function runExec(
  containerId: string,
  cmd: readonly string[],
  opts: RunOptions,
): Promise<{ stdout: Readable; stderr: Readable; exited: Promise<number | null> }> {
  const exec = await docker()
    .getContainer(containerId)
    .exec({
      Cmd: withTimeout(cmd, opts.timeoutMs),
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: boxUser(),
      WorkingDir: opts.workingDir,
      Env: opts.env && Object.entries(opts.env).map(([name, value]) => `${name}=${value}`),
    });
  const stream = (await exec.start({ hijack: true, stdin: false })) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker().modem.demuxStream(stream, stdout, stderr);
  const { exited } = execCompletion(stream, exec, () => {
    stdout.end();
    stderr.end();
  });
  return { stdout, stderr, exited };
}

/**
 * Every labelled box container Docker knows about, for boot
 * reconciliation and the orphan sweep.
 */
export async function listBoxContainers(): Promise<
  Array<{ id: string; boxId: string; running: boolean }>
> {
  const containers = await docker().listContainers({
    all: true,
    filters: { label: [LABEL] },
  });
  return containers.flatMap((c) => {
    const boxId = c.Labels?.[LABEL];
    if (!boxId) return [];
    return [
      {
        id: c.Id,
        boxId,
        running: c.State === 'running',
      },
    ];
  });
}

/** Box networks Boxes created, by the box each is labelled with, and their subnets. */
export async function listBoxNetworks(): Promise<
  Array<{ name: string; boxId: string; subnet: string | null }>
> {
  const networks = await docker().listNetworks({ filters: { label: [LABEL] } });
  return networks.flatMap((n) => {
    const boxId = (n.Labels as Record<string, string> | undefined)?.[LABEL];
    const subnet = n.IPAM?.Config?.[0]?.Subnet ?? null;
    return boxId && n.Name ? [{ name: n.Name, boxId, subnet }] : [];
  });
}

/**
 * Ids of box images on this host that have lost their tag.
 *
 * Only images with IMAGE_LABEL are listed, so an image Boxes did not fetch is
 * never listed. `RepoTags` is checked as well as the dangling filter.
 *
 * The caller excludes the current BOX_IMAGE. A second Boxes deployment on the
 * host that pins BOX_IMAGE by digest also has an untagged current image. It is
 * listed here, and removing it costs that deployment a pull.
 */
export async function listSupersededBoxImages(): Promise<string[]> {
  const images = await docker().listImages({
    filters: { dangling: ['true'], label: [`${IMAGE_LABEL}=${BOX_IMAGE_KIND}`] },
  });
  return images
    .filter((i) => (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>').length === 0)
    .map((i) => i.Id)
    .filter((id): id is string => Boolean(id));
}

/**
 * Removes an image, and returns whether it went.
 *
 * Never forced, so the daemon refuses with 409 while a container still uses
 * the image. That box moves to the current image at its next start. A 404
 * means the image is already gone.
 */
export async function removeImage(id: string): Promise<boolean> {
  try {
    await docker().getImage(id).remove();
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 409) return false;
    throw err;
  }
}

/**
 * Wires up the end of an exec: one promise for its exit code, and a kill.
 *
 * A hijacked stream reports its end as both `end` and `close`, so the settle
 * runs at most once. `onEnd` closes whatever the caller demuxed into, before
 * the exit code is read.
 */
function execCompletion(
  stream: Duplex,
  exec: { inspect: () => Promise<{ ExitCode?: number | null }> },
  onEnd: () => void,
  onError?: (err: Error) => void,
): { exited: Promise<number | null>; kill: () => void } {
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });

  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    onEnd();
    try {
      settle((await exec.inspect()).ExitCode ?? null);
    } catch {
      settle(null);
    }
  };

  stream.on('end', () => void finish());
  stream.on('close', () => void finish());
  stream.on('error', (err: Error) => {
    onError?.(err);
    void finish();
  });

  return {
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

/**
 * Starts a long-lived process in a container as the agent user.
 *
 * Without a terminal, Docker frames stdout and stderr into one stream, and
 * the two are demuxed apart. With a terminal, Docker does no framing: the
 * stream is the pty's bytes in both directions, and it is both stdout and
 * stdin. The size is set on the exec, so the first prompt is drawn at the
 * right width.
 */
export async function spawnExec(
  container: string,
  cmd: readonly string[],
  opts: { workingDir: string; env?: Record<string, string>; tty?: { cols: number; rows: number } },
): Promise<ProcessStream> {
  const tty = opts.tty !== undefined;
  const exec = await docker()
    .getContainer(container)
    .exec({
      Cmd: [...cmd],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      User: boxUser(),
      WorkingDir: opts.workingDir,
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      // The daemon wants the size the way ioctl does, rows before columns.
      ...(opts.tty ? { ConsoleSize: [opts.tty.rows, opts.tty.cols] } : {}),
    });

  // Tty on the start request too: the daemon reads it there to decide
  // whether to frame the output. Frame headers would corrupt the text.
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: tty })) as Duplex;
  let stdout: Readable = stream;
  const stderr = new PassThrough();
  if (!tty) {
    const demuxed = new PassThrough();
    docker().modem.demuxStream(stream, demuxed, stderr);
    stdout = demuxed;
  }

  const { exited, kill } = execCompletion(
    stream,
    exec,
    () => {
      if (stdout !== stream) (stdout as PassThrough).end();
      stderr.end();
    },
    (err) => log.warn('exec stream error', { command: cmd[0], error: err.message }),
  );

  return {
    stdout,
    stderr,
    stdin: stream,
    exited,
    // A resize against an exec that has ended is left at debug: the stream
    // ending is what the caller acts on.
    resize: async (cols, rows) => {
      if (!tty) return;
      try {
        await exec.resize({ h: rows, w: cols });
      } catch (err) {
        log.debug('terminal resize failed', { error: (err as Error).message });
      }
    },
    kill,
  };
}
