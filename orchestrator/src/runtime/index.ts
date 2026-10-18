import type { Config } from '../config.ts';
import { DockerRuntime } from './docker.ts';
import { KubernetesRuntime } from './kubernetes.ts';
import type { Runtime } from './runtime.ts';

/**
 * Creates the runtime that RUNTIME names.
 *
 * @param cfg The configuration of the deployment.
 * @returns The Kubernetes runtime for `kubernetes`, else the Docker runtime.
 */
export function createRuntime(cfg: Config): Runtime {
  return cfg.RUNTIME === 'kubernetes' ? new KubernetesRuntime(cfg) : new DockerRuntime(cfg);
}
