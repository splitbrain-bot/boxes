import type { Config } from '../config.ts';
import { DockerRuntime } from './docker.ts';
import type { Runtime } from './runtime.ts';

/** Creates the runtime that runs the boxes of this deployment. */
export function createRuntime(cfg: Config): Runtime {
  return new DockerRuntime(cfg);
}
