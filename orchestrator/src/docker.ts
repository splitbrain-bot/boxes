import Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { DockerState, ImageInfo } from '../../shared/types.ts';
import type { Config } from './config.ts';
import type { CredentialId, CredentialMethod } from './credentials.ts';
import { HARNESSES } from './harness.ts';
import { log } from './log.ts';
import { boxOwner } from './workspaces.ts';

/** The Docker layer: containers, networks, volumes, images and execs. */

/** Docker label carrying the box id on every object Boxes creates. */
export const LABEL = 'boxes.box';

/**
 * Label on the short-lived helper containers that copy a box's files.
 * They carry the box label too, so the orphan sweep takes them, and this
 * one so boot reconciliation never adopts one as the box's container.
 */
export const HELPER_LABEL = 'boxes.helper';

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
 * image rebuild. The image user must still match, because a new home is a
 * `cp -a` copy of the image's home and keeps its owner.
 */
function boxUser(): string {
  const { uid, gid } = boxOwner();
  return `${uid}:${gid}`;
}

/** The box's writable workspace, and the working directory of everything in it. */
export const WORKSPACE_DIR = '/workspace';

/**
 * Where the box's merged agent configuration is mounted, read-only.
 *
 * The entrypoint copies it into each harness's directories in `$HOME`. The
 * agent writes to those directories, so a read-only mount over them would
 * break the box.
 */
export const AGENT_CONFIG_DIR = '/boxes/agent';

/**
 * Where the box's Nix store is mounted, writable.
 *
 * The path is fixed: store paths are hashed against /nix/store, so the binary
 * cache has nothing for a store elsewhere. The mount is a per-box directory on
 * the data volume.
 */
export const NIX_DIR = '/nix';

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
  /** The subnet of the box network. */
  subnet: string;
  /**
   * Host-side path bind-mounted at WORKSPACE_DIR. A path rather than a volume
   * name, because the orchestrator reads these files itself.
   */
  workspaceSource: string;
  /**
   * Host-side path of the box's materialized agent configuration, bound
   * read-only at AGENT_CONFIG_DIR. Always present: a box with nothing
   * configured gets an empty manifest, which is how the entrypoint learns to
   * remove what a previous start installed.
   */
  agentConfigSource: string;
  /** Host-side path of the box's home directory, bound at `/home/agent`. */
  homeSource: string;
  /** Host-side path of the box's Nix store directory, bound at NIX_DIR. */
  nixSource: string;
  /**
   * The credential placeholders and the git identity, as built by
   * credentialEnv().
   */
  env: Record<string, string>;
  /**
   * PEM of the deployment CA this box trusts. It is set even before any
   * credential exists, as the box keeps it for its whole life.
   */
  caCertificate: string;
}

/**
 * The credential and identity part of a box's environment.
 *
 * Every harness adds its variables, even one no thread in the box uses. Each
 * credential value is a placeholder that the egress proxy swaps for the real
 * secret. A credential that is not stored has none, and its variable is
 * dropped: the environment is fixed at container creation, so a credential
 * entered later reaches the box at its next restart.
 *
 * GH_TOKEN is for git and gh. GITLAB_TOKEN and GITLAB_HOST are the same for
 * git and glab. DEVTUNNELS_TOKEN is the GitHub token the Dev Tunnels API
 * takes, for the share-app skill.
 */
export function credentialEnv(
  placeholderFor: (credentialId: string) => string,
  methodFor: (credentialId: CredentialId) => CredentialMethod | null,
  identity: { gitName: string; gitEmail: string },
  gitlabHost: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const harness of Object.values(HARNESSES)) {
    const id = harness.credentialId;
    Object.assign(env, harness.env(placeholderFor(id), methodFor(id)));
  }
  env['GH_TOKEN'] = placeholderFor('github');
  env['GITLAB_TOKEN'] = placeholderFor('gitlab');
  env['GITLAB_HOST'] = gitlabHost;
  env['DEVTUNNELS_TOKEN'] = placeholderFor('devtunnels');
  env['GIT_NAME'] = identity.gitName;
  env['GIT_EMAIL'] = identity.gitEmail;
  return env;
}

/** The agent user's home inside a box container, where its own files and caches live. */
export const HOME_DIR = '/home/agent';

/**
 * Where the entrypoint writes the system authorities together with the
 * deployment CA, and where the CA env vars point.
 */
const CA_PATH = `${HOME_DIR}/.boxes/ca-bundle.crt`;

/**
 * Environment of a box container, as Docker's `KEY=value` list. Variables
 * with an empty value are left out.
 *
 * It carries the credential placeholders, never a real credential. The CA
 * travels here as a PEM, so it needs no file on the host.
 */
export function boxEnv(spec: CreateContainerSpec, cfg: Config): string[] {
  const proxyUrl = `http://${cfg.EGRESS_PROXY_ALIAS}:${cfg.EGRESS_PROXY_PORT}`;
  const env: Record<string, string> = {
    ...spec.env,
    TERM: 'dumb',
    // Every proxy-aware client honours these; anything else has no route
    // out, which is the intended failure mode.
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };

  if (spec.caCertificate !== '') {
    // The entrypoint appends the PEM to the system authorities in CA_PATH;
    // these are the variables that point node, gh, git, git-lfs, curl and
    // Codex at it. A tool honouring none of them fails TLS against the
    // intercepted hosts and nothing else.
    env['BOXES_PROXY_CA'] = spec.caCertificate;
    env['NODE_EXTRA_CA_CERTS'] = CA_PATH;
    env['SSL_CERT_FILE'] = CA_PATH;
    env['GIT_SSL_CAINFO'] = CA_PATH;
    env['CURL_CA_BUNDLE'] = CA_PATH;
    // Codex reads this one first and falls back to SSL_CERT_FILE. It is
    // unconfirmed whether the published Codex binary reads either.
    env['CODEX_CA_CERTIFICATE'] = CA_PATH;
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

/** Creates a box network. Internal, so it has no NAT and no default route. */
export async function createNetwork(networkName: string, subnet: string, boxId: string): Promise<void> {
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
 * Creates a box's network if the daemon no longer has it, and returns whether
 * it had to.
 *
 * A prune removes a network with no containers, so a box that lost its
 * container has usually lost its network too.
 */
export async function ensureNetwork(
  networkName: string,
  subnet: string,
  boxId: string,
): Promise<boolean> {
  const existing = await inspecting(() => docker().getNetwork(networkName).inspect());
  if (existing) return false;
  await createNetwork(networkName, subnet, boxId);
  return true;
}

/** Whether a network's inspect lists the egress proxy container on it. */
function proxyOn(info: Docker.NetworkInspectInfo, cfg: Config): boolean {
  return Object.values(info.Containers ?? {}).some(
    (c) => c.Name === cfg.EGRESS_PROXY_CONTAINER,
  );
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
 */
export async function pullImage(image: string): Promise<void> {
  const stream = await docker().pull(image);
  await new Promise<void>((resolve, reject) => {
    // The pull call returns when the transfer starts; the stream ends with it.
    docker().modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
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
export async function containerImageId(containerId: string): Promise<string | null> {
  return inspecting(
    async () => (await docker().getContainer(containerId).inspect()).Image ?? null,
  );
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
 * Fills a box's empty home directory from the image's own `/home/agent` and
 * hands the whole copy to the agent.
 *
 * A bind mount hides what the image has at that path, so the copy is needed.
 * It matters most for `.profile`: it puts `~/.local/bin` back on the PATH that
 * Debian's `/etc/profile` resets, and the agent's `npm install -g` tools live
 * there.
 *
 * The copy runs as root, so this process needs no right to chown. The chown
 * is recursive, because `cp -a` keeps the uid the image was built on and the
 * agent must be able to write every file, not only the directory.
 */
export async function seedHomeFromImage(
  hostDirectory: string,
  image: string,
  boxId: string,
): Promise<void> {
  const { uid, gid } = boxOwner();
  await oneShot({
    what: 'home seed',
    image,
    boxId,
    binds: [`${hostDirectory}:/to`],
    script: `cp -a ${HOME_DIR}/. /to/ && chown -R ${uid}:${gid} /to`,
  });
}

/**
 * Runs one short-lived container over a box's files and waits for it.
 *
 * The helper runs as root, because it copies and chowns a box's files. It
 * has no network and a read-only rootfs. Each call site fixes the script, and
 * no part of it comes from user input.
 */
async function oneShot(spec: {
  what: string;
  image: string;
  boxId: string;
  binds: string[];
  script: string;
}): Promise<void> {
  const container = await docker().createContainer({
    Image: spec.image,
    User: 'root',
    // The image's entrypoint holds a container open, so it is replaced.
    Entrypoint: ['sh', '-c'],
    Cmd: [spec.script],
    Labels: { [LABEL]: spec.boxId, [HELPER_LABEL]: spec.what },
    HostConfig: {
      Binds: spec.binds,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      RestartPolicy: { Name: 'no' },
      // The entrypoint, and tini with it, is replaced above, so the init
      // comes from Docker.
      Init: true,
    },
  });
  try {
    await container.start();
    const { StatusCode } = (await container.wait()) as { StatusCode: number };
    if (StatusCode !== 0) {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 20 });
      throw new Error(`${spec.what} exited ${StatusCode}: ${logs.toString('utf8').trim()}`);
    }
  } finally {
    try {
      await container.remove({ force: true, v: false });
    } catch {
      // already gone
    }
  }
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
    Env: boxEnv(spec, cfg),
    Labels: {
      [LABEL]: spec.boxId,
      // Keeps Watchtower away. A recreated container would leave a stale id
      // in the database and lose its proxy attachment.
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
        // Read-only, so the agent cannot rewrite its configuration.
        `${spec.agentConfigSource}:${AGENT_CONFIG_DIR}:ro`,
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
 * One exec driving a login CLI: its merged output, and a way to answer it.
 * Which stream a CLI prints its URL on is not an API, so the flows read both.
 */
export interface LoginExec {
  /** stdout and stderr, demuxed and merged in arrival order. */
  output: Readable;
  /** Writable only on a TTY exec; null otherwise. */
  stdin: Duplex | null;
  /** Resolves when the exec's stream ends, with the exit code if known. */
  exited: Promise<number | null>;
  /** Drops the exec's stream. */
  kill(): void;
}

/**
 * Runs one command in a login container.
 *
 * `tty` is for `claude setup-token`, an interactive UI that refuses to run
 * without a terminal and reads the code from stdin. Under a TTY the output is
 * one raw stream, with the CLI's redraws and escape sequences.
 */
export async function spawnLoginExec(
  containerId: string,
  cmd: readonly string[],
  opts: { env?: Record<string, string>; tty?: boolean } = {},
): Promise<LoginExec> {
  const tty = opts.tty === true;
  const exec = await docker().getContainer(containerId).exec({
    Cmd: [...cmd],
    AttachStdin: tty,
    AttachStdout: true,
    AttachStderr: true,
    Tty: tty,
    Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    User: boxUser(),
    WorkingDir: '/home/agent',
  });

  // Tty on the start request too: the daemon reads it there to decide
  // whether to frame the output. Frame headers would corrupt the text.
  const stream = (await exec.start({ hijack: true, stdin: tty, Tty: tty })) as Duplex;
  const output = new PassThrough();
  if (tty) {
    // A login URL is longer than the default 80 columns, and a wrapped URL
    // reads as two lines. Best effort: a refusal leaves the default width.
    try {
      await exec.resize({ h: 50, w: 400 });
    } catch (err) {
      log.debug('could not widen the login terminal', { error: (err as Error).message });
    }
    // Raw bytes both ways, so there is no frame header to strip.
    stream.pipe(output, { end: false });
  } else {
    docker().modem.demuxStream(stream, output, output);
  }

  const { exited, kill } = execCompletion(
    stream,
    exec,
    () => output.end(),
    (err) => log.warn('login exec stream error', { error: err.message }),
  );

  return { output, stdin: tty ? stream : null, exited, kill };
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

/** Resolves a container's live state, mapping every lookup failure onto a state. */
export async function containerState(containerId: string | null): Promise<DockerState> {
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

/** One process inside a container, as `docker top` reports it. */
export interface ContainerProcess {
  /**
   * The pid, in the namespace it was read in. A pid from `docker top` is the
   * host's, and a `kill` inside the box cannot use it.
   */
  pid: number;
  /** The parent pid, in the same namespace. */
  ppid: number;
  /** The whole command line, which is how a process is recognised. */
  command: string;
  /** How long it has been running, or null where `ps` would not say. */
  elapsedSeconds: number | null;
}

/**
 * The `ps` format with the process age, and the plain one every `ps` has.
 *
 * `etimes` is procps' age in whole seconds. A host `ps` without it fails the
 * whole call, and a failed reading keeps every box on the host awake.
 */
const PS_FORMATS = ['-eo pid,ppid,etimes,args', '-eo pid,ppid,args'] as const;

/** The format this host's `ps` was found to take, or null before the first call. */
let psFormat: (typeof PS_FORMATS)[number] | null = null;

/** Test seam: forget which `ps` format this host was found to take. */
export function resetPsFormatForTests(): void {
  psFormat = null;
}

/** What the daemon answers a `top` with. */
interface ProcessListing {
  /** The column titles `ps` printed. */
  Titles?: string[];
  /** One row per process, split on whitespace with the command left whole. */
  Processes?: string[][];
}

/** One `docker top`, in a format known to work here. */
async function top(containerId: string): Promise<ProcessListing> {
  const container = docker().getContainer(containerId);
  const ask = async (ps_args: string): Promise<ProcessListing> =>
    (await container.top({ ps_args })) as ProcessListing;

  if (psFormat) return ask(psFormat);
  try {
    const rich = await ask(PS_FORMATS[0]);
    psFormat = PS_FORMATS[0];
    return rich;
  } catch (err) {
    // Only the format is retried, and only once. A daemon that is down, or a
    // container that has gone, fails the plain call too and throws from there.
    log.debug('docker top rejected the elapsed-time format; asking without it', {
      error: (err as Error).message,
    });
    const plain = await ask(PS_FORMATS[1]);
    psFormat = PS_FORMATS[1];
    return plain;
  }
}

/**
 * Every process running inside a container, with host pids.
 *
 * It uses `docker top`, which runs `ps` on the host, so it works in a
 * container without `ps` and adds no process of its own. Columns are found by
 * their titles. A container that cannot be reached throws, so the caller
 * cannot mistake it for one with nothing running.
 */
export async function containerProcesses(containerId: string): Promise<ContainerProcess[]> {
  const listing = await top(containerId);

  const titles = listing.Titles ?? [];
  const pidAt = titles.indexOf('PID');
  const ppidAt = titles.indexOf('PPID');
  // Without both columns there is no tree to read.
  if (pidAt === -1 || ppidAt === -1) {
    throw new Error(`docker top returned no PID/PPID columns: ${titles.join(',')}`);
  }
  // `etimes` prints under the title ELAPSED. It is absent on the plain format.
  const elapsedAt = titles.indexOf('ELAPSED');
  // Whatever ps put last is the command; the daemon leaves its spaces alone.
  const commandAt = titles.length - 1;

  const processes: ContainerProcess[] = [];
  for (const row of listing.Processes ?? []) {
    const pid = Number(row[pidAt]);
    const ppid = Number(row[ppidAt]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const elapsed = elapsedAt === -1 ? NaN : Number(row[elapsedAt]);
    processes.push({
      pid,
      ppid,
      command: row[commandAt] ?? '',
      elapsedSeconds: Number.isFinite(elapsed) ? elapsed : null,
    });
  }
  return processes;
}

/**
 * Every process running inside a container, with the container's own pids,
 * as a `kill` inside the box needs them. The age is always null.
 *
 * It runs the box image's `ps`. Without it, this throws.
 */
export async function containerProcessesFromInside(
  containerId: string,
): Promise<ContainerProcess[]> {
  const ps = ['ps', '-eo', 'pid,ppid,args'];
  const { stdout, stderr, code } = await execInContainer(containerId, ps);
  if (code !== 0) {
    throw new Error(
      `ps in the container exited ${code ?? 'unknown'}: ${`${stdout}${stderr}`.trim()}`,
    );
  }

  const processes: ContainerProcess[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    // Two left-padded numbers, then the command with its spaces.
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!row) continue;
    processes.push({
      pid: Number(row[1]),
      ppid: Number(row[2]),
      command: row[3] ?? '',
      elapsedSeconds: null,
    });
  }
  return processes;
}

/**
 * Signals processes inside a container, as the agent user.
 *
 * The pids must be the container's own. They are passed to `kill` as separate
 * arguments, never through a shell. A non-zero exit, for example for a pid
 * that has already gone, is only logged at debug level.
 */
export async function killInContainer(
  containerId: string,
  signal: 'TERM' | 'KILL',
  pids: readonly number[],
): Promise<void> {
  if (pids.length === 0) return;
  const { stdout, stderr, code } = await execInContainer(containerId, [
    'kill',
    `-${signal}`,
    ...pids.map((pid) => String(pid)),
  ]);
  if (code !== 0) {
    const error = `${stdout}${stderr}`.trim();
    log.debug('kill in container reported trouble', { signal, pids, code, error });
  }
}

/** How a short exec runs, and how much of what it writes is kept. */
export interface ExecOptions {
  /** The directory it runs in, as the container names it. */
  workingDir?: string;
  /** Variables set for it, on top of the container's own environment. */
  env?: Record<string, string>;
  /** How long it may run before it is signalled. Unbounded when absent. */
  timeoutMs?: number;
  /** How many bytes of each stream are kept. The rest is read and dropped. */
  maxOutput?: number;
}

/** What a short exec wrote, and how it ended. */
export interface ExecOutput {
  /** What the command wrote to stdout, up to maxOutput bytes. */
  stdout: string;
  /** What the command wrote to stderr, up to maxOutput bytes. */
  stderr: string;
  /** Null when the exit code could not be read. */
  code: number | null;
}

/**
 * Runs one command in a container as the agent user and collects its output.
 *
 * The command is an argument vector, never a shell line. `timeoutMs` is
 * enforced inside the container by `timeout`, because the daemon cannot
 * signal a running exec. The limit is rounded up to whole seconds. A command
 * that survives SIGTERM is killed five seconds later.
 */
export async function execInContainer(
  containerId: string,
  cmd: string[],
  opts: ExecOptions = {},
): Promise<ExecOutput> {
  const { stdout, stderr, exited } = await runExec(containerId, cmd, opts);
  const [out, err, code] = await Promise.all([
    readAll(stdout, opts.maxOutput),
    readAll(stderr, opts.maxOutput),
    exited,
  ]);
  return { stdout: out, stderr: err, code };
}

/** Everything a stream will produce, as one string, up to a cap on its bytes. */
async function readAll(stream: Readable, cap = Infinity): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    // Drain past the cap, so the command never blocks on a full stream.
    const buf = Buffer.from(chunk as Buffer);
    if (size < cap) chunks.push(size + buf.length <= cap ? buf : buf.subarray(0, cap - size));
    size += buf.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A command wrapped in the container's own `timeout`, when it is given a limit. */
function withTimeout(cmd: string[], timeoutMs?: number): string[] {
  if (timeoutMs === undefined) return cmd;
  return ['timeout', '--kill-after=5s', `${Math.ceil(timeoutMs / 1000)}s`, ...cmd];
}

/** One short exec with its stdout and its stderr demuxed apart. */
async function runExec(
  containerId: string,
  cmd: string[],
  opts: ExecOptions,
): Promise<{ stdout: Readable; stderr: Readable; exited: Promise<number | null> }> {
  const exec = await docker().getContainer(containerId).exec({
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
 * reconciliation and the orphan sweep. `helper` marks a copy container that
 * outlived its job rather than the box's own.
 */
export async function listBoxContainers(): Promise<
  Array<{ id: string; boxId: string; running: boolean; helper: boolean }>
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
        helper: c.Labels?.[HELPER_LABEL] !== undefined,
      },
    ];
  });
}

/** Box networks Boxes created, by the box each is labelled with. */
export async function listBoxNetworks(): Promise<Array<{ name: string; boxId: string }>> {
  const networks = await docker().listNetworks({ filters: { label: [LABEL] } });
  return networks.flatMap((n) => {
    const boxId = (n.Labels as Record<string, string> | undefined)?.[LABEL];
    return boxId && n.Name ? [{ name: n.Name, boxId }] : [];
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
  /** Drops the exec's stream. */
  kill(): void;
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
    User: boxUser(),
    WorkingDir: workingDir,
  });

  const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker().modem.demuxStream(stream, stdout, stderr);

  const { exited, kill } = execCompletion(
    stream,
    exec,
    () => {
      stdout.end();
      stderr.end();
    },
    (err) => log.warn('adapter exec stream error', { error: err.message }),
  );

  return { stdout, stderr, stdin: stream, exited, kill };
}


/**
 * A pty inside a box container, as the terminal endpoint holds one.
 *
 * Tty is true, so Docker does no framing: the stream is the pty's bytes in
 * both directions, and there is nothing to demux.
 */
export interface TerminalExec {
  /** The pty, readable and writable. */
  stream: Duplex;
  /** Tells the pty how large the window onto it is. */
  resize(cols: number, rows: number): Promise<void>;
  /** Resolves when the stream ends, with the exit code if known. */
  exited: Promise<number | null>;
  /** Ends this terminal's shell and drops the stream. */
  close(): Promise<void>;
}

/** The tmux session every terminal on a box shares, and which outlives them. */
const SHARED_TMUX_SESSION = 'boxes';

/**
 * The shell one terminal connection runs.
 *
 * `client` is this connection's own tmux session, grouped with the shared one
 * so both show the same windows. The shared session keeps the windows when
 * every client has gone, so a build carries on with nobody watching.
 *
 * The own session lets close() end the client by name, as Docker cannot
 * signal a running exec. Without tmux, the shell is a plain login shell.
 */
function terminalShell(client: string): string {
  return [
    'if ! command -v tmux >/dev/null 2>&1; then exec bash -l; fi',
    `tmux new-session -d -s ${SHARED_TMUX_SESSION} 2>/dev/null`,
    `exec tmux new-session -s ${client} -t ${SHARED_TMUX_SESSION}`,
  ].join('; ');
}

/**
 * Opens a pty in a box container, running the shell a reader types into.
 *
 * The pty runs inside the container's isolation, so it reaches no further
 * than the agent does. The command is an argument vector, and the only part
 * this process composes is a name it generated itself.
 *
 * The size is set on the exec, so the first prompt is drawn at the right
 * width.
 */
export async function openTerminalExec(
  containerId: string,
  workingDir: string,
  cols: number,
  rows: number,
): Promise<TerminalExec> {
  // Random rather than a counter, so the name cannot collide with a session
  // that an earlier orchestrator process left behind.
  const client = `web-${randomBytes(4).toString('hex')}`;

  const exec = await docker().getContainer(containerId).exec({
    Cmd: ['bash', '-lc', terminalShell(client)],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: boxUser(),
    WorkingDir: workingDir,
    // Without this an editor, a pager and everything else that draws degrade
    // to plain scrolling text.
    Env: ['TERM=xterm-256color'],
    ConsoleSize: [rows, cols],
  });

  // The daemon frames the output unless the start request says Tty too.
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex;
  const { exited, kill } = execCompletion(stream, exec, () => {}, (err) =>
    log.warn('terminal exec stream error', { error: err.message }),
  );

  return {
    stream,
    // The daemon wants the size the way ioctl does, rows before columns. A
    // resize against an exec that has ended is left at debug: the stream
    // ending is what the caller acts on.
    resize: async (nextCols, nextRows) => {
      try {
        await exec.resize({ h: nextRows, w: nextCols });
      } catch (err) {
        log.debug('terminal resize failed', { error: (err as Error).message });
      }
    },
    exited,
    close: async () => {
      // The stream is dropped either way: a box that stopped under the
      // terminal answers nothing, and has no client left to end.
      try {
        await execInContainer(containerId, ['tmux', 'kill-session', '-t', client]);
      } catch (err) {
        log.debug('could not end a terminal session', { error: (err as Error).message });
      }
      kill();
    },
  };
}
