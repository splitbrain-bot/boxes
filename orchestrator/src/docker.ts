import Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { DockerState, ImageInfo } from '../../shared/types.ts';
import type { Config, SessionProfile } from './config.ts';
import { log } from './log.ts';
import { sessionOwner } from './workspaces.ts';

/**
 * Container, network and volume lifecycle, plus the long-lived adapter exec.
 *
 * The HostConfig below is a fixed template that user input never reaches. The
 * caller supplies only the server-generated session id and the values a
 * session is to hold in place of the deployment's credentials.
 */

/** Docker label carrying the session id on every object Boxes creates. */
export const LABEL = 'boxes.session';

/**
 * Label on the short-lived helper containers that copy a session's files.
 * They carry the session label too, so the orphan sweep takes them, and this
 * one so boot reconciliation never adopts one as the session's container.
 */
export const HELPER_LABEL = 'boxes.helper';

/**
 * Label the session image carries, so a superseded copy of it can be
 * recognised after it has lost its tag.
 *
 * A pull that moves `:latest` leaves the image it replaced untagged and on
 * disk — a gigabyte or two of it — and nothing about an untagged image says
 * whose it was. The label survives the tag, because it is baked into the
 * image's own config, and it is what lets the orchestrator prune what it
 * fetched without going near an image somebody else on this host owns.
 */
export const IMAGE_LABEL = 'boxes.image';

/** The value of that label on the session image. */
export const SESSION_IMAGE_KIND = 'session';

/**
 * The `uid:gid` every session process runs as, as Docker wants it written.
 *
 * Numbers rather than the image's `agent`, so SESSION_UID alone decides who a
 * session is and the image needs no rebuild to be read differently. The two
 * still have to agree about the home volume, which Docker initialises from
 * the image; ensureSessionImage() reads the image's user back.
 */
function sessionUser(): string {
  const { uid, gid } = sessionOwner();
  return `${uid}:${gid}`;
}

/** The session's writable workspace, and the working directory of everything in it. */
export const WORKSPACE_DIR = '/workspace';

/**
 * Where the session's merged agent configuration is mounted, read-only.
 *
 * The entrypoint installs it into `~/.claude` from here. It is not mounted at
 * `~/.claude` directly because that directory is on the home volume, is
 * written by the agent, and holds the transcripts — a read-only mount over it
 * would break the box, and a writable one would let the agent edit what the
 * dashboard says is configured.
 */
export const AGENT_CONFIG_DIR = '/boxes/agent';

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
 * Docker object names derived from a session id.
 *
 * A workspace and a home are both directories on the orchestrator's data
 * volume, so there is no volume name to derive. The `ws-<id>` or `home-<id>`
 * volume of a session from before those changes is read off its row.
 */
export const names = {
  container: (id: string) => `session-${id}`,
  network: (id: string) => `sn-${id}`,
};

/**
 * What a session is handed in place of the deployment's real credentials.
 *
 * Where translation is on these are placeholders and the proxy swaps them for
 * the real thing on the wire, so nothing inside the container is worth
 * stealing. Where it is off — a credential this deployment did not configure —
 * they are whatever the profile holds.
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
  /**
   * Host-side path bind-mounted at WORKSPACE_DIR. A path rather than a volume
   * name because the orchestrator has to read these files itself; see
   * workspaces.ts for how it is resolved.
   */
  workspaceSource: string;
  /**
   * Host-side path of the session's materialized agent configuration, bound
   * read-only at AGENT_CONFIG_DIR. Always present: a session with nothing
   * configured gets an empty manifest, which is how the entrypoint learns to
   * remove what a previous start installed.
   */
  agentConfigSource: string;
  /**
   * What is mounted at `/home/agent`: the host-side path of the session's
   * home directory, or — for a session created before homes became
   * directories — the name of its volume. A bind source and a volume name are
   * the same field to Docker, and which one this is is the caller's business.
   */
  homeSource: string;
  profile: SessionProfile;
  egress: SessionEgress;
}

/** The agent user's home inside a session container, where its own files and caches live. */
export const HOME_DIR = '/home/agent';

/** Where the entrypoint writes the CA, and where the CA env vars point. */
const CA_PATH = `${HOME_DIR}/.boxes/proxy-ca.crt`;

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
    CLAUDE_CONFIG_DIR: `${HOME_DIR}/.claude`,
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
    // fails TLS against the intercepted hosts and nothing else.
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
 * Creates a session's network if the daemon no longer has it, and says
 * whether it had to.
 *
 * For rebuilding a session Docker has forgotten. A network with no containers
 * on it is "unused" to `docker network prune` and to `docker system prune`,
 * so the network usually goes at the same moment the container does — and a
 * container cannot be created into a network that is not there. Everything
 * needed to make it again is on the session's row.
 */
export async function ensureNetwork(
  networkName: string,
  subnet: string,
  sessionId: string,
): Promise<boolean> {
  const existing = await inspecting(() => docker().getNetwork(networkName).inspect());
  if (existing) return false;
  await createNetwork(networkName, subnet, sessionId);
  return true;
}

/**
 * Whether a network's own inspect says the egress proxy is on it.
 *
 * One predicate for both questions below, so "is it attached" cannot come to
 * mean two slightly different things.
 */
function proxyOn(info: Docker.NetworkInspectInfo, cfg: Config): boolean {
  return Object.values(info.Containers ?? {}).some(
    (c) => c.Name === cfg.EGRESS_PROXY_CONTAINER,
  );
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
  if (proxyOn(info, cfg)) return true;
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
    return proxyOn(await docker().getNetwork(networkName).inspect(), cfg);
  } catch {
    return false;
  }
}

// --- resolving this process's own host-side paths ---------------------------

/**
 * The answer a test installed, or undefined to read the process's own.
 *
 * The real sources are files under `/proc`, which a test process cannot
 * arrange, so there is no other way to stand where a containerised
 * orchestrator stands.
 */
let selfIdForTests: string | null | undefined = undefined;

/** Answers `selfContainerId` with `id`, or with the real sources for null. */
export function setSelfContainerIdForTests(id: string | null | undefined): void {
  selfIdForTests = id;
}

/**
 * This process's own container id, or null when it is not in a container.
 *
 * Three sources, because none of them holds everywhere. `/etc/hostname` is the
 * classic answer but compose sets a container's hostname to its service name,
 * which is not an id at all; mountinfo carries the id in the paths of the
 * three files Docker always binds into a container; the cgroup path carries it
 * under cgroup v1 and under v2 with a named hierarchy, and is `0::/` otherwise.
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
 * Pulling here is what lets SESSION_IMAGE name a published tag rather than
 * something every deployment builds out of a checkout.
 *
 * No auth is passed: a deployment that needs a private registry configures
 * the daemon's own credentials, which is where Docker looks anyway.
 */
export async function pullImage(image: string): Promise<void> {
  const stream = await docker().pull(image);
  await new Promise<void>((resolve, reject) => {
    // The pull is a progress stream, and it is only complete when that stream
    // is: awaiting the call alone returns as soon as the transfer starts.
    docker().modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Reads something off an inspect, answering null for an object the daemon does
 * not have.
 *
 * "It is not here" is a legitimate answer to every question below, and the
 * daemon spells it as a 404. Any other failure is the daemon being unwell and
 * is rethrown, so no caller reads it as absence.
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
 * The uid an image's own `USER` names, or null when it names something this
 * cannot read as a number.
 *
 * An older image, or one built elsewhere, may carry a user name, which
 * leaves no uid to compare.
 */
export async function imageUserUid(image: string): Promise<number | null> {
  return inspecting(async () => {
    const info = await docker().getImage(image).inspect();
    const user = (info.Config?.User ?? '').split(':')[0] ?? '';
    return /^\d+$/.test(user) ? Number(user) : null;
  });
}

/**
 * The id of an image on this host, or null when it is not here.
 *
 * The id and not the tag, because the question this answers is whether a
 * moving tag has moved.
 */
export async function imageId(image: string): Promise<string | null> {
  return inspecting(async () => (await docker().getImage(image).inspect()).Id ?? null);
}

/**
 * The digest, build date and size of an image on this host, or null when it
 * is not here.
 *
 * `RepoDigests` carries what a registry knows the image by, and that is the
 * answer wherever there is one — a deployment following a published tag wants
 * to compare against what was published. An image built here has never been
 * in a registry and has no entry there, so the local config id stands in.
 *
 * `Created` is the only build date an image carries, and a value that will
 * not parse is reported as no date rather than as a NaN nothing downstream
 * could render. `Size` is read on the same terms.
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
 * This is the one thing a bind of a path under the orchestrator's own /data
 * needs and cannot guess: bind sources are resolved by the daemon, so the
 * source has to be the path the daemon knows, which is the `Source` of the
 * mount whose `Destination` is the directory in question. With the shipped
 * compose that resolves to `/var/lib/docker/volumes/boxes-data/_data`.
 */
export async function resolveHostMountSource(destination: string): Promise<string | null> {
  const self = selfContainerId();
  if (!self) return null;
  // A host whose hostname happens to look like a container id has no such
  // container; that is "no mount" rather than a failed boot.
  const info = await inspecting(() => docker().getContainer(self).inspect());
  if (!info) return null;
  const mount = (info.Mounts ?? []).find((m) => m.Destination === destination);
  return mount?.Source ?? null;
}

/**
 * Copies a named volume's content into a host directory, through a one-shot
 * container that can see both.
 *
 * This is how a session created before workspaces were directories moves
 * onto one. The orchestrator has no path to a named volume, so the copy has
 * to run somewhere both are mounted.
 */
export async function copyVolumeToDirectory(
  volumeName: string,
  hostDirectory: string,
  image: string,
  sessionId: string,
): Promise<void> {
  await oneShot({
    what: `copy of ${volumeName}`,
    image,
    sessionId,
    binds: [`${volumeName}:/from:ro`, `${hostDirectory}:/to`],
    script: 'cp -a /from/. /to/',
  });
}

/**
 * Fills a session's empty home directory from the image's own `/home/agent`.
 *
 * Docker seeds a named volume from the image once, when it is created. A
 * bind mount instead covers whatever the image put there, so a fresh home
 * directory starts out empty.
 *
 * `.profile` is what that loses. Debian's `/etc/profile` reassigns PATH for a
 * login shell, and the skeleton `.profile` that `useradd -m` leaves is what
 * puts `~/.local/bin` back, which is where `npm install -g` puts the agent's
 * own tools. Exec runs `bash -lc`, so without it a login shell stops finding
 * a tool the agent installed.
 *
 * The copy runs as root with `cp -a`, which preserves the ownership the image
 * gave the contents. The directory itself is chowned in the same script,
 * which is the one thing `cp -a` of the contents leaves out, and doing it in
 * the container covers a deployment where this process cannot chown.
 */
export async function seedHomeFromImage(
  hostDirectory: string,
  image: string,
  sessionId: string,
): Promise<void> {
  const { uid, gid } = sessionOwner();
  await oneShot({
    what: 'home seed',
    image,
    sessionId,
    binds: [`${hostDirectory}:/to`],
    script: `cp -a ${HOME_DIR}/. /to/ && chown ${uid}:${gid} /to`,
  });
}

/**
 * Runs one short-lived container over a session's files and waits for it.
 *
 * `cp -a` preserves ownership, which keeps the agent's files the agent's;
 * that needs root in the helper, so these are the containers Boxes creates
 * that do not drop to the session user. They have no network and a read-only
 * rootfs, and the script is fixed at each call site — no part of it comes
 * from anything a user typed.
 */
async function oneShot(spec: {
  what: string;
  image: string;
  sessionId: string;
  binds: string[];
  script: string;
}): Promise<void> {
  const container = await docker().createContainer({
    Image: spec.image,
    User: 'root',
    // The image's own entrypoint holds a container open; this one has a job
    // and exits, so the entrypoint is replaced rather than run.
    Entrypoint: ['sh', '-c'],
    Cmd: [spec.script],
    Labels: { [LABEL]: spec.sessionId, [HELPER_LABEL]: spec.what },
    HostConfig: {
      Binds: spec.binds,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      RestartPolicy: { Name: 'no' },
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

/** Creates a session container from the fixed, hardened HostConfig template. */
export async function createContainer(spec: CreateContainerSpec, cfg: Config): Promise<string> {
  const container = await docker().createContainer({
    name: names.container(spec.sessionId),
    Image: spec.image,
    User: sessionUser(),
    WorkingDir: WORKSPACE_DIR,
    Env: sessionEnv(spec, cfg),
    Labels: {
      [LABEL]: spec.sessionId,
      // A session container is the orchestrator's, and only the
      // orchestrator's: it is tracked by the id returned here, attached to
      // its network after the fact, and recreated on a new image at start.
      // An outside updater that stopped and recreated one would leave the id
      // in the database pointing at nothing and drop the proxy attachment
      // that is the session's only way out, so the opt-out every such tool
      // reads is part of the template rather than something each deployment
      // has to remember. Watchtower honours it; nothing else minds it.
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
        // Both are directories on the orchestrator's data volume, so that
        // reviewing a session's files needs no exec and no running container,
        // and so that what a session is costing can be read by walking two
        // paths. A session from before homes became directories names its
        // volume here instead, and Docker takes either.
        `${spec.workspaceSource}:${WORKSPACE_DIR}`,
        `${spec.homeSource}:${HOME_DIR}`,
        // Read-only: what the dashboard says a box is configured with is not
        // something the agent inside it gets to rewrite.
        `${spec.agentConfigSource}:${AGENT_CONFIG_DIR}:ro`,
      ],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=512m,mode=1777' },
      // Chromium puts its shared memory in /dev/shm, and Docker's default
      // there is 64 MB -- which any substantial page exhausts, reported as a
      // closed target rather than as anything about memory. Playwright's
      // answer, on by default on every Chromium it launches, is
      // --disable-dev-shm-usage, which only moves that traffic to TMPDIR; the
      // session image points TMPDIR at the home volume so that large temporary
      // files stop competing with the memory limit, and a browser's shared
      // memory is the one thing that wants the opposite. So the container gets
      // a /dev/shm worth using and the image turns the flag back off, which
      // takes ignoreDefaultArgs rather than an args list -- see
      // session-image/playwright-cli.config.json.
      //
      // The two halves travel together: without the flag suppressed this is
      // unused, and without this the suppression leaves the browser on 64 MB.
      //
      // Like Tmpfs above this is RAM charged to the container's memory limit,
      // but only as used: an empty /dev/shm costs nothing, so the ceiling
      // matters and the number does not.
      ShmSize: 512 * 1024 * 1024,
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
   * The pid, in whichever namespace it was read.
   *
   * `docker top` runs `ps` on the host, so what it reports is the host's pid
   * for a process rather than the one the container knows it by. Enough to
   * walk the tree, and not something to hand a `kill` inside the box; see
   * `containerProcessesFromInside`.
   */
  pid: number;
  ppid: number;
  /** The whole command line, which is how a process is recognised. */
  command: string;
  /** How long it has been running, or null where `ps` would not say. */
  elapsedSeconds: number | null;
}

/**
 * The `ps` format the reading wants, and the one every `ps` has.
 *
 * `etimes` is procps' own: an age in whole seconds. A host whose `ps` does
 * not know it fails the whole call, and a failed reading holds every box on
 * that host awake, so the refusal is remembered and the plain format used
 * from then on.
 */
const PS_FORMATS = ['-eo pid,ppid,etimes,args', '-eo pid,ppid,args'] as const;
let psFormat: (typeof PS_FORMATS)[number] | null = null;

/** Test seam: forget which `ps` format this host was found to take. */
export function resetPsFormatForTests(): void {
  psFormat = null;
}

/** What the daemon answers a `top` with: whatever titles `ps` printed, and rows. */
interface ProcessListing {
  Titles?: string[];
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
 * Every process running inside a container.
 *
 * `top` rather than an exec: it is one API call against the daemon, the `ps`
 * runs on the host, and a container with no `ps` of its own — or no shell —
 * answers just the same. An exec would also be a process, which is a poor
 * way to ask what processes there are.
 *
 * The columns are asked for by name and read back by name: `top` returns
 * whatever titles the host's `ps` printed, and the daemon splits each row on
 * whitespace with the command left whole at the end. A container that cannot
 * be reached throws, which the caller reads as "no answer" rather than as
 * "nothing running".
 */
export async function containerProcesses(containerId: string): Promise<ContainerProcess[]> {
  const listing = await top(containerId);

  const titles = listing.Titles ?? [];
  const pidAt = titles.indexOf('PID');
  const ppidAt = titles.indexOf('PPID');
  // Without both columns there is no tree to read, and guessing at positions
  // would invent one. The caller treats a throw as "no answer".
  if (pidAt === -1 || ppidAt === -1) {
    throw new Error(`docker top returned no PID/PPID columns: ${titles.join(',')}`);
  }
  // `etimes` prints under the same title as `etime` and is only ever asked
  // for as one of the two, so the title is enough to find it. Absent where
  // this host's `ps` would not take it.
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
 * The same reading, taken from inside the container.
 *
 * Only the stop needs this, and only because of the namespace: a pid from
 * `docker top` is the host's, and the box has its own numbering for the same
 * process. A `kill` has to be told the box's, so the tree is read again from
 * in there at the moment it is used, which is also the freshest it can be:
 * a process that ended in between is not in it.
 *
 * `ps` is the session image's, which is why the image installs procps and
 * asserts it. A box without it throws, and a stop that cannot find its target
 * says so rather than killing something else.
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
    // Three fields, and the third keeps its spaces: `ps` pads the numbers on
    // the left, so what is wanted is the first two runs of digits and then
    // everything after them.
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
 * The pids must be the container's own, and are only ever ones this read out
 * of it a moment earlier. They travel as separate arguments to `kill`, never
 * as a string a shell has to take apart. A pid that has already gone makes
 * `kill` complain and exit non-zero, which is not a failure worth reporting:
 * the point was for it to be gone.
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
  stdout: string;
  stderr: string;
  /** Null when the exit code could not be read. */
  code: number | null;
}

/**
 * Runs one command in a container as the agent user and collects its output.
 *
 * The command travels as an argument vector, never as a line a shell has to
 * take apart. `timeoutMs` is enforced inside the container, by `timeout`,
 * because the daemon offers no way to signal a running exec: dropping the
 * attached stream would leave the command running. The limit is rounded up to
 * whole seconds, a command that survives the term signal is killed five
 * seconds later, and one the limit stopped exits 124 like any other failure.
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
    // Read to the end whatever the cap says, so the command is never left
    // waiting on a stream nobody drains.
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
    User: sessionUser(),
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
 * Whether a container has a mount at `destination`.
 *
 * A container's mounts are fixed when it is created, so this is how a session
 * from before a mount existed is recognised and recreated with it. A container
 * that cannot be inspected answers true: a missing one has nothing to fix, and
 * recreating on a transient inspect failure would be the more destructive
 * mistake.
 */
export async function hasMount(containerId: string, destination: string): Promise<boolean> {
  try {
    const info = await docker().getContainer(containerId).inspect();
    return (info.Mounts ?? []).some((m) => m.Destination === destination);
  } catch {
    return true;
  }
}

/**
 * Every labelled session container Docker knows about, for boot
 * reconciliation and the orphan sweep. `helper` marks a copy container that
 * outlived its job rather than the session's own.
 */
export async function listSessionContainers(): Promise<
  Array<{ id: string; sessionId: string; running: boolean; helper: boolean }>
> {
  const containers = await docker().listContainers({
    all: true,
    filters: { label: [LABEL] },
  });
  return containers.flatMap((c) => {
    const sessionId = c.Labels?.[LABEL];
    if (!sessionId) return [];
    return [
      {
        id: c.Id,
        sessionId,
        running: c.State === 'running',
        helper: c.Labels?.[HELPER_LABEL] !== undefined,
      },
    ];
  });
}

/** Session networks Boxes created, by the session each is labelled with. */
export async function listSessionNetworks(): Promise<Array<{ name: string; sessionId: string }>> {
  const networks = await docker().listNetworks({ filters: { label: [LABEL] } });
  return networks.flatMap((n) => {
    const sessionId = (n.Labels as Record<string, string> | undefined)?.[LABEL];
    return sessionId && n.Name ? [{ name: n.Name, sessionId }] : [];
  });
}

/** Session volumes Boxes created, by the session each is labelled with. */
export async function listSessionVolumes(): Promise<Array<{ name: string; sessionId: string }>> {
  const { Volumes } = await docker().listVolumes({ filters: { label: [LABEL] } });
  return (Volumes ?? []).flatMap((v) => {
    const sessionId = v.Labels?.[LABEL];
    return sessionId && v.Name ? [{ name: v.Name, sessionId }] : [];
  });
}

/**
 * Ids of session images on this host that have lost their tag.
 *
 * Untagged and labelled as ours: an old copy of the session image, left
 * behind by a pull that moved the tag off it. The label is the whole of what
 * keeps this from being `docker image prune` — an image Boxes never fetched
 * does not carry it, and is never listed here however unused it is.
 *
 * `RepoTags` is checked as well as the filter, so a removal never rests on a
 * filter string alone.
 *
 * The caller excludes what SESSION_IMAGE resolves to now. One case is left:
 * a second Boxes deployment on the same host whose SESSION_IMAGE pins a
 * digest has a current image with no tag either, which looks superseded from
 * here. It costs that deployment a re-pull, and any container of its own on
 * the image makes the daemon refuse the removal.
 */
export async function listSupersededSessionImages(): Promise<string[]> {
  const images = await docker().listImages({
    filters: { dangling: ['true'], label: [`${IMAGE_LABEL}=${SESSION_IMAGE_KIND}`] },
  });
  return images
    .filter((i) => (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>').length === 0)
    .map((i) => i.Id)
    .filter((id): id is string => Boolean(id));
}

/**
 * Removes an image, and says whether it went.
 *
 * Never forced. A container still created from this image — a session that
 * has not been started since the tag moved — makes the daemon refuse with a
 * 409, and that refusal is the safety property rather than an error to work
 * around: the session is moved onto the current image at its next start, and
 * the image goes on the sweep after that. 404 is somebody else having removed
 * it, which is the outcome this wanted anyway.
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
    User: sessionUser(),
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
 * A pty inside a session container, as the terminal endpoint holds one.
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
 * so both show the same windows. The shared session is created detached first
 * and holds those windows once every client has gone, which is what lets a
 * build carry on with nobody watching.
 *
 * Each connection gets a session of its own so that it can be ended by name.
 * Docker offers no way to signal a running exec, so dropping the stream alone
 * would leave the client attached for good. The windows outlive the kill,
 * being linked to the shared session too.
 *
 * A box whose image predates tmux falls back to a plain login shell.
 */
function terminalShell(client: string): string {
  return [
    'if ! command -v tmux >/dev/null 2>&1; then exec bash -l; fi',
    `tmux new-session -d -s ${SHARED_TMUX_SESSION} 2>/dev/null`,
    `exec tmux new-session -s ${client} -t ${SHARED_TMUX_SESSION}`,
  ].join('; ');
}

/**
 * Opens a pty in a session container, running the shell a reader types into.
 *
 * The pty runs inside the container's existing isolation — internal network,
 * read-only rootfs, capabilities dropped, non-root user — so this reaches no
 * further than the agent in the same box already does. Nothing here
 * shell-executes on the host: the command is an argument vector handed to the
 * daemon and never reaches a host command line, and the only part of it this
 * process composes is a name it generated itself.
 *
 * The size is what the browser reported, and it is set on the exec rather than
 * afterwards so the shell's first prompt is already drawn to the right width.
 */
export async function openTerminalExec(
  containerId: string,
  workingDir: string,
  cols: number,
  rows: number,
): Promise<TerminalExec> {
  // A duplicate name is a session that refuses to start, and a counter
  // starting again would collide with a client an earlier process left behind.
  const client = `web-${randomBytes(4).toString('hex')}`;

  const exec = await docker().getContainer(containerId).exec({
    Cmd: ['bash', '-lc', terminalShell(client)],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: sessionUser(),
    WorkingDir: workingDir,
    // Without this an editor, a pager and everything else that draws degrade
    // to plain scrolling text.
    Env: ['TERM=xterm-256color'],
    ConsoleSize: [rows, cols],
  });

  const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
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
