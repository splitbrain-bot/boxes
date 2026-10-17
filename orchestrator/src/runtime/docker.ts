import type { DeploymentImages, ImageInfo, RuntimeState } from '../../../shared/types.ts';
import type { Config } from '../config.ts';
import * as dk from '../docker.ts';
import { log } from '../log.ts';
import { allocateSubnet } from '../subnet.ts';
import * as ws from '../workspaces.ts';
import {
  HOME_DIR,
  RUN_TIMEOUT_MS,
  WORKSPACE_DIR,
  type BoxSpec,
  type Login,
  type ProcessStream,
  type PullEvent,
  type RunOptions,
  type RunOutput,
  type Runtime,
  type RuntimeObject,
  type SpawnOptions,
} from './runtime.ts';

/**
 * Runs boxes on the Docker daemon of this host.
 *
 * A box is the container `box-<id>` on its own internal network `bn-<id>`,
 * with the egress proxy attached to that network. Its storage is three
 * directories in the data volume, bind mounted into the container.
 */
export class DockerRuntime implements Runtime {
  /**
   * Host-side path of DATA_DIR, which is what a bind source has to name.
   * Starts as this process's own path, the truth outside a container, where
   * `npm run dev` and the tests run. prepare() replaces it.
   */
  private hostDataDir: string;

  /**
   * The subnet allocation that is in progress, so two creates at once do not
   * take the same subnet before either network exists.
   */
  private allocating: Promise<unknown> = Promise.resolve();

  constructor(
    /** The deployment's configuration. */
    private readonly cfg: Config,
  ) {
    this.hostDataDir = cfg.HOST_DATA_DIR || cfg.DATA_DIR;
  }

  // --- boot -------------------------------------------------------------------

  /**
   * Resolves the host-side path of DATA_DIR.
   *
   * Inside a container, the orchestrator's path for its data volume is not
   * the path the daemon resolves a bind source against. A wrong path fails
   * silently: the daemon creates an empty directory there and mounts it, and
   * the agent's files end up where the orchestrator cannot see them. So a
   * failure here is fatal, and the message names the setting that fixes it.
   */
  async prepare(): Promise<void> {
    ws.ensureWorkspacesRoot(this.cfg.DATA_DIR);
    if (this.cfg.HOST_DATA_DIR) {
      log.info('using the configured host path for the data directory', {
        hostDataDir: this.hostDataDir,
      });
      return;
    }
    if (!dk.inContainer()) return;
    const source = await dk.resolveHostMountSource(this.cfg.DATA_DIR);
    if (!source) {
      throw new Error(
        `Could not resolve the host-side path of ${this.cfg.DATA_DIR}: this process is in a ` +
          'container but has no mount there, or its own container could not be identified. ' +
          'Mount the data directory, or set HOST_DATA_DIR to the path the Docker daemon knows it by.',
      );
    }
    this.hostDataDir = source;
    log.info('resolved the host path of the data directory', { hostDataDir: source });
  }

  // --- storage ----------------------------------------------------------------

  /** Creates the workspace, the Nix store and the home directories, owned by the agent. */
  async createStorage(boxId: string): Promise<void> {
    ws.createWorkspace(this.cfg.DATA_DIR, boxId);
    ws.createNix(this.cfg.DATA_DIR, boxId);
    ws.createHome(this.cfg.DATA_DIR, boxId);
  }

  /**
   * The workspace and the home directories that are gone.
   *
   * Docker creates a missing bind source, empty and owned by root. The box
   * then looks healthy while every turn fails. A crash during a delete, a
   * partly restored backup, or a wrong HOST_DATA_DIR all cause this.
   */
  async missingStorage(boxId: string): Promise<string[]> {
    const missing: string[] = [];
    const workspace = ws.workspacePath(this.cfg.DATA_DIR, boxId);
    const home = ws.homePath(this.cfg.DATA_DIR, boxId);
    if (!ws.directoryExists(workspace)) missing.push(`its workspace directory (${workspace})`);
    if (!ws.directoryExists(home)) missing.push(`its home directory (${home})`);
    return missing;
  }

  /** Removes the three directories of a box. */
  async removeStorage(boxId: string): Promise<void> {
    ws.removeWorkspace(this.cfg.DATA_DIR, boxId);
    ws.removeHome(this.cfg.DATA_DIR, boxId);
    ws.removeNix(this.cfg.DATA_DIR, boxId);
  }

  // --- lifecycle --------------------------------------------------------------

  /**
   * Brings the Nix store, the network, the proxy attachment and the container
   * of a box up to date, in this order.
   *
   * A box container is built entirely from the spec and the box's
   * directories, so replacing one costs nothing durable. `docker container
   * prune` removes every stopped container, which includes every idle box,
   * and `docker system prune` removes the network too.
   *
   * A container that runs is never changed, because that would take the
   * adapter exec, and any turn in it, with it. A failed proxy attachment is
   * logged, and {@link isolated} reports it.
   */
  async ensure(box: BoxSpec): Promise<void> {
    const slog = log.box(box.boxId);
    // Before anything binds the Nix store, which the daemon would otherwise
    // create empty and owned by root. An empty store is usable.
    ws.createNix(this.cfg.DATA_DIR, box.boxId);

    const network = dk.names.network(box.boxId);
    if (!(await dk.networkExists(network))) {
      const subnet = await this.createNetwork(box.boxId);
      slog.info('made the box network', { network, subnet });
    }
    await dk.ensureProxyAttached(network, this.cfg);

    const container = dk.names.container(box.boxId);
    const state = await dk.containerState(container);
    // An unknown state means the daemon did not answer, and the container may be running.
    if (state === 'unknown' || state === 'running') return;
    if (state === 'missing') {
      await dk.createContainer(this.containerSpec(box), this.cfg);
      slog.info('created the container');
      return;
    }
    await this.rollOntoCurrentImage(box);
  }

  /**
   * Replaces a stopped container whose image is no longer what BOX_IMAGE
   * resolves to.
   *
   * The comparison is on image ids rather than the tag, because a tag such
   * as `latest` moves without changing its name.
   */
  private async rollOntoCurrentImage(box: BoxSpec): Promise<void> {
    const slog = log.box(box.boxId);
    const container = dk.names.container(box.boxId);
    let wanted: string | null;
    let current: string | null;
    try {
      wanted = await dk.imageId(this.cfg.BOX_IMAGE);
      current = await dk.containerImageId(container);
    } catch (err) {
      // A box that already has a container can start without the comparison.
      slog.warn('could not compare the box image; starting as it is', {
        error: (err as Error).message,
      });
      return;
    }
    // Nothing on the host to move to, or a container Docker no longer has:
    // either way there is nothing to decide, and start() surfaces the second.
    if (!wanted || !current || wanted === current) return;

    slog.info('recreating the container on the current box image', {
      from: current,
      image: this.cfg.BOX_IMAGE,
    });
    // Both tolerate a container that is gone.
    await dk.stopContainer(container);
    await dk.removeContainer(container);
    await dk.createContainer(this.containerSpec(box), this.cfg);
    slog.info('box moved onto the current box image', { image: this.cfg.BOX_IMAGE });
  }

  /**
   * Creates the network of a box on the first free subnet of the pool, and
   * returns the subnet. Allocations run one at a time.
   */
  private async createNetwork(boxId: string): Promise<string> {
    const run = this.allocating.then(async () => {
      const taken = new Set(
        (await dk.listBoxNetworks()).flatMap((n) => (n.subnet ? [n.subnet] : [])),
      );
      const subnet = allocateSubnet(this.cfg.BOX_SUBNET_POOL, taken);
      if (!subnet) throw new Error('No free subnet in the pool');
      await dk.createNetwork(dk.names.network(boxId), subnet, boxId);
      return subnet;
    });
    this.allocating = run.catch(() => {});
    return run;
  }

  /**
   * Everything createContainer needs about a box. The bind sources are the
   * host-side paths of its directories.
   */
  private containerSpec(box: BoxSpec): dk.CreateContainerSpec {
    return {
      boxId: box.boxId,
      image: this.cfg.BOX_IMAGE,
      networkName: dk.names.network(box.boxId),
      workspaceSource: ws.hostWorkspacePath(this.hostDataDir, box.boxId),
      nixSource: ws.hostNixPath(this.hostDataDir, box.boxId),
      homeSource: ws.hostHomePath(this.hostDataDir, box.boxId),
      env: box.env,
    };
  }

  /** Starts the container that ensure() made, tolerating one that already runs. */
  async start(box: BoxSpec): Promise<void> {
    await dk.startContainer(dk.names.container(box.boxId));
  }

  /** Stops the container with a 10 second grace period, tolerating one already gone. */
  async stop(boxId: string): Promise<void> {
    await dk.stopContainer(dk.names.container(boxId));
  }

  /** Removes the container, then the network, which Docker refuses while a container uses it. */
  async remove(boxId: string): Promise<void> {
    const container = dk.names.container(boxId);
    await dk.stopContainer(container);
    await dk.removeContainer(container);
    await dk.removeNetwork(dk.names.network(boxId), this.cfg);
  }

  /** An exited container and a container that is gone are both stopped. */
  async state(boxId: string): Promise<RuntimeState> {
    const state = await dk.containerState(dk.names.container(boxId));
    if (state === 'exited' || state === 'missing') return 'stopped';
    return state;
  }

  /** True when the egress proxy is attached to the box network right now. */
  async isolated(boxId: string): Promise<boolean> {
    return dk.isProxyAttached(dk.names.network(boxId), this.cfg);
  }

  // --- the box image ----------------------------------------------------------

  /** The id of the image the box container was created from. */
  async imageOf(boxId: string): Promise<string | null> {
    return dk.containerImageId(dk.names.container(boxId));
  }

  /**
   * Pulls the box image when it is not on this host.
   *
   * Absent, there is nothing to create a box out of, so this is the one pull
   * that is allowed to fail loudly. Present, it costs one inspect and says
   * nothing.
   */
  async ensureImage(onProgress?: (event: PullEvent) => void): Promise<void> {
    if (await dk.imageId(this.cfg.BOX_IMAGE)) return;
    log.info('the box image is not on this host; pulling it', { image: this.cfg.BOX_IMAGE });
    await dk.pullImage(this.cfg.BOX_IMAGE, onProgress);
    log.info('pulled the box image', { image: this.cfg.BOX_IMAGE });
  }

  /**
   * Pulls the box image again, so a moving tag moves here. A box moves onto
   * the new image at its next start.
   */
  async refreshImage(onProgress?: (event: PullEvent) => void): Promise<void> {
    const before = await dk.imageId(this.cfg.BOX_IMAGE);
    await dk.pullImage(this.cfg.BOX_IMAGE, onProgress);
    const after = await dk.imageId(this.cfg.BOX_IMAGE);
    if (after && after !== before) {
      log.info('the box image moved; boxes adopt it as they are started', {
        image: this.cfg.BOX_IMAGE,
      });
      // The copy it moved off is now untagged, on this host, and a gigabyte
      // or two that nothing else reclaims.
      await this.pruneSupersededImages(before);
    }
  }

  /**
   * Removes copies of the box image that a pull has superseded.
   *
   * Called after a refresh that moved the tag. `supersededId` is the image
   * that pull replaced. The labelled images also include those an earlier
   * process replaced and did not clean up.
   *
   * Nothing is forced. The daemon refuses to remove an image a container was
   * created from, so a box that has not started since the tag moved keeps
   * its old image. That image goes on a later sweep, after the box's next
   * start has moved it onto the new one.
   */
  private async pruneSupersededImages(supersededId: string | null): Promise<void> {
    if (!this.cfg.BOX_IMAGE_PRUNE) return;
    const current = await dk.imageId(this.cfg.BOX_IMAGE);
    const candidates = new Set(await dk.listSupersededBoxImages());
    // An image built without the label is found only here, by its id.
    if (supersededId) candidates.add(supersededId);
    candidates.delete(current ?? '');

    for (const id of candidates) {
      try {
        if (await dk.removeImage(id)) {
          log.info('removed a superseded box image', { image: id });
        }
      } catch (err) {
        log.warn('could not remove a superseded box image', {
          image: id,
          error: (err as Error).message,
        });
      }
    }
  }

  // --- inventory --------------------------------------------------------------

  /**
   * The labelled containers and networks, the box directories on the data
   * volume, and the login containers. Containers come before networks, and
   * networks before directories.
   */
  async inventory(): Promise<RuntimeObject[]> {
    const containers = await dk.listBoxContainers();
    const networks = await dk.listBoxNetworks();
    const logins = await dk.listLoginContainers();
    return [
      ...containers.map((c): RuntimeObject => ({
        kind: 'box',
        boxId: c.boxId,
        ref: c.id,
        running: c.running,
      })),
      ...networks.map((n): RuntimeObject => ({ kind: 'isolation', boxId: n.boxId, ref: n.name })),
      ...ws.boxDirectoryIds(this.cfg.DATA_DIR).map(
        (boxId): RuntimeObject => ({ kind: 'storage', boxId, ref: boxId }),
      ),
      ...logins.map((l): RuntimeObject => ({
        kind: 'login',
        credentialId: l.credentialId,
        ref: l.id,
        createdAt: l.createdAt,
      })),
    ];
  }

  /** Removes one container, network, or set of box directories. */
  async removeObject(obj: RuntimeObject): Promise<void> {
    switch (obj.kind) {
      case 'box':
      case 'login':
        await dk.removeContainer(obj.ref);
        return;
      case 'isolation':
        await dk.removeNetwork(obj.ref, this.cfg);
        return;
      case 'storage':
        await this.removeStorage(obj.ref);
        return;
    }
  }

  // --- processes --------------------------------------------------------------

  /** One exec in the box container. The `timeout` command in the box enforces the timeout. */
  async run(boxId: string, cmd: readonly string[], opts: RunOptions = {}): Promise<RunOutput> {
    return dk.execInContainer(dk.names.container(boxId), cmd, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS,
    });
  }

  /** One long-lived exec in the box container. */
  async spawn(boxId: string, cmd: readonly string[], opts: SpawnOptions = {}): Promise<ProcessStream> {
    return dk.spawnExec(dk.names.container(boxId), cmd, {
      ...opts,
      workingDir: opts.workingDir ?? WORKSPACE_DIR,
    });
  }

  /**
   * Creates and starts a login container from the box image. It is the only
   * container Boxes creates with a direct route to the internet.
   */
  async startLogin(credentialId: string): Promise<Login> {
    const id = await dk.createLoginContainer({ image: this.cfg.BOX_IMAGE, credentialId });
    await dk.startContainer(id);
    return {
      spawn: (cmd, opts = {}) => dk.spawnExec(id, cmd, { ...opts, workingDir: HOME_DIR }),
      remove: async () => {
        try {
          await dk.removeContainer(id);
        } catch (err) {
          log.warn('could not remove a login container', {
            container: id,
            error: (err as Error).message,
          });
        }
      },
    };
  }

  // --- facts ------------------------------------------------------------------

  /** The URL of the egress proxy, as a box on its network reaches it. */
  proxyUrl(): string {
    return `http://${this.cfg.EGRESS_PROXY_ALIAS}:${this.cfg.EGRESS_PROXY_PORT}`;
  }

  /** The container id, the network with its subnet, and the image id, as far as they can be read. */
  async details(boxId: string): Promise<Array<[string, string]>> {
    const network = dk.names.network(boxId);
    const [container, subnet, image] = await Promise.all([
      quietly(() => dk.containerId(dk.names.container(boxId))),
      quietly(() => dk.networkSubnet(network)),
      quietly(() => this.imageOf(boxId)),
    ]);
    const facts: Array<[string, string]> = [];
    if (container) facts.push(['Container', container.slice(0, 12)]);
    if (subnet) facts.push(['Network', `${network} (${subnet})`]);
    if (image) facts.push(['Image', image.replace(/^sha256:/, '').slice(0, 12)]);
    return facts;
  }

  /** Pings the daemon. */
  async health(): Promise<void> {
    await dk.docker().ping();
  }

  /**
   * The orchestrator and proxy images are the ones their containers were
   * created from. The proxy container is the one EGRESS_PROXY_CONTAINER
   * names. The box image is BOX_IMAGE itself, so it needs no container.
   */
  async deploymentImages(): Promise<DeploymentImages> {
    const [orchestrator, proxy, box] = await Promise.all([
      safely('orchestrator', () => imageOfContainer(dk.selfContainerId())),
      safely('proxy', () => imageOfContainer(this.cfg.EGRESS_PROXY_CONTAINER)),
      safely('box', () => dk.imageInfo(this.cfg.BOX_IMAGE)),
    ]);
    return { orchestrator, proxy, box };
  }
}

/** Runs one read for the details page, and returns null when it throws. */
async function quietly<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.debug('could not read a runtime fact', { error: (err as Error).message });
    return null;
  }
}

/**
 * Runs one image read, and returns null when it throws.
 *
 * A missing image is a normal answer, for example when the proxy is not up
 * or the daemon cannot be reached. The failure is logged at debug level, as
 * a deployment where the read cannot work would otherwise log a line a minute.
 */
async function safely(
  what: string,
  read: () => Promise<ImageInfo | null>,
): Promise<ImageInfo | null> {
  try {
    return await read();
  } catch (err) {
    log.debug('could not read an image', { what, error: (err as Error).message });
    return null;
  }
}

/** The image behind a container, by container name or id. */
async function imageOfContainer(container: string | null): Promise<ImageInfo | null> {
  if (!container) return null;
  const id = await dk.containerImageId(container);
  return id ? dk.imageInfo(id) : null;
}
