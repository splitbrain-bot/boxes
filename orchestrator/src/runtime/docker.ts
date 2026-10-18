import type { DeploymentImages, ImageInfo, RuntimeState } from '../../../shared/types.ts';
import type { Config } from '../config.ts';
import * as dk from '../docker.ts';
import { log } from '../log.ts';
import { allocateSubnet } from '../subnet.ts';
import * as ws from '../workspaces.ts';
import {
  type BoxSpec,
  HOME_DIR,
  type Login,
  type ProcessStream,
  type PullEvent,
  RUN_TIMEOUT_MS,
  type RunOptions,
  type RunOutput,
  type Runtime,
  type RuntimeObject,
  type SpawnOptions,
  WORKSPACE_DIR,
} from './runtime.ts';

/**
 * The runtime that runs the boxes on the Docker daemon of this host.
 *
 * A box is the container `box-<id>` on its own internal network `bn-<id>`,
 * with the egress proxy attached to that network. Its storage is three
 * directories in the data volume, bind mounted into the container.
 */
export class DockerRuntime implements Runtime {
  /**
   * The host-side path of DATA_DIR, which a bind source must name. It starts
   * as HOST_DATA_DIR, or else as DATA_DIR, which is correct outside a
   * container. Inside a container without HOST_DATA_DIR, prepare() resolves it.
   */
  private hostDataDir: string;

  /**
   * The subnet allocation that is in progress, so two creates at once do not
   * take the same subnet before either network exists.
   */
  private allocating: Promise<unknown> = Promise.resolve();

  /**
   * Creates the runtime.
   *
   * @param cfg The configuration of the deployment.
   */
  constructor(
    /** The configuration of the deployment. */
    private readonly cfg: Config,
  ) {
    this.hostDataDir = cfg.HOST_DATA_DIR || cfg.DATA_DIR;
  }

  /**
   * Resolves the host-side path of DATA_DIR.
   *
   * Inside a container, the orchestrator's path for its data volume is not
   * the path the daemon resolves a bind source against. A wrong path fails
   * silently. The daemon creates an empty directory there and mounts it, and
   * the orchestrator cannot see the files of the agent. So a failure here is
   * fatal, and the message names the setting that fixes it.
   *
   * @throws Error when the process is in a container and the path cannot be resolved.
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

  /**
   * Creates the workspace, the Nix store and the home directories, owned by the agent.
   *
   * @param boxId The id of the box.
   */
  async createStorage(boxId: string): Promise<void> {
    ws.createWorkspace(this.cfg.DATA_DIR, boxId);
    ws.createNix(this.cfg.DATA_DIR, boxId);
    ws.createHome(this.cfg.DATA_DIR, boxId);
  }

  /**
   * The workspace and the home directories that are gone.
   *
   * Docker creates a missing bind source, empty and owned by root. The box
   * then looks healthy, but every turn fails. Possible causes are a crash
   * during a delete, a partly restored backup or a wrong HOST_DATA_DIR.
   *
   * @param boxId The id of the box.
   * @returns One description per missing directory, with its path.
   */
  async missingStorage(boxId: string): Promise<string[]> {
    const missing: string[] = [];
    const workspace = ws.workspacePath(this.cfg.DATA_DIR, boxId);
    const home = ws.homePath(this.cfg.DATA_DIR, boxId);
    if (!ws.directoryExists(workspace)) missing.push(`its workspace directory (${workspace})`);
    if (!ws.directoryExists(home)) missing.push(`its home directory (${home})`);
    return missing;
  }

  /**
   * Removes the three directories of a box.
   *
   * @param boxId The id of the box.
   */
  async removeStorage(boxId: string): Promise<void> {
    ws.removeWorkspace(this.cfg.DATA_DIR, boxId);
    ws.removeHome(this.cfg.DATA_DIR, boxId);
    ws.removeNix(this.cfg.DATA_DIR, boxId);
  }

  /**
   * Brings the Nix store, the network, the proxy attachment and the container
   * of a box up to date, in this order.
   *
   * The container is made only from the spec and the box directories, so a
   * new container loses no data. Each part can be missing, for example after
   * `docker container prune` or `docker system prune`.
   *
   * A running container is never changed, because a change would stop the
   * adapter exec and any turn in it. A failed proxy attachment is logged, and
   * {@link DockerRuntime.isolated} reports it.
   *
   * @param box The id and the environment of the box.
   * @throws Error when the subnet pool has no free subnet.
   */
  async ensure(box: BoxSpec): Promise<void> {
    const slog = log.box(box.boxId);
    // Create the Nix store before a bind mount names it, or the daemon creates
    // it owned by root. An empty store is usable.
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
   * Replaces a stopped container when its image differs from the image that
   * BOX_IMAGE resolves to.
   *
   * The comparison uses image ids, because a tag such as `latest` can name a
   * new image.
   *
   * @param box The id and the environment of the box.
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
    // Keep the container when the host has no BOX_IMAGE or the container is
    // gone. start() reports a missing container.
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
   * Creates the network of a box on the first free subnet of the pool.
   * Allocations run one at a time.
   *
   * @param boxId The id of the box.
   * @returns The subnet of the new network.
   * @throws Error when the pool has no free subnet.
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
   * Builds the input of createContainer for a box. The bind sources are the
   * host-side paths of its directories.
   *
   * @param box The id and the environment of the box.
   * @returns The container spec.
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

  /**
   * Starts the container that ensure() made, tolerating one that already runs.
   *
   * @param box The id and the environment of the box.
   */
  async start(box: BoxSpec): Promise<void> {
    await dk.startContainer(dk.names.container(box.boxId));
  }

  /**
   * Stops the container with a 10 second grace period, tolerating one already gone.
   *
   * @param boxId The id of the box.
   */
  async stop(boxId: string): Promise<void> {
    await dk.stopContainer(dk.names.container(boxId));
  }

  /**
   * Removes the container, then the network, which Docker refuses while a container uses it.
   *
   * @param boxId The id of the box.
   */
  async remove(boxId: string): Promise<void> {
    const container = dk.names.container(boxId);
    await dk.stopContainer(container);
    await dk.removeContainer(container);
    await dk.removeNetwork(dk.names.network(boxId), this.cfg);
  }

  /**
   * Reads the state of the container. An exited container and a container that is gone are both stopped.
   *
   * @param boxId The id of the box.
   * @returns The state of the box.
   */
  async state(boxId: string): Promise<RuntimeState> {
    const state = await dk.containerState(dk.names.container(boxId));
    if (state === 'exited' || state === 'missing') return 'stopped';
    return state;
  }

  /**
   * Checks the attachment of the egress proxy to the box network.
   *
   * @param boxId The id of the box.
   * @returns True when the proxy is attached now. False when the network cannot be read.
   */
  async isolated(boxId: string): Promise<boolean> {
    return dk.isProxyAttached(dk.names.network(boxId), this.cfg);
  }

  /**
   * Reads the image that the box container was created from.
   *
   * @param boxId The id of the box.
   * @returns The image id, or null when the container is gone.
   */
  async imageOf(boxId: string): Promise<string | null> {
    return dk.containerImageId(dk.names.container(boxId));
  }

  /**
   * Pulls the box image when it is not on this host.
   *
   * Without the image, the orchestrator cannot create a box, so a failed pull
   * throws. When the image is present, the method only inspects it.
   *
   * @param onProgress Called with each progress event of the pull.
   * @throws Error when the pull fails.
   */
  async ensureImage(onProgress?: (event: PullEvent) => void): Promise<void> {
    if (await dk.imageId(this.cfg.BOX_IMAGE)) return;
    log.info('the box image is not on this host; pulling it', { image: this.cfg.BOX_IMAGE });
    await dk.pullImage(this.cfg.BOX_IMAGE, onProgress);
    log.info('pulled the box image', { image: this.cfg.BOX_IMAGE });
  }

  /**
   * Pulls the box image again, so the host gets the image that a moving tag
   * names now. ensure() recreates a stopped box container on the new image.
   *
   * @param onProgress Called with each progress event of the pull.
   */
  async refreshImage(onProgress?: (event: PullEvent) => void): Promise<void> {
    const before = await dk.imageId(this.cfg.BOX_IMAGE);
    await dk.pullImage(this.cfg.BOX_IMAGE, onProgress);
    const after = await dk.imageId(this.cfg.BOX_IMAGE);
    if (after && after !== before) {
      log.info('the box image moved; boxes adopt it as they are started', {
        image: this.cfg.BOX_IMAGE,
      });
      // The old image is now untagged, and nothing else removes it.
      await this.pruneSupersededImages(before);
    }
  }

  /**
   * Removes copies of the box image that a pull has superseded, when BOX_IMAGE_PRUNE is set.
   *
   * The labelled images also include those that an earlier process replaced
   * and did not remove. The removal is not forced, so an image that a
   * container still uses stays until a later refresh.
   *
   * @param supersededId The image that the last pull replaced, or null when the host had none.
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

  /**
   * Lists the labelled containers and networks, the box directories on the
   * data volume, and the login containers.
   *
   * @returns The objects. Containers come before networks, and networks before directories.
   */
  async inventory(): Promise<RuntimeObject[]> {
    const containers = await dk.listBoxContainers();
    const networks = await dk.listBoxNetworks();
    const logins = await dk.listLoginContainers();
    return [
      ...containers.map(
        (c): RuntimeObject => ({
          kind: 'box',
          boxId: c.boxId,
          ref: c.id,
          running: c.running,
        }),
      ),
      ...networks.map((n): RuntimeObject => ({ kind: 'isolation', boxId: n.boxId, ref: n.name })),
      ...ws
        .boxDirectoryIds(this.cfg.DATA_DIR)
        .map((boxId): RuntimeObject => ({ kind: 'storage', boxId, ref: boxId })),
      ...logins.map(
        (l): RuntimeObject => ({
          kind: 'login',
          credentialId: l.credentialId,
          ref: l.id,
          createdAt: l.createdAt,
        }),
      ),
    ];
  }

  /**
   * Removes one container, network, or set of box directories.
   *
   * @param obj The object from {@link DockerRuntime.inventory}.
   */
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

  /**
   * Runs one exec in the box container. The `timeout` command in the box enforces the timeout.
   *
   * @param boxId The id of the box.
   * @param cmd The argument vector of the command.
   * @param opts The options of the command.
   * @returns The output and the exit code.
   */
  async run(boxId: string, cmd: readonly string[], opts: RunOptions = {}): Promise<RunOutput> {
    return dk.execInContainer(dk.names.container(boxId), cmd, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS,
    });
  }

  /**
   * Starts one long-lived exec in the box container.
   *
   * @param boxId The id of the box.
   * @param cmd The argument vector of the process.
   * @param opts The options of the process.
   * @returns The stdio and the end of the process.
   */
  async spawn(
    boxId: string,
    cmd: readonly string[],
    opts: SpawnOptions = {},
  ): Promise<ProcessStream> {
    return dk.spawnExec(dk.names.container(boxId), cmd, {
      ...opts,
      workingDir: opts.workingDir ?? WORKSPACE_DIR,
    });
  }

  /**
   * Creates and starts a login container from the box image. It is the only
   * container Boxes creates with a direct route to the internet.
   *
   * @param credentialId The id of the credential that the login is for.
   * @returns The handle of the login container.
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

  /**
   * Gives the address of the egress proxy on a box network.
   *
   * @returns The URL with the network alias and the port of the proxy.
   */
  proxyUrl(): string {
    return `http://${this.cfg.EGRESS_PROXY_ALIAS}:${this.cfg.EGRESS_PROXY_PORT}`;
  }

  /**
   * Reads the container id, the network with its subnet, and the image id, as far as they can be read.
   *
   * @param boxId The id of the box.
   * @returns The facts that could be read, each as label and value.
   */
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

  /**
   * Pings the daemon.
   *
   * @throws Error when the daemon does not answer.
   */
  async health(): Promise<void> {
    await dk.docker().ping();
  }

  /**
   * Reads the images of the orchestrator, the proxy and a new box. The
   * orchestrator and proxy images are the ones their containers were created
   * from. The proxy container is the one EGRESS_PROXY_CONTAINER names. The box
   * image is BOX_IMAGE.
   *
   * @returns The three images. An image that cannot be read is null.
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

/**
 * Runs one read for the details page, and returns null when it throws.
 *
 * @param read The read.
 * @returns The value of the read, or null.
 */
async function quietly<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.debug('could not read a runtime fact', { error: (err as Error).message });
    return null;
  }
}

/**
 * Runs one image read for the image footer, and returns null when it throws.
 *
 * The failure is logged at debug level, because the footer reads the images
 * up to once a minute, and a deployment where the read always fails would
 * otherwise log a line each minute.
 *
 * @param what The image that is read, for the log.
 * @param read The read.
 * @returns The image, or null when it is missing or the read fails.
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

/**
 * Reads the image behind a container.
 *
 * @param container The name or the id of the container, or null for none.
 * @returns The image, or null when there is no container or no image.
 */
async function imageOfContainer(container: string | null): Promise<ImageInfo | null> {
  if (!container) return null;
  const id = await dk.containerImageId(container);
  return id ? dk.imageInfo(id) : null;
}
