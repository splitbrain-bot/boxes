/**
 * The Docker layer for containers, networks, images and execs. Only the
 * Docker runtime uses it.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { PassThrough, type Readable } from 'node:stream';
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

/** The Docker label with the box id on each box container and box network. */
export const LABEL = 'boxes.box';

/**
 * The label in the config of the box image. It also marks a copy that lost
 * its tag in a pull, so the orchestrator can remove that copy and not touch
 * the images of other users of the host.
 */
export const IMAGE_LABEL = 'boxes.image';

/** The value of IMAGE_LABEL on the box image. */
export const BOX_IMAGE_KIND = 'box';

/**
 * The Docker label with the credential of a temporary login container. A
 * login container has no box label, so the sweep finds an old login container
 * by this label.
 */
export const LOGIN_LABEL = 'boxes.login';

/**
 * The `uid:gid` of each box process, in the Docker format.
 *
 * The value has numbers and not the `agent` user of the image, so BOX_UID
 * applies without an image rebuild.
 *
 * @returns The user in the form `uid:gid`.
 */
function boxUser(): string {
  const { uid, gid } = boxOwner();
  return `${uid}:${gid}`;
}

/** The shared Docker client, or null before first use. */
let client: Docker | null = null;

/**
 * Gives the shared Docker client, and connects it to the host socket on first use.
 *
 * @returns The client.
 */
export function docker(): Docker {
  if (!client) client = new Docker({ socketPath: '/var/run/docker.sock' });
  return client;
}

/**
 * Installs a client for tests.
 *
 * @param d The client, or null to reset.
 */
export function setDockerForTests(d: Docker | null): void {
  client = d;
}

/**
 * The Docker object names of a box, from its id.
 *
 * Workspaces, homes and Nix stores are directories, so they have no name here.
 */
export const names = {
  /**
   * Gives the name of the box container.
   *
   * @param id The box id.
   * @returns The container name.
   */
  container: (id: string) => `box-${id}`,
  /**
   * Gives the name of the box network.
   *
   * @param id The box id.
   * @returns The network name.
   */
  network: (id: string) => `bn-${id}`,
};

/** The data of one box for createContainer. */
export interface CreateContainerSpec {
  /** The box id, which the orchestrator makes. */
  boxId: string;
  /** The image to create the container from. */
  image: string;
  /** The box network the container joins. */
  networkName: string;
  /**
   * The host path of the bind mount at WORKSPACE_DIR. It is a path and not a
   * volume name, because the workspace is a directory on the data volume.
   */
  workspaceSource: string;
  /** The host path of the home directory of the box, bound at `/home/agent`. */
  homeSource: string;
  /** The host path of the Nix store directory of the box, bound at NIX_DIR. */
  nixSource: string;
  /** The full environment of the box, from boxEnv(). */
  env: Record<string, string>;
}

/**
 * Converts a Docker memory limit such as 4g to bytes.
 *
 * @param limit The limit, a number with an optional k, m or g unit.
 * @returns The limit in bytes.
 * @throws {Error} When the limit has the wrong format.
 */
function memoryBytes(limit: string): number {
  const match = /^(\d+)([kmgKMG]?)$/.exec(limit);
  if (!match) throw new Error(`Invalid memory limit: ${limit}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return value * scale;
}

/**
 * Creates a box network. The network is internal, so it has no NAT and no default route.
 *
 * @param networkName The name of the network.
 * @param subnet The subnet of the network, in CIDR form.
 * @param boxId The box id, for the label.
 */
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

/**
 * Checks if the inspect of a network lists the egress proxy container.
 *
 * @param info The inspect of the network.
 * @param cfg The config, with the name of the proxy container.
 * @returns True when the proxy is on the network.
 */
function proxyOn(info: Docker.NetworkInspectInfo, cfg: Config): boolean {
  return Object.values(info.Containers ?? {}).some((c) => c.Name === cfg.EGRESS_PROXY_CONTAINER);
}

/**
 * Attaches the egress proxy to a box network under its alias. The check runs
 * every time, because compose can recreate the proxy container and drop its
 * dynamic attachments.
 *
 * @param networkName The name of the box network.
 * @param cfg The config, with the name and the alias of the proxy.
 * @returns True when the proxy is attached.
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

/**
 * Checks if the egress proxy is attached to a box network now.
 *
 * @param networkName The name of the box network.
 * @param cfg The config, with the name of the proxy container.
 * @returns True when the proxy is attached. False when the network cannot be read.
 */
export async function isProxyAttached(networkName: string, cfg: Config): Promise<boolean> {
  try {
    return proxyOn(await docker().getNetwork(networkName).inspect(), cfg);
  } catch {
    return false;
  }
}

/**
 * The container id a test installed for selfContainerId, or undefined to read
 * the real sources.
 */
let selfIdForTests: string | null | undefined;

/**
 * Makes selfContainerId return `id`, for tests.
 *
 * @param id The container id, null for no container, or undefined to restore the real sources.
 */
export function setSelfContainerIdForTests(id: string | null | undefined): void {
  selfIdForTests = id;
}

/**
 * Finds the container id of this process.
 *
 * It tries three sources, because no source works everywhere. Mountinfo has
 * the id in the paths of the files that Docker binds into each container. The
 * cgroup path has it only with some cgroup setups. The hostname is not an id
 * when compose sets it to the service name.
 *
 * @returns The container id, or null when the process is not in a container.
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
      // Not readable here, so the loop tries the next source.
    }
  }
  return null;
}

/**
 * Pulls an image and resolves when the daemon is finished.
 *
 * The function sends no registry credentials. A private registry needs
 * credentials in the configuration of the daemon.
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
    // The pull call returns when the transfer starts, and the stream ends with the transfer.
    docker().modem.followProgress(stream, (err) => (err ? reject(err) : resolve()), onProgress);
  });
}

/**
 * Reads a value from an inspect, and returns null when the daemon answers
 * 404. Each other failure is thrown again, so no caller reads it as absence.
 *
 * @param read The inspect call.
 * @returns The value, or null for a 404.
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
 * Gives the id of an image on this host. A comparison of ids shows if a moving
 * tag has moved.
 *
 * @param image The image reference.
 * @returns The image id, or null when the image is not on this host.
 */
export async function imageId(image: string): Promise<string | null> {
  return inspecting(async () => (await docker().getImage(image).inspect()).Id ?? null);
}

/**
 * Gives the digest, build date and size of an image on this host.
 *
 * The digest is the registry digest, so it matches what was published. An
 * image built on this host has none, and its local id is used instead. A build
 * date or size that cannot be read is null.
 *
 * @param image The image reference.
 * @returns The facts of the image, or null when it is not on this host.
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

/**
 * Gives the id of the image that a container was created from.
 *
 * @param container The name or id of the container.
 * @returns The image id, or null when the container does not exist.
 */
export async function containerImageId(container: string): Promise<string | null> {
  return inspecting(async () => (await docker().getContainer(container).inspect()).Image ?? null);
}

/**
 * Gives the value of one environment variable of a container, as the container was created.
 *
 * @param container The name or id of the container.
 * @param name The name of the variable.
 * @returns The value, the empty string when the container has no such variable, or null when the container does
 *   not exist.
 */
export async function containerEnvValue(container: string, name: string): Promise<string | null> {
  return inspecting(async () => {
    const env = (await docker().getContainer(container).inspect()).Config?.Env ?? [];
    const entry = env.find((e) => e.startsWith(`${name}=`));
    return entry === undefined ? '' : entry.slice(name.length + 1);
  });
}

/**
 * Gives the full id of a container.
 *
 * @param container The name or id of the container.
 * @returns The full id, or null when the container does not exist.
 */
export async function containerId(container: string): Promise<string | null> {
  return inspecting(async () => (await docker().getContainer(container).inspect()).Id ?? null);
}

/**
 * Checks if a network exists.
 *
 * @param networkName The name of the network.
 * @returns True when the network exists.
 */
export async function networkExists(networkName: string): Promise<boolean> {
  return (await inspecting(() => docker().getNetwork(networkName).inspect())) !== null;
}

/**
 * Gives the subnet of a network.
 *
 * @param networkName The name of the network.
 * @returns The subnet, or null when the network does not exist or has none.
 */
export async function networkSubnet(networkName: string): Promise<string | null> {
  const info = await inspecting(() => docker().getNetwork(networkName).inspect());
  return info?.IPAM?.Config?.[0]?.Subnet ?? null;
}

/**
 * Checks if this process runs in a container.
 *
 * @returns True in a container.
 */
export function inContainer(): boolean {
  return existsSync('/.dockerenv') || selfContainerId() !== null;
}

/**
 * Finds the host path of a directory mounted into the container of this process.
 *
 * The daemon resolves bind sources on the host, so a bind of a path under the
 * /data of the orchestrator must name this host path.
 *
 * @param destination The mount point in the container.
 * @returns The host path, or null when there is no such mount.
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
 *
 * @param spec The data of the box.
 * @param cfg The config, with the resource limits.
 * @returns The id of the new container.
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
      // Watchtower must not touch the container. Only the orchestrator replaces
      // a box container, and only while the box is stopped.
      'com.centurylinklabs.watchtower.enable': 'false',
    },
    // The adapter is a separate exec. PID 1 only keeps the container open.
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    HostConfig: {
      NetworkMode: spec.networkName,
      Binds: [
        // Directories on the data volume, so the files of a box stay when its
        // container is replaced.
        `${spec.workspaceSource}:${WORKSPACE_DIR}`,
        `${spec.homeSource}:${HOME_DIR}`,
        `${spec.nixSource}:${NIX_DIR}`,
      ],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=512m,mode=1777' },
      // Chromium keeps its shared memory in /dev/shm, and the 64 MB default of
      // Docker crashes large pages. The playwright-cli config of the box image drops
      // the Playwright flag --disable-dev-shm-usage, which would move it to TMPDIR.
      // Like the tmpfs, it counts against the memory limit only when used.
      ShmSize: 512 * 1024 * 1024,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: memoryBytes(cfg.BOX_MEM_LIMIT),
      NanoCpus: Math.round(cfg.BOX_CPUS * 1e9),
      PidsLimit: cfg.BOX_PIDS_LIMIT,
      RestartPolicy: { Name: 'no' },
      // No `Init`, because the entrypoint of the image starts under tini, which
      // reaps and forwards SIGTERM. A docker-init in front of it would leave tini
      // a child that reaps nothing.
      // The values below are explicit, so a later edit cannot loosen them by omission.
      Privileged: false,
      PublishAllPorts: false,
    },
  });
  return container.id;
}

/**
 * Starts a container. A container that already runs is not an error.
 *
 * @param containerId The name or id of the container.
 */
export async function startContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).start();
  } catch (err) {
    // 304 means the container is already started.
    if ((err as { statusCode?: number }).statusCode !== 304) throw err;
  }
}

/**
 * Stops a container with a grace period of 10 seconds. A stopped or missing
 * container is not an error.
 *
 * @param containerId The name or id of the container.
 */
export async function stopContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).stop({ t: 10 });
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 304 && code !== 404) throw err;
  }
}

/**
 * Removes a container and keeps its volumes. A missing container is not an error.
 *
 * @param containerId The name or id of the container.
 */
export async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).remove({ force: true, v: false });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/**
 * Creates the temporary container for one login.
 *
 * It gets no workspace, no agent configuration, no placeholder and no proxy.
 * It holds no deployment secret, so it is on the default bridge of Docker. It
 * is the only container of Boxes with a direct route to the internet.
 *
 * The home is a tmpfs, because the rootfs is read-only and both CLIs write
 * their state under `$HOME`. The credential material goes with the container.
 *
 * @param spec The image, the credential id for the label, and the environment.
 * @returns The id of the new container.
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
      // `exec`, because a login CLI can run from a PATH in the home. `mode=1777`,
      // because the box user must write to a tmpfs that root owns.
      Tmpfs: {
        '/home/agent': 'rw,exec,size=256m,mode=1777',
        '/tmp': 'rw,size=64m,mode=1777',
      },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      // No memory or CPU limit, because a login is one short CLI run, and a low
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
 * Lists every login container that Docker still has. The orphan sweep reads it.
 *
 * @returns The id, the credential id and the creation time in epoch milliseconds of each container.
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

/**
 * Removes a box network, after it disconnects the egress proxy. A missing
 * network is not an error.
 *
 * @param networkName The name of the network.
 * @param cfg The config, with the name of the proxy container.
 */
export async function removeNetwork(networkName: string, cfg: Config): Promise<void> {
  const net = docker().getNetwork(networkName);
  // Docker refuses to remove a network while the proxy is connected.
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
 * The state that Docker reports for a container. `missing` means that the
 * daemon does not have it, and `unknown` means that the daemon did not answer.
 */
export type ContainerState = 'running' | 'exited' | 'missing' | 'unknown';

/**
 * Reads the live state of a container. Each lookup failure maps to a state.
 *
 * @param container The name or id of the container.
 * @returns The state.
 */
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
 *
 * @param containerId The name or id of the container.
 * @param cmd The argument vector.
 * @param opts The time limit, the output cap, the working directory and the environment.
 * @returns The output and the exit code.
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

/**
 * Runs one short exec and splits its stdout and its stderr.
 *
 * @param containerId The name or id of the container.
 * @param cmd The argument vector.
 * @param opts The time limit, the working directory and the environment.
 * @returns The two output streams and the promise of the exit code.
 */
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
 * Lists every labelled box container of Docker, for boot reconciliation and
 * the orphan sweep.
 *
 * @returns The id, the box id and the run state of each container.
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

/**
 * Lists the box networks that Boxes created.
 *
 * @returns The name, the box id and the subnet of each network.
 */
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
 * Lists the box images on this host without a tag.
 *
 * Only images with IMAGE_LABEL are listed, so an image that Boxes did not
 * fetch is never listed. The function checks `RepoTags` in addition to the
 * dangling filter.
 *
 * The caller excludes the current BOX_IMAGE. A second Boxes deployment on the
 * host that pins BOX_IMAGE by digest also has an untagged current image. It is
 * listed here, and its removal costs that deployment a pull.
 *
 * @returns The image ids.
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
 * Removes an image.
 *
 * The removal is not forced, so the daemon refuses with 409 while a container
 * still uses the image. The box of that container gets the current image at
 * its next start. A 404 means that the image is already gone.
 *
 * @param id The image id.
 * @returns True when the image is removed, false for a 404 or a 409.
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
 * Connects the end of an exec to a promise for its exit code, and gives a kill
 * function.
 *
 * A hijacked stream reports its end as `end` and as `close`, so a flag makes
 * the settle run only once. `onEnd` closes the output streams of the caller
 * before the exit code is read.
 *
 * @param stream The hijacked stream of the exec.
 * @param exec The exec, for the exit code.
 * @param onEnd The function that runs once when the stream ends.
 * @param onError The function that receives a stream error.
 * @returns The promise of the exit code, and the kill function.
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
 * Without a terminal, Docker frames stdout and stderr into one stream, and the
 * function splits them. With a terminal, Docker does no framing. The stream
 * holds the bytes of the pty in both directions, and it is stdout and stdin.
 * The size is set on the exec, so the first prompt has the right width.
 *
 * @param container The name or id of the container.
 * @param cmd The argument vector.
 * @param opts The working directory, the environment, and the terminal size for a terminal.
 * @returns The streams, the promise of the exit code, and the resize and kill functions.
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

  // The start request also has Tty, because the daemon reads it there to decide
  // on the framing of the output. Frame headers would corrupt the text.
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
    // A failed resize of an ended exec goes to the debug log, because the caller
    // acts on the end of the stream.
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
