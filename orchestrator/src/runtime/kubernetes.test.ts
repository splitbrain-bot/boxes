import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type {
  CoreV1Api,
  NetworkingV1Api,
  V1NetworkPolicy,
  V1PersistentVolumeClaim,
  V1Pod,
  V1Status,
} from '@kubernetes/client-node';
import { beforeEach, describe, it } from 'vitest';
import { loadConfig } from '../config.ts';
import {
  exitCodeOf,
  type KubeClients,
  KubernetesRuntime,
  LOGIN_POLICY,
  quantity,
  sameSpec,
} from './kubernetes.ts';

/** One exec that the fake cluster saw. */
interface ExecCall {
  /** The pod the exec runs in. */
  pod: string;
  /** The command vector. */
  command: string[];
  /** Where the output goes. */
  stdout: Writable;
  /** Where the errors go, or null with a terminal. */
  stderr: Writable | null;
  /** Where the input comes from, or null without one. */
  stdin: Readable | null;
  /** Whether the exec has a terminal. */
  tty: boolean;
}

/** The pods of the fake cluster, by name. */
let pods: Map<string, V1Pod>;
/** The network policies of the fake cluster, by name. */
let policies: Map<string, V1NetworkPolicy>;
/** The claims of the fake cluster, by name. */
let claims: Map<string, V1PersistentVolumeClaim>;
/** The execs the fake cluster saw, in order. */
let execs: ExecCall[];
/** What each pod read does to the pod before it is returned, for a pod that changes. */
let onRead: (pod: V1Pod) => void;
/** How an exec answers: output, and the status it ends with. */
let answer: (call: ExecCall) => { stdout?: string; stderr?: string; status: V1Status };

/** An error shaped like an answer of the API. */
function apiError(code: number): Error {
  return Object.assign(new Error(`HTTP ${code}`), { code, body: { message: `status ${code}` } });
}

/** A read from a map that answers 404 for a missing object. */
function read<T>(map: Map<string, T>, name: string): T {
  const value = map.get(name);
  if (!value) throw apiError(404);
  return structuredClone(value);
}

/** The objects of a map whose label selector, `key` or `key=value`, matches. */
function select<T extends { metadata?: { labels?: Record<string, string> } }>(
  map: Map<string, T>,
  selector: string,
): { items: T[] } {
  const [key, value] = selector.split('=');
  return {
    items: [...map.values()].filter((obj) => {
      const label = obj.metadata?.labels?.[key!];
      return label !== undefined && (value === undefined || label === value);
    }),
  };
}

/** A fake cluster with the proxy Service and nothing else. */
function fakeClients(): KubeClients {
  const core = {
    readNamespacedService: async ({ name }: { name: string }) => {
      if (name !== 'boxes-egress-proxy') throw apiError(404);
      return {
        spec: {
          clusterIP: '10.96.0.20',
          selector: { app: 'egress-proxy' },
          ports: [{ port: 3128, targetPort: 'proxy' }, { port: 3129 }],
        },
      };
    },
    createNamespacedPersistentVolumeClaim: async ({ body }: { body: V1PersistentVolumeClaim }) => {
      if (claims.has(body.metadata!.name!)) throw apiError(409);
      claims.set(body.metadata!.name!, body);
    },
    readNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => read(claims, name),
    deleteNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => {
      read(claims, name);
      claims.delete(name);
    },
    listNamespacedPersistentVolumeClaim: async ({ labelSelector }: { labelSelector: string }) =>
      select(claims, labelSelector),
    createNamespacedPod: async ({ body }: { body: V1Pod }) => {
      if (pods.has(body.metadata!.name!)) throw apiError(409);
      pods.set(body.metadata!.name!, { ...body, status: { phase: 'Pending' } });
    },
    readNamespacedPod: async ({ name }: { name: string }) => {
      const pod = pods.get(name);
      if (pod) onRead(pod);
      return read(pods, name);
    },
    deleteNamespacedPod: async ({ name }: { name: string }) => {
      read(pods, name);
      pods.delete(name);
    },
    listNamespacedPod: async ({ labelSelector }: { labelSelector: string }) =>
      select(pods, labelSelector),
  };
  const networking = {
    createNamespacedNetworkPolicy: async ({ body }: { body: V1NetworkPolicy }) => {
      if (policies.has(body.metadata!.name!)) throw apiError(409);
      policies.set(body.metadata!.name!, structuredClone(body));
    },
    replaceNamespacedNetworkPolicy: async ({
      name,
      body,
    }: {
      name: string;
      body: V1NetworkPolicy;
    }) => {
      read(policies, name);
      policies.set(name, structuredClone(body));
    },
    readNamespacedNetworkPolicy: async ({ name }: { name: string }) => read(policies, name),
    deleteNamespacedNetworkPolicy: async ({ name }: { name: string }) => {
      read(policies, name);
      policies.delete(name);
    },
    listNamespacedNetworkPolicy: async ({ labelSelector }: { labelSelector: string }) =>
      select(policies, labelSelector),
  };
  const exec = {
    exec: async (
      _namespace: string,
      pod: string,
      _container: string,
      command: string | string[],
      stdout: Writable | null,
      stderr: Writable | null,
      stdin: Readable | null,
      tty: boolean,
      onStatus?: (status: V1Status) => void,
    ) => {
      const call = { pod, command: [command].flat(), stdout: stdout!, stderr, stdin, tty };
      execs.push(call);
      const socket = Object.assign(new EventEmitter(), { close: () => socket.emit('close') });
      setImmediate(() => {
        const out = answer(call);
        if (out.stdout) call.stdout.write(out.stdout);
        if (out.stderr) call.stderr?.write(out.stderr);
        onStatus?.(out.status);
        socket.emit('close');
      });
      return socket;
    },
  };
  return {
    namespace: 'boxes',
    core: core as unknown as CoreV1Api,
    networking: networking as unknown as NetworkingV1Api,
    exec: exec as unknown as KubeClients['exec'],
  };
}

/** A prepared runtime over the fake cluster, with short waits. */
async function kubernetesRuntime(env: Record<string, string> = {}): Promise<KubernetesRuntime> {
  const rt = new KubernetesRuntime(
    loadConfig({ RUNTIME: 'kubernetes', BOX_IMAGE: 'box:test', ...env }),
    fakeClients(),
    { pollMs: 1, startMs: 50, stopMs: 50 },
  );
  await rt.prepare();
  return rt;
}

beforeEach(() => {
  pods = new Map();
  policies = new Map();
  claims = new Map();
  execs = [];
  onRead = (pod) => {
    if (pod.status?.phase === 'Pending') pod.status = { phase: 'Running' };
  };
  answer = () => ({ stdout: 'out', stderr: 'err', status: { status: 'Success' } });
});

describe('the proxy', () => {
  it('is reached at the cluster IP of its Service', async () => {
    assert.equal((await kubernetesRuntime()).proxyUrl(), 'http://10.96.0.20:3128');
  });

  it('fails the boot when its Service is missing', async () => {
    const rt = new KubernetesRuntime(loadConfig({ EGRESS_PROXY_SERVICE: 'gone' }), fakeClients());
    await assert.rejects(
      () => rt.prepare(),
      /Could not read the Service gone in the namespace boxes/,
    );
  });
});

describe('the isolation of a box', () => {
  it('lets the box reach only the proxy pods on the port behind the proxy port', async () => {
    await (await kubernetesRuntime()).ensure({ boxId: 'a1', env: {} });

    assert.deepEqual(policies.get('box-a1')!.spec, {
      podSelector: { matchLabels: { 'boxes.box': 'a1' } },
      policyTypes: ['Ingress', 'Egress'],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { app: 'egress-proxy' } } }],
          ports: [{ protocol: 'TCP', port: 'proxy' }],
        },
      ],
    });
  });

  it('is repaired when its policy is gone or changed', async () => {
    const rt = await kubernetesRuntime();
    await rt.ensure({ boxId: 'a1', env: {} });
    assert.equal(await rt.isolated('a1'), true);

    policies.get('box-a1')!.spec!.egress = [{}];
    assert.equal(await rt.isolated('a1'), false);
    await rt.ensure({ boxId: 'a1', env: {} });
    assert.equal(await rt.isolated('a1'), true);

    policies.delete('box-a1');
    assert.equal(await rt.isolated('a1'), false);
    await rt.ensure({ boxId: 'a1', env: {} });
    assert.equal(await rt.isolated('a1'), true);
  });
});

describe('the pod of a box', () => {
  it('is hardened, mounts the claim three times, and has the environment and the limits', async () => {
    const rt = await kubernetesRuntime({ BOX_MEM_LIMIT: '4g', BOX_MEM_REQUEST: '512m' });
    await rt.start({ boxId: 'a1', env: { HTTP_PROXY: 'http://10.96.0.20:3128' } });

    const spec = pods.get('box-a1')!.spec!;
    const [container] = spec.containers;
    assert.equal(spec.restartPolicy, 'Never');
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.enableServiceLinks, false);
    assert.equal(spec.shareProcessNamespace, undefined);
    assert.deepEqual(spec.securityContext, {
      runAsUser: 1020,
      runAsGroup: 1020,
      runAsNonRoot: true,
      fsGroup: 1020,
      seccompProfile: { type: 'RuntimeDefault' },
      fsGroupChangePolicy: 'OnRootMismatch',
    });
    assert.deepEqual(container!.securityContext, {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      privileged: false,
      capabilities: { drop: ['ALL'] },
    });
    assert.equal(container!.image, 'box:test');
    assert.equal(container!.imagePullPolicy, 'Always');
    assert.deepEqual(container!.env, [{ name: 'HTTP_PROXY', value: 'http://10.96.0.20:3128' }]);
    assert.deepEqual(
      container!
        .volumeMounts!.filter((m) => m.name === 'storage')
        .map((m) => [m.subPath, m.mountPath]),
      [
        ['workspace', '/workspace'],
        ['home', '/home/agent'],
        ['nix', '/nix'],
      ],
    );
    assert.deepEqual(spec.volumes![0], {
      name: 'storage',
      persistentVolumeClaim: { claimName: 'box-a1' },
    });
    assert.deepEqual(container!.resources, {
      limits: { memory: '4Gi', cpu: '2' },
      requests: { memory: '512Mi', cpu: '0.5' },
    });
  });
});

describe('the start of a box', () => {
  it('waits until the pod runs', async () => {
    const rt = await kubernetesRuntime();
    await rt.start({ boxId: 'a1', env: {} });
    assert.equal(pods.get('box-a1')!.status!.phase, 'Running');
    assert.equal(await rt.state('a1'), 'running');
  });

  it('keeps a pod that runs', async () => {
    const rt = await kubernetesRuntime();
    pods.set('box-a1', { metadata: { name: 'box-a1', uid: 'old' }, status: { phase: 'Running' } });
    await rt.start({ boxId: 'a1', env: {} });
    assert.equal(pods.get('box-a1')!.metadata!.uid, 'old');
  });

  it('replaces a pod that ended', async () => {
    const rt = await kubernetesRuntime();
    pods.set('box-a1', { metadata: { name: 'box-a1', uid: 'old' }, status: { phase: 'Failed' } });
    assert.equal(await rt.state('a1'), 'stopped');
    await rt.start({ boxId: 'a1', env: {} });
    assert.equal(pods.get('box-a1')!.metadata!.uid, undefined);
    assert.equal(await rt.state('a1'), 'running');
  });

  it('fails at once when the image cannot be pulled, and deletes the pod', async () => {
    const rt = await kubernetesRuntime();
    onRead = (pod) => {
      pod.status = {
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'box',
            image: 'box:test',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: 'ImagePullBackOff', message: 'not found' } },
          },
        ],
      };
    };
    await assert.rejects(
      () => rt.start({ boxId: 'a1', env: {} }),
      /The pod box-a1 cannot start: ImagePullBackOff: not found/,
    );
    assert.equal(pods.has('box-a1'), false);
  });

  it('fails after the start time with the reason the pod waits for', async () => {
    const rt = await kubernetesRuntime();
    onRead = (pod) => {
      pod.status = {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', message: '0/1 nodes are available' }],
      };
    };
    await assert.rejects(
      () => rt.start({ boxId: 'a1', env: {} }),
      /did not run within 0.05 s: 0\/1 nodes are available/,
    );
  });
});

describe('the stop of a box', () => {
  it('deletes the pod and keeps the claim', async () => {
    const rt = await kubernetesRuntime();
    await rt.createStorage('a1');
    await rt.start({ boxId: 'a1', env: {} });
    await rt.stop('a1');
    assert.equal(await rt.state('a1'), 'stopped');
    assert.deepEqual(await rt.missingStorage('a1'), []);
  });

  it('fails when the pod does not go', async () => {
    const rt = await kubernetesRuntime();
    pods.set('box-a1', { metadata: { name: 'box-a1' }, status: { phase: 'Running' } });
    const fake = fakeClients();
    const stuck = new KubernetesRuntime(
      loadConfig({}),
      {
        ...fake,
        core: { ...fake.core, deleteNamespacedPod: async () => ({}) } as unknown as CoreV1Api,
      },
      { pollMs: 1, startMs: 50, stopMs: 20 },
    );
    await assert.rejects(() => stuck.stop('a1'), /still terminating/);
    assert.equal(await rt.state('a1'), 'running');
  });
});

describe('the storage of a box', () => {
  it('is one claim of BOX_STORAGE_SIZE', async () => {
    const rt = await kubernetesRuntime({ BOX_STORAGE_SIZE: '50g' });
    await rt.createStorage('a1');
    assert.deepEqual(claims.get('box-a1')!.spec, {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '50Gi' } },
    });
    await rt.removeStorage('a1');
    assert.deepEqual(await rt.missingStorage('a1'), ['its volume claim (box-a1)']);
  });

  it('fails the removal when the claim does not go', async () => {
    claims.set('box-a1', { metadata: { name: 'box-a1' } });
    const fake = fakeClients();
    const rt = new KubernetesRuntime(
      loadConfig({}),
      {
        ...fake,
        core: {
          ...fake.core,
          deleteNamespacedPersistentVolumeClaim: async () => ({}),
        } as unknown as CoreV1Api,
      },
      { pollMs: 1, startMs: 50, stopMs: 20 },
    );
    await assert.rejects(() => rt.removeStorage('a1'), /The claim box-a1 is still in use/);
  });
});

describe('the inventory', () => {
  it('lists the pod, the policy and the claim of each box in this order, and the logins', async () => {
    const rt = await kubernetesRuntime();
    await rt.createStorage('a1');
    await rt.ensure({ boxId: 'a1', env: {} });
    await rt.start({ boxId: 'a1', env: {} });
    pods.set('login-1', {
      metadata: {
        name: 'login-1',
        labels: { 'boxes.login': 'claude' },
        creationTimestamp: new Date(5000),
      },
    });

    assert.deepEqual(await rt.inventory(), [
      { kind: 'box', boxId: 'a1', ref: 'box-a1', running: true },
      { kind: 'isolation', boxId: 'a1', ref: 'box-a1' },
      { kind: 'storage', boxId: 'a1', ref: 'box-a1' },
      { kind: 'login', credentialId: 'claude', ref: 'login-1', createdAt: 5000 },
    ]);
  });
});

describe('a command in a box', () => {
  it('runs under env with the directory, the variables and the timeout, and gives its output', async () => {
    const rt = await kubernetesRuntime();
    answer = () => ({
      stdout: 'out',
      stderr: 'err',
      status: { status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '3' }] } },
    });

    const out = await rt.run('a1', ['git', 'status'], {
      workingDir: '/workspace/repo',
      env: { GIT_PAGER: 'cat' },
      timeoutMs: 2000,
    });

    assert.deepEqual(out, { stdout: 'out', stderr: 'err', code: 3 });
    assert.deepEqual(execs[0]!.command, [
      'env',
      '-C',
      '/workspace/repo',
      'GIT_PAGER=cat',
      'timeout',
      '--kill-after=5s',
      '2s',
      'git',
      'status',
    ]);
    assert.equal(execs[0]!.pod, 'box-a1');
    assert.equal(execs[0]!.stdin, null);
  });

  it('runs in the workspace when spawned, with stdin', async () => {
    const rt = await kubernetesRuntime();
    const proc = await rt.spawn('a1', ['cat']);
    assert.equal(await proc.exited, 0);
    assert.deepEqual(execs[0]!.command, ['env', '-C', '/workspace', 'cat']);
    assert.equal(execs[0]!.stdin, proc.stdin);
  });

  it('gets a terminal of its size before the command runs, and one output stream', async () => {
    const rt = await kubernetesRuntime();
    const proc = await rt.spawn('a1', ['bash'], { tty: { cols: 100, rows: 30 } });
    await proc.exited;
    assert.deepEqual(execs[0]!.command.slice(3), [
      'sh',
      '-c',
      'stty cols "$1" rows "$2" && shift 2 && exec "$@"',
      'sh',
      '100',
      '30',
      'bash',
    ]);
    assert.equal(execs[0]!.tty, true);
    assert.equal(execs[0]!.stderr, null);
    assert.deepEqual([(proc.stdout as unknown as { columns: number }).columns], [100]);
  });

  it('gives no exit code when the stream ends without a status', async () => {
    const rt = await kubernetesRuntime();
    answer = () => ({ status: {} });
    const proc = await rt.spawn('a1', ['sleep', '300']);
    assert.equal(await proc.exited, null);
  });
});

describe('a login', () => {
  it('runs in its own pod in its home, under the login policy', async () => {
    const rt = await kubernetesRuntime();
    const login = await rt.startLogin('claude');

    const [name, pod] = [...pods.entries()][0]!;
    assert.match(name, /^login-[0-9a-f]{8}$/);
    assert.deepEqual(pod.metadata!.labels, { 'boxes.login': 'claude' });
    assert.equal(pod.spec!.containers[0]!.workingDir, '/home/agent');
    assert.ok(policies.has(LOGIN_POLICY));

    const proc = await login.spawn(['claude', 'setup-token']);
    await proc.exited;
    assert.deepEqual(execs[0]!.command, ['env', '-C', '/home/agent', 'claude', 'setup-token']);

    await login.remove();
    await login.remove();
    assert.equal(pods.size, 0);
  });
});

describe('the helpers', () => {
  it('read the exit code of an exec', () => {
    assert.equal(exitCodeOf({ status: 'Success' }), 0);
    assert.equal(
      exitCodeOf({
        status: 'Failure',
        details: { causes: [{ reason: 'ExitCode', message: '127' }] },
      }),
      127,
    );
    assert.equal(exitCodeOf({ status: 'Failure', message: 'internal error' }), null);
  });

  it('turn a size into a binary quantity', () => {
    assert.equal(quantity('4g'), '4Gi');
    assert.equal(quantity('512M'), '512Mi');
    assert.equal(quantity('1024'), '1024');
  });

  it('compare policy specs without the empty lists the API leaves out', () => {
    assert.equal(
      sameSpec(
        { podSelector: { matchLabels: { a: 'b' } }, ingress: [], policyTypes: ['Ingress'] },
        { policyTypes: ['Ingress'], podSelector: { matchLabels: { a: 'b' } } },
      ),
      true,
    );
    assert.equal(
      sameSpec(
        { podSelector: {}, policyTypes: ['Ingress'] },
        { podSelector: {}, policyTypes: ['Egress'] },
      ),
      false,
    );
  });
});
