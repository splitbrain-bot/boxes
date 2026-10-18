/**
 * The conformance suite against the Kubernetes cluster of the kubeconfig
 * context that BOXES_CONFORMANCE_CONTEXT names, in the namespace of that
 * context. Without the variable, the suite is skipped, so that it never runs
 * against the current context by accident.
 *
 * The namespace needs the egress proxy with its Service, as
 * EGRESS_PROXY_SERVICE names it, and a box image that the nodes can get
 * with BOX_IMAGE_PULL_POLICY. No orchestrator may run in the namespace,
 * because its orphan sweep removes the boxes of the suite.
 */

import { describe, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { runtimeConformance } from './conformance.ts';
import { connect, KubernetesRuntime, names } from './kubernetes.ts';

/** The port of the control channel of the egress proxy. */
const CONTROL_PORT = 3129;

/** The kubeconfig context the suite runs against, or undefined to skip the suite. */
const context = process.env.BOXES_CONFORMANCE_CONTEXT;

if (context) {
  runtimeConformance('Kubernetes', async () => {
    const cfg = loadConfig({ ...process.env, RUNTIME: 'kubernetes' });
    const kube = connect(context);

    const service = await kube.core.readNamespacedService({
      name: cfg.EGRESS_PROXY_SERVICE,
      namespace: kube.namespace,
    });
    const proxyIp = service.spec?.clusterIP;
    const labelSelector = Object.entries(service.spec?.selector ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    // A proxy pod stands in for the orchestrator, because it is on the pod
    // network and listens on the control port.
    const proxyPods = await kube.core.listNamespacedPod({
      namespace: kube.namespace,
      labelSelector,
    });
    const podIp = proxyPods.items.find((pod) => pod.status?.podIP)?.status?.podIP;
    const api = await kube.core.readNamespacedService({ name: 'kubernetes', namespace: 'default' });
    const apiIp = api.spec?.clusterIP;
    if (!proxyIp || !podIp || !apiIp) {
      throw new Error('Could not find the addresses of the proxy and of the API server');
    }

    return {
      runtime: new KubernetesRuntime(cfg, kube),
      boxUid: cfg.BOX_UID,
      unreachable: [
        { label: 'the control port of the proxy', host: proxyIp, port: CONTROL_PORT },
        { label: 'a pod of the namespace', host: podIp, port: CONTROL_PORT },
        { label: 'the API server', host: apiIp, port: 443 },
      ],
      absentPaths: [
        {
          label: 'the token of a service account',
          path: '/var/run/secrets/kubernetes.io/serviceaccount',
        },
      ],
      breakIsolation: async (boxId) => {
        await kube.networking.deleteNamespacedNetworkPolicy({
          name: names.box(boxId),
          namespace: kube.namespace,
        });
      },
    };
  });
} else {
  describe.skip('the Kubernetes runtime (set BOXES_CONFORMANCE_CONTEXT to the kubeconfig context)', () => {
    it('is not run', () => {});
  });
}
