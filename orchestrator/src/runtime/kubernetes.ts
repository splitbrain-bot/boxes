import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { PassThrough } from 'node:stream';
import {
  CoreV1Api,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
  type V1NetworkPolicySpec,
  type V1Pod,
  type V1PodSecurityContext,
  type V1SecurityContext,
  type V1Service,
  type V1Status,
} from '@kubernetes/client-node';
import type { DeploymentImages, ImageInfo, RuntimeState } from '../../../shared/types.ts';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { readAll, withTimeout } from './exec.ts';
import {
  type BoxSpec,
  HOME_DIR,
  type Login,
  NIX_DIR,
  type ProcessStream,
  RUN_TIMEOUT_MS,
  type RunOptions,
  type RunOutput,
  type Runtime,
  type RuntimeObject,
  type SpawnOptions,
  WORKSPACE_DIR,
} from './runtime.ts';

/** Label that holds the box id, on the pod, the policy and the claim of a box. */
export const LABEL = 'boxes.box';

/** Label that holds the credential id, on a login pod. */
export const LOGIN_LABEL = 'boxes.login';

/** Name of the one container in a box pod and in a login pod. */
const CONTAINER = 'box';

/** Name of the policy that isolates all login pods. */
export const LOGIN_POLICY = 'boxes-login';

/** The names of the objects of a box. */
export const names = {
  /**
   * Gives the name of the pod, the policy and the claim of a box.
   *
   * @param id The id of the box.
   * @returns The name.
   */
  box: (id: string) => `box-${id}`,
};

/** The grace period of a stop in seconds, as on Docker. */
const STOP_GRACE_SECONDS = 10;

/**
 * Reasons of a waiting container that make a start fail at once. They report
 * an image that the kubelet cannot pull or a container that it cannot create.
 */
const FATAL_WAITING = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'ErrImageNeverPull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
]);

/**
 * Address ranges a login pod must not reach. The egress proxy refuses them
 * too. The pod and Service ranges of nearly every cluster are in them.
 */
const PRIVATE_V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
];

/** The IPv6 counterparts of {@link PRIVATE_V4}, unique local and link-local. */
const PRIVATE_V6 = ['fc00::/7', 'fe80::/10'];

/** The clients of the Kubernetes API that the runtime uses, and its namespace. */
export interface KubeClients {
  /** The namespace that holds the boxes, the proxy and the orchestrator. */
  namespace: string;
  /** The client for pods, claims and Services. */
  core: CoreV1Api;
  /** The client for network policies. */
  networking: NetworkingV1Api;
  /** The client that starts a process in a pod. */
  exec: Pick<Exec, 'exec'>;
}

/**
 * Connects with the kubeconfig of this process, or with the service account
 * of its pod in the cluster. The namespace is the one of the context, which
 * in the cluster is the namespace of the pod. It is `default` when the
 * context names none.
 *
 * @param context The kubeconfig context to use. The current context when absent.
 * @returns The clients and the namespace.
 * @throws Error when the kubeconfig has no context of that name.
 */
export function connect(context?: string): KubeClients {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  if (context !== undefined) {
    if (!kc.getContextObject(context)) throw new Error(`The kubeconfig has no context ${context}`);
    kc.setCurrentContext(context);
  }
  return {
    namespace: kc.getContextObject(kc.getCurrentContext())?.namespace || 'default',
    core: kc.makeApiClient(CoreV1Api),
    networking: kc.makeApiClient(NetworkingV1Api),
    exec: new Exec(kc),
  };
}

/** How often the runtime polls and how long it waits, in milliseconds. */
export interface Timing {
  /** The time between two reads of a pod that starts or stops. */
  pollMs: number;
  /** How long a pod may take to run. The time includes scheduling, the volume and the image pull. */
  startMs: number;
  /** How long a deleted pod may take to go. */
  stopMs: number;
}

/** The waits of a real cluster. A box image of some gigabytes can take minutes to pull. */
const TIMING: Timing = {
  pollMs: 500,
  startMs: 10 * 60_000,
  stopMs: (STOP_GRACE_SECONDS + 50) * 1000,
};

/** What prepare() reads from the Service of the egress proxy. */
interface ProxyService {
  /** The cluster IP, which a box connects to without DNS. */
  ip: string;
  /** The labels of the proxy pods, which the policy of a box allows. */
  selector: Record<string, string>;
  /** The port of the proxy pods behind EGRESS_PROXY_PORT, as a number or a port name. */
  targetPort: number | string;
}

/**
 * The runtime that runs the boxes as pods in the namespace of the orchestrator.
 *
 * A box is a pod, a volume claim and a network policy with the same name.
 */
export class KubernetesRuntime implements Runtime {
  /** The proxy Service, as prepare() read it, or null before prepare(). */
  private proxy: ProxyService | null = null;

  /**
   * Creates the runtime.
   *
   * @param cfg The configuration of the deployment.
   * @param kube The clients of the API. By default, the clients of {@link connect}.
   * @param timing The waits. Tests make them short.
   */
  constructor(
    /** The configuration of the deployment. */
    private readonly cfg: Config,
    /** The clients of the API. */
    private readonly kube: KubeClients = connect(),
    /** The waits. */
    private readonly timing: Timing = TIMING,
  ) {}

  /**
   * Reads the Service of the egress proxy.
   *
   * @throws Error when the Service cannot be read, or has no cluster IP, no selector or no proxy port.
   */
  async prepare(): Promise<void> {
    const name = this.cfg.EGRESS_PROXY_SERVICE;
    const where = `the Service ${name} in the namespace ${this.kube.namespace}`;
    let service: V1Service;
    try {
      service = await this.kube.core.readNamespacedService({
        name,
        namespace: this.kube.namespace,
      });
    } catch (err) {
      throw new Error(`Could not read ${where}: ${message(err)}`);
    }
    const ip = service.spec?.clusterIP;
    const selector = service.spec?.selector ?? {};
    const port = service.spec?.ports?.find((p) => p.port === this.cfg.EGRESS_PROXY_PORT);
    if (!ip || ip === 'None') throw new Error(`${where} has no cluster IP`);
    if (Object.keys(selector).length === 0) throw new Error(`${where} selects no pods`);
    if (!port) throw new Error(`${where} has no port ${this.cfg.EGRESS_PROXY_PORT}`);
    this.proxy = { ip, selector, targetPort: port.targetPort ?? port.port };
    log.info('found the egress proxy', { service: name, ip, namespace: this.kube.namespace });
  }

  /**
   * Creates the claim of a box from the default storage class.
   *
   * @param boxId The id of the box.
   */
  async createStorage(boxId: string): Promise<void> {
    await this.kube.core.createNamespacedPersistentVolumeClaim({
      namespace: this.kube.namespace,
      body: {
        metadata: { name: names.box(boxId), labels: { [LABEL]: boxId } },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: quantity(this.cfg.BOX_STORAGE_SIZE) } },
        },
      },
    });
  }

  /**
   * Checks the claim of a box.
   *
   * @param boxId The id of the box.
   * @returns A description of the claim when it is gone or is being deleted, else nothing.
   */
  async missingStorage(boxId: string): Promise<string[]> {
    const name = names.box(boxId);
    const claim = await absentAsNull(() =>
      this.kube.core.readNamespacedPersistentVolumeClaim({ name, namespace: this.kube.namespace }),
    );
    if (claim && !claim.metadata?.deletionTimestamp) return [];
    return [`its volume claim (${name})`];
  }

  /**
   * Deletes the claim and waits until it is gone. The storage class decides
   * what happens to the volume.
   *
   * @param boxId The id of the box.
   * @throws Error when a pod still uses the claim after the stop time.
   */
  async removeStorage(boxId: string): Promise<void> {
    await this.deleteClaim(names.box(boxId));
  }

  /**
   * Creates the policy of a box, or replaces it when its spec differs. The pod
   * is made at each start, so there is nothing else to repair.
   *
   * @param box The id and the environment of the box.
   */
  async ensure(box: BoxSpec): Promise<void> {
    const wanted = this.boxPolicy(box.boxId);
    const name = names.box(box.boxId);
    const current = await this.readPolicy(name);
    if (!current) {
      await this.kube.networking.createNamespacedNetworkPolicy({
        namespace: this.kube.namespace,
        body: wanted,
      });
      log.box(box.boxId).info('made the box policy', { policy: name });
    } else if (!sameSpec(current.spec, wanted.spec)) {
      await this.kube.networking.replaceNamespacedNetworkPolicy({
        name,
        namespace: this.kube.namespace,
        body: {
          ...wanted,
          metadata: { ...wanted.metadata, resourceVersion: current.metadata?.resourceVersion },
        },
      });
      log.box(box.boxId).warn('repaired the box policy', { policy: name });
    }
  }

  /**
   * Makes the pod of a box and waits until it runs.
   *
   * A pod that runs or is starting already is kept. A pod that ended, for
   * example after an out-of-memory kill, or that is being deleted, goes first,
   * so the new pod never competes with it for the volume. A pod that cannot
   * start is deleted again, so the box does not read as running.
   *
   * @param box The id and the environment of the box.
   * @throws Error when the pod ends, cannot start, or does not run within the start time.
   */
  async start(box: BoxSpec): Promise<void> {
    const name = names.box(box.boxId);
    const existing = await this.readPod(name);
    const keep = existing !== null && !existing.metadata?.deletionTimestamp && isLive(existing);
    if (!keep) {
      if (existing) await this.deletePod(name, STOP_GRACE_SECONDS);
      await this.kube.core.createNamespacedPod({
        namespace: this.kube.namespace,
        body: this.boxPod(box),
      });
    }
    try {
      await this.waitUntilRunning(name);
    } catch (err) {
      await this.deletePod(name, 0).catch(() => {});
      throw err;
    }
  }

  /**
   * Deletes the pod with a 10 second grace period, and waits until it is gone. The claim stays.
   *
   * @param boxId The id of the box.
   * @throws Error when the pod is still there after the stop time.
   */
  async stop(boxId: string): Promise<void> {
    await this.deletePod(names.box(boxId), STOP_GRACE_SECONDS);
  }

  /**
   * Deletes the pod and the policy.
   *
   * @param boxId The id of the box.
   */
  async remove(boxId: string): Promise<void> {
    await this.stop(boxId);
    await absentAsNull(() =>
      this.kube.networking.deleteNamespacedNetworkPolicy({
        name: names.box(boxId),
        namespace: this.kube.namespace,
      }),
    );
  }

  /**
   * Reads the state of the pod. A pod that runs or starts is running. No pod,
   * or a pod that ended, is stopped. A failed read or the pod phase Unknown
   * gives unknown.
   *
   * @param boxId The id of the box.
   * @returns The state of the box.
   */
  async state(boxId: string): Promise<RuntimeState> {
    let pod: V1Pod | null;
    try {
      pod = await this.readPod(names.box(boxId));
    } catch {
      return 'unknown';
    }
    if (!pod) return 'stopped';
    if (isLive(pod)) return 'running';
    return pod.status?.phase === 'Unknown' ? 'unknown' : 'stopped';
  }

  /**
   * Checks the policy of a box.
   *
   * @param boxId The id of the box.
   * @returns True when the policy exists as ensure() makes it. False when it cannot be read.
   */
  async isolated(boxId: string): Promise<boolean> {
    try {
      const current = await this.readPolicy(names.box(boxId));
      return current !== null && sameSpec(current.spec, this.boxPolicy(boxId).spec);
    } catch {
      return false;
    }
  }

  /**
   * Reads the image id of the pod, which the kubelet reports once the container runs.
   *
   * @param boxId The id of the box.
   * @returns The image id, or null when there is no pod or no image id yet.
   */
  async imageOf(boxId: string): Promise<string | null> {
    const pod = await this.readPod(names.box(boxId));
    return pod ? podImageId(pod) : null;
  }

  /** Does nothing, because the kubelet pulls the image at the start of a pod. */
  async ensureImage(): Promise<void> {}

  /** Does nothing, because BOX_IMAGE_PULL_POLICY decides when the kubelet pulls. */
  async refreshImage(): Promise<void> {}

  /**
   * Lists the labelled pods, policies and claims, and the login pods.
   *
   * @returns The objects. Pods come before policies, and policies before claims.
   */
  async inventory(): Promise<RuntimeObject[]> {
    const namespace = this.kube.namespace;
    const [pods, policies, claims, logins] = await Promise.all([
      this.kube.core.listNamespacedPod({ namespace, labelSelector: LABEL }),
      this.kube.networking.listNamespacedNetworkPolicy({ namespace, labelSelector: LABEL }),
      this.kube.core.listNamespacedPersistentVolumeClaim({ namespace, labelSelector: LABEL }),
      this.kube.core.listNamespacedPod({ namespace, labelSelector: LOGIN_LABEL }),
    ]);
    const labelled = <T extends { metadata?: { name?: string; labels?: Record<string, string> } }>(
      items: T[],
      label: string,
    ) =>
      items.flatMap((item) => {
        const value = item.metadata?.labels?.[label];
        const ref = item.metadata?.name;
        return value && ref ? [{ item, value, ref }] : [];
      });
    return [
      ...labelled(pods.items, LABEL).map(
        ({ item, value, ref }): RuntimeObject => ({
          kind: 'box',
          boxId: value,
          ref,
          running: isLive(item),
        }),
      ),
      ...labelled(policies.items, LABEL).map(
        ({ value, ref }): RuntimeObject => ({
          kind: 'isolation',
          boxId: value,
          ref,
        }),
      ),
      ...labelled(claims.items, LABEL).map(
        ({ value, ref }): RuntimeObject => ({
          kind: 'storage',
          boxId: value,
          ref,
        }),
      ),
      ...labelled(logins.items, LOGIN_LABEL).map(
        ({ item, value, ref }): RuntimeObject => ({
          kind: 'login',
          credentialId: value,
          ref,
          createdAt: item.metadata?.creationTimestamp
            ? new Date(item.metadata.creationTimestamp).getTime()
            : 0,
        }),
      ),
    ];
  }

  /**
   * Deletes one pod, policy or claim. A box pod gets its grace period, and the call waits for it.
   *
   * @param obj The object from {@link KubernetesRuntime.inventory}.
   */
  async removeObject(obj: RuntimeObject): Promise<void> {
    const ref = { name: obj.ref, namespace: this.kube.namespace };
    switch (obj.kind) {
      case 'box':
        await this.deletePod(obj.ref, STOP_GRACE_SECONDS);
        return;
      case 'login':
        await absentAsNull(() =>
          this.kube.core.deleteNamespacedPod({ ...ref, gracePeriodSeconds: 0 }),
        );
        return;
      case 'isolation':
        await absentAsNull(() => this.kube.networking.deleteNamespacedNetworkPolicy(ref));
        return;
      case 'storage':
        await this.deleteClaim(obj.ref);
        return;
    }
  }

  /**
   * Runs one exec in the pod. The `timeout` command in the box enforces the timeout.
   *
   * @param boxId The id of the box.
   * @param cmd The argument vector of the command.
   * @param opts The options of the command.
   * @returns The output and the exit code.
   */
  async run(boxId: string, cmd: readonly string[], opts: RunOptions = {}): Promise<RunOutput> {
    const proc = await this.exec(
      names.box(boxId),
      withTimeout(cmd, opts.timeoutMs ?? RUN_TIMEOUT_MS),
      { workingDir: opts.workingDir, env: opts.env },
      false,
    );
    const [stdout, stderr, code] = await Promise.all([
      readAll(proc.stdout, opts.maxOutput),
      readAll(proc.stderr, opts.maxOutput),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  /**
   * Starts one long-lived exec in the pod.
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
    return this.exec(
      names.box(boxId),
      cmd,
      { ...opts, workingDir: opts.workingDir ?? WORKSPACE_DIR },
      true,
    );
  }

  /**
   * Starts a process in a pod through the API server.
   *
   * The exec API has no working directory and no variables, so `env` in the
   * box sets them. `env` also gives the exit code 127 for a command the box
   * does not have, where the API gives none. A terminal gets its size from
   * `stty` before the command runs, because the first resize message can
   * arrive after the command has read the size.
   *
   * The end of stdin reaches the process only with the protocol
   * `v5.channel.k8s.io`, from Kubernetes 1.30. The client asks for it first.
   *
   * @param pod The name of the pod.
   * @param cmd The argument vector of the process.
   * @param opts The options of the process.
   * @param withStdin True to connect stdin.
   * @returns The stdio and the end of the process.
   */
  private async exec(
    pod: string,
    cmd: readonly string[],
    opts: SpawnOptions,
    withStdin: boolean,
  ): Promise<ProcessStream> {
    const tty = opts.tty;
    const sized = tty
      ? [
          'sh',
          '-c',
          'stty cols "$1" rows "$2" && shift 2 && exec "$@"',
          'sh',
          String(tty.cols),
          String(tty.rows),
        ]
      : [];
    const command = [
      'env',
      ...(opts.workingDir ? ['-C', opts.workingDir] : []),
      ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ...sized,
      ...cmd,
    ];

    // The client sends the size of a terminal from these two fields, at the
    // start and at each `resize` event.
    const stdout = tty
      ? Object.assign(new PassThrough(), { columns: tty.cols, rows: tty.rows })
      : new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let code: number | null = null;
    const socket = await this.kube.exec.exec(
      this.kube.namespace,
      pod,
      CONTAINER,
      command,
      stdout,
      // With a terminal, the kubelet sends all output on stdout and drops a stderr request.
      tty ? null : stderr,
      withStdin ? stdin : null,
      tty !== undefined,
      (status) => {
        code = exitCodeOf(status);
      },
    );

    let settle: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const finish = (): void => {
      for (const stream of [stdout, stderr]) if (!stream.writableEnded) stream.end();
      settle(code);
    };
    socket.on('close', finish);
    socket.on('error', (err: Error) => {
      log.warn('exec stream error', { command: cmd[0], error: err.message });
      finish();
    });

    return {
      stdout,
      stderr,
      stdin,
      exited,
      resize: async (cols, rows) => {
        if (!tty) return;
        Object.assign(stdout, { columns: cols, rows });
        stdout.emit('resize');
      },
      kill: () => {
        try {
          socket.close();
        } catch {
          // kill() must not throw, whatever state the socket is in.
        }
      },
    };
  }

  /**
   * Starts a login pod from the box image, and waits until it runs. Its
   * policy lets it reach the internet and the cluster DNS, and no private
   * address.
   *
   * @param credentialId The id of the credential that the login is for.
   * @returns The handle of the login pod.
   * @throws Error when the pod ends, cannot start, or does not run within the start time.
   */
  async startLogin(credentialId: string): Promise<Login> {
    await this.ensureLoginPolicy();
    const name = `login-${randomBytes(4).toString('hex')}`;
    await this.kube.core.createNamespacedPod({
      namespace: this.kube.namespace,
      body: this.loginPod(name, credentialId),
    });
    const remove = async (): Promise<void> => {
      try {
        await absentAsNull(() =>
          this.kube.core.deleteNamespacedPod({
            name,
            namespace: this.kube.namespace,
            gracePeriodSeconds: 0,
          }),
        );
      } catch (err) {
        log.warn('could not remove a login pod', { pod: name, error: message(err) });
      }
    };
    try {
      await this.waitUntilRunning(name);
    } catch (err) {
      await remove();
      throw err;
    }
    return {
      spawn: (cmd, opts = {}) => this.exec(name, cmd, { ...opts, workingDir: HOME_DIR }, true),
      remove,
    };
  }

  /**
   * Gives the proxy URL of a box, with the address of the egress proxy at the cluster IP of its Service.
   *
   * @param boxId The id of the box.
   * @param token The token of the box at the proxy.
   * @returns The URL of the proxy, with the box id and the token.
   * @throws Error before prepare().
   */
  proxyUrl(boxId: string, token: string): string {
    if (!this.proxy) throw new Error('The Kubernetes runtime is not prepared');
    const host = this.proxy.ip.includes(':') ? `[${this.proxy.ip}]` : this.proxy.ip;
    return `http://${boxId}:${token}@${host}:${this.cfg.EGRESS_PROXY_PORT}`;
  }

  /**
   * Reads the pod with its node, the claim, and the image id, as far as they can be read.
   *
   * @param boxId The id of the box.
   * @returns The facts that could be read, each as label and value.
   */
  async details(boxId: string): Promise<Array<[string, string]>> {
    const name = names.box(boxId);
    const [pod, claim] = await Promise.all([
      quietly(() => this.readPod(name)),
      quietly(() =>
        absentAsNull(() =>
          this.kube.core.readNamespacedPersistentVolumeClaim({
            name,
            namespace: this.kube.namespace,
          }),
        ),
      ),
    ]);
    const facts: Array<[string, string]> = [];
    if (pod) facts.push(['Pod', pod.spec?.nodeName ? `${name} (on ${pod.spec.nodeName})` : name]);
    if (claim)
      facts.push(['Volume claim', `${name} (${claim.status?.capacity?.storage ?? 'pending'})`]);
    const image = pod ? podImageId(pod) : null;
    if (image)
      facts.push([
        'Image',
        digestOf(image)
          .replace(/^sha256:/, '')
          .slice(0, 12),
      ]);
    return facts;
  }

  /**
   * Reads the Service of the egress proxy.
   *
   * @throws Error when the Service cannot be read.
   */
  async health(): Promise<void> {
    await this.kube.core.readNamespacedService({
      name: this.cfg.EGRESS_PROXY_SERVICE,
      namespace: this.kube.namespace,
    });
  }

  /**
   * The image ids of the pod of this process, of a proxy pod, and of the box
   * pod that started last. The kubelet resolves the tag of BOX_IMAGE, so only
   * a started pod knows the image of a new box.
   *
   * @returns The three images. An image that cannot be read is null.
   */
  async deploymentImages(): Promise<DeploymentImages> {
    const namespace = this.kube.namespace;
    const [orchestrator, proxy, box] = await Promise.all([
      safely('orchestrator', async () => {
        const pod = await this.readPod(hostname());
        return pod ? podImageId(pod) : null;
      }),
      safely('proxy', async () => {
        if (!this.proxy) return null;
        const labelSelector = Object.entries(this.proxy.selector)
          .map(([k, v]) => `${k}=${v}`)
          .join(',');
        const pods = await this.kube.core.listNamespacedPod({ namespace, labelSelector });
        return pods.items.map(podImageId).find((id) => id !== null) ?? null;
      }),
      safely('box', async () => {
        const pods = await this.kube.core.listNamespacedPod({ namespace, labelSelector: LABEL });
        const started = pods.items
          .filter((pod) => podImageId(pod) !== null)
          .sort((a, b) => startedAt(b) - startedAt(a));
        return started[0] ? podImageId(started[0]) : null;
      }),
    ]);
    return { orchestrator, proxy, box };
  }

  /**
   * Builds the policy of a box: no ingress, and egress only to the proxy pods on the proxy port.
   *
   * @param boxId The id of the box.
   * @returns The policy.
   * @throws Error before prepare().
   */
  private boxPolicy(boxId: string): V1NetworkPolicy {
    if (!this.proxy) throw new Error('The Kubernetes runtime is not prepared');
    return {
      metadata: { name: names.box(boxId), labels: { [LABEL]: boxId } },
      spec: {
        podSelector: { matchLabels: { [LABEL]: boxId } },
        policyTypes: ['Ingress', 'Egress'],
        egress: [
          {
            to: [{ podSelector: { matchLabels: this.proxy.selector } }],
            ports: [{ protocol: 'TCP', port: this.proxy.targetPort }],
          },
        ],
      },
    };
  }

  /**
   * Creates the policy of the login pods when it is missing. Their DNS is the
   * cluster DNS, found by the label that CoreDNS has in most clusters.
   */
  private async ensureLoginPolicy(): Promise<void> {
    if (await this.readPolicy(LOGIN_POLICY)) return;
    const except = (cidr: string, ranges: string[]) => ({ ipBlock: { cidr, except: ranges } });
    await this.kube.networking.createNamespacedNetworkPolicy({
      namespace: this.kube.namespace,
      body: {
        metadata: { name: LOGIN_POLICY },
        spec: {
          podSelector: { matchExpressions: [{ key: LOGIN_LABEL, operator: 'Exists' }] },
          policyTypes: ['Ingress', 'Egress'],
          egress: [
            { to: [except('0.0.0.0/0', PRIVATE_V4), except('::/0', PRIVATE_V6)] },
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                  },
                  podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
                },
              ],
              ports: [
                { protocol: 'UDP', port: 53 },
                { protocol: 'TCP', port: 53 },
              ],
            },
          ],
        },
      },
    });
    log.info('made the login policy', { policy: LOGIN_POLICY });
  }

  /**
   * Builds the pod of a box. It meets the `restricted` Pod Security Standard
   * and has the hardening of the Docker container. It must not share its
   * process namespace, because the process list expects the init of the image
   * as pid 1.
   *
   * @param box The id and the environment of the box.
   * @returns The pod.
   */
  private boxPod(box: BoxSpec): V1Pod {
    const claim = names.box(box.boxId);
    return {
      metadata: { name: names.box(box.boxId), labels: { [LABEL]: box.boxId } },
      spec: {
        ...this.podBasics(),
        // A new subPath directory gets the mode of the volume root, which
        // fsGroup makes writable for the group. OnRootMismatch skips the walk
        // over the whole Nix store at each start.
        securityContext: { ...this.podSecurity(), fsGroupChangePolicy: 'OnRootMismatch' },
        terminationGracePeriodSeconds: STOP_GRACE_SECONDS,
        volumes: [
          { name: 'storage', persistentVolumeClaim: { claimName: claim } },
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
          // Chromium keeps its shared memory here, as on Docker.
          { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
        ],
        containers: [
          {
            ...this.containerBasics(),
            workingDir: WORKSPACE_DIR,
            env: Object.entries(box.env).map(([name, value]) => ({ name, value })),
            volumeMounts: [
              { name: 'storage', subPath: 'workspace', mountPath: WORKSPACE_DIR },
              { name: 'storage', subPath: 'home', mountPath: HOME_DIR },
              { name: 'storage', subPath: 'nix', mountPath: NIX_DIR },
              { name: 'tmp', mountPath: '/tmp' },
              { name: 'shm', mountPath: '/dev/shm' },
            ],
            resources: {
              limits: { memory: quantity(this.cfg.BOX_MEM_LIMIT), cpu: String(this.cfg.BOX_CPUS) },
              requests: {
                memory: quantity(this.cfg.BOX_MEM_REQUEST),
                cpu: String(this.cfg.BOX_CPU_REQUEST),
              },
            },
          },
        ],
      },
    };
  }

  /**
   * Builds the pod of a login: the box image with its home in memory and no storage.
   *
   * @param name The name of the pod.
   * @param credentialId The id of the credential that the login is for.
   * @returns The pod.
   */
  private loginPod(name: string, credentialId: string): V1Pod {
    return {
      metadata: { name, labels: { [LOGIN_LABEL]: credentialId } },
      spec: {
        ...this.podBasics(),
        securityContext: this.podSecurity(),
        terminationGracePeriodSeconds: 0,
        volumes: [
          { name: 'home', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
        ],
        // No resource limits, as on Docker, because a low limit can break the CLI of a login.
        containers: [
          {
            ...this.containerBasics(),
            workingDir: HOME_DIR,
            volumeMounts: [
              { name: 'home', mountPath: HOME_DIR },
              { name: 'tmp', mountPath: '/tmp' },
            ],
          },
        ],
      },
    };
  }

  /**
   * Gives the settings of every pod of the runtime.
   *
   * @returns No restart, no API token and no Service variables.
   */
  private podBasics() {
    return {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
    } as const;
  }

  /**
   * Gives the security context of every pod of the runtime.
   *
   * @returns The user, the group and the seccomp profile.
   */
  private podSecurity(): V1PodSecurityContext {
    return {
      runAsUser: this.cfg.BOX_UID,
      runAsGroup: this.cfg.BOX_GID,
      runAsNonRoot: true,
      fsGroup: this.cfg.BOX_GID,
      seccompProfile: { type: 'RuntimeDefault' },
    };
  }

  /**
   * Gives the image and the hardening of the container of every pod of the runtime.
   *
   * @returns The name, the image, the pull policy and the security context of the container.
   */
  private containerBasics() {
    const securityContext: V1SecurityContext = {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      privileged: false,
      capabilities: { drop: ['ALL'] },
    };
    return {
      name: CONTAINER,
      image: this.cfg.BOX_IMAGE,
      imagePullPolicy: this.cfg.BOX_IMAGE_PULL_POLICY,
      securityContext,
    };
  }

  /**
   * Reads a pod.
   *
   * @param name The name of the pod.
   * @returns The pod, or null when it does not exist.
   */
  private async readPod(name: string): Promise<V1Pod | null> {
    return absentAsNull(() =>
      this.kube.core.readNamespacedPod({ name, namespace: this.kube.namespace }),
    );
  }

  /**
   * Reads a network policy.
   *
   * @param name The name of the policy.
   * @returns The policy, or null when it does not exist.
   */
  private async readPolicy(name: string): Promise<V1NetworkPolicy | null> {
    return absentAsNull(() =>
      this.kube.networking.readNamespacedNetworkPolicy({ name, namespace: this.kube.namespace }),
    );
  }

  /**
   * Waits until a pod runs.
   *
   * @param name The name of the pod.
   * @throws Error at once when the pod is gone, ended, or has a reason in {@link FATAL_WAITING}, and
   *   after the start time with the reason it waits for.
   */
  private async waitUntilRunning(name: string): Promise<void> {
    const deadline = Date.now() + this.timing.startMs;
    for (;;) {
      const pod = await this.readPod(name);
      if (!pod) throw new Error(`The pod ${name} is gone`);
      const phase = pod.status?.phase;
      if (phase === 'Running') return;
      if (phase === 'Succeeded' || phase === 'Failed') {
        throw new Error(`The pod ${name} ended before it ran: ${pod.status?.reason ?? phase}`);
      }
      const waiting = pod.status?.containerStatuses?.find((c) => c.name === CONTAINER)?.state
        ?.waiting;
      const why = waiting?.reason
        ? `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`
        : (pod.status?.conditions?.find((c) => c.status === 'False' && c.message)?.message ??
          'pending');
      if (waiting?.reason && FATAL_WAITING.has(waiting.reason)) {
        throw new Error(`The pod ${name} cannot start: ${why}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The pod ${name} did not run within ${this.timing.startMs / 1000} s: ${why}`,
        );
      }
      await sleep(this.timing.pollMs);
    }
  }

  /**
   * Deletes a claim and waits until it is gone. A claim stays while a pod
   * uses it. Tolerates a claim that is gone already.
   *
   * @param name The name of the claim.
   * @throws Error when the claim is still there after the stop time.
   */
  private async deleteClaim(name: string): Promise<void> {
    const ref = { name, namespace: this.kube.namespace };
    await absentAsNull(() => this.kube.core.deleteNamespacedPersistentVolumeClaim(ref));
    const deadline = Date.now() + this.timing.stopMs;
    while (await absentAsNull(() => this.kube.core.readNamespacedPersistentVolumeClaim(ref))) {
      if (Date.now() >= deadline) throw new Error(`The claim ${name} is still in use`);
      await sleep(this.timing.pollMs);
    }
  }

  /**
   * Deletes a pod and waits until it is gone. Tolerates a pod that is gone already.
   *
   * @param name The name of the pod.
   * @param gracePeriodSeconds The time the pod gets to stop before it is killed.
   * @throws Error when the pod is still there after the stop time.
   */
  private async deletePod(name: string, gracePeriodSeconds: number): Promise<void> {
    await absentAsNull(() =>
      this.kube.core.deleteNamespacedPod({
        name,
        namespace: this.kube.namespace,
        gracePeriodSeconds,
      }),
    );
    const deadline = Date.now() + this.timing.stopMs;
    while (await this.readPod(name)) {
      if (Date.now() >= deadline) {
        // A pod on an unreachable node stays until the node comes back or is removed. A forced
        // delete could let a new pod use the volume while the old pod still runs on that node.
        throw new Error(`The pod ${name} is still terminating. Its node may be unreachable.`);
      }
      await sleep(this.timing.pollMs);
    }
  }
}

/**
 * Checks if a pod runs or starts.
 *
 * @param pod The pod.
 * @returns True for the phases Running and Pending.
 */
function isLive(pod: V1Pod): boolean {
  const phase = pod.status?.phase;
  return phase === 'Running' || phase === 'Pending';
}

/**
 * Reads the image id of the first container of a pod that has one. The pods
 * that the runtime reads have one container each.
 *
 * @param pod The pod.
 * @returns The image id, or null when no container has one.
 */
function podImageId(pod: V1Pod): string | null {
  return pod.status?.containerStatuses?.find((c) => c.imageID)?.imageID || null;
}

/**
 * Reads the start time of a pod.
 *
 * @param pod The pod.
 * @returns The start time in epoch milliseconds, or 0 when the pod has none.
 */
function startedAt(pod: V1Pod): number {
  return pod.status?.startTime ? new Date(pod.status.startTime).getTime() : 0;
}

/**
 * Finds the `sha256:` digest in an image id such as `docker.io/library/x@sha256:…`.
 *
 * @param imageId The image id.
 * @returns The digest, or the image id itself when it has no digest.
 */
function digestOf(imageId: string): string {
  return /sha256:[0-9a-f]{64}/.exec(imageId)?.[0] ?? imageId;
}

/**
 * Reads the exit code from the status that an exec ends with.
 *
 * @param status The status.
 * @returns 0 for success, the code of an `ExitCode` cause, or null when the status has none.
 */
export function exitCodeOf(status: V1Status): number | null {
  if (status.status === 'Success') return 0;
  const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
  const code = Number(cause?.message);
  return cause && Number.isInteger(code) ? code : null;
}

/**
 * Converts a size such as `4g` to a Kubernetes quantity. Kubernetes reads `m`
 * as a thousandth, so the suffix is changed to the binary unit.
 *
 * @param size A number with an optional suffix k, m or g, in any case.
 * @returns The quantity, such as `4Gi`.
 * @throws Error when the size has another form.
 */
export function quantity(size: string): string {
  const match = /^(\d+)([kmgKMG]?)$/.exec(size);
  if (!match) throw new Error(`Invalid size: ${size}`);
  const unit = { k: 'Ki', m: 'Mi', g: 'Gi', '': '' }[
    (match[2] ?? '').toLowerCase() as 'k' | 'm' | 'g' | ''
  ];
  return `${match[1]}${unit}`;
}

/**
 * Compares two policy specs. The API leaves out empty lists and absent
 * fields, so both are compared without them.
 *
 * @param a The first spec.
 * @param b The second spec.
 * @returns True when the specs say the same.
 */
export function sameSpec(
  a: V1NetworkPolicySpec | undefined,
  b: V1NetworkPolicySpec | undefined,
): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Normalizes a value for a comparison.
 *
 * @param value The value.
 * @returns The value with its keys sorted, and with no null, empty list or empty object. Undefined when
 *   nothing is left.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])] as const)
      .filter(([, v]) => v !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value ?? undefined;
}

/**
 * Runs one call of the API, and gives null when the object does not exist.
 *
 * @param call The call.
 * @returns The result of the call, or null on a 404.
 */
async function absentAsNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}

/**
 * Gives the message of an error of the API, without the headers that the client adds.
 *
 * @param err The error.
 * @returns The HTTP code with the message of the body, or the message of an error without a code.
 */
function message(err: unknown): string {
  const { code, body } = err as { code?: number; body?: unknown };
  if (code === undefined) return (err as Error).message;
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      // not JSON
    }
  }
  const text =
    (parsed as { message?: string } | undefined)?.message ?? (typeof body === 'string' ? body : '');
  return `HTTP ${code}${text ? `: ${text}` : ''}`;
}

/**
 * Runs one read for the details page, and gives null when it throws.
 *
 * @param read The read.
 * @returns The value of the read, or null.
 */
async function quietly<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.debug('could not read a runtime fact', { error: message(err) });
    return null;
  }
}

/**
 * Reads one image id for the image footer, and gives null when it throws or finds none.
 *
 * @param what The image that is read, for the log.
 * @param read The read of the image id.
 * @returns The image with the digest of the id. The build date and the size are null.
 */
async function safely(what: string, read: () => Promise<string | null>): Promise<ImageInfo | null> {
  try {
    const id = await read();
    return id ? { digest: digestOf(id), builtAt: null, sizeBytes: null } : null;
  } catch (err) {
    log.debug('could not read an image', { what, error: message(err) });
    return null;
  }
}

/**
 * Waits for a time.
 *
 * @param ms The time in milliseconds.
 * @returns A promise that resolves after the time.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
