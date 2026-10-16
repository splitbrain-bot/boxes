import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import * as dk from '../docker.ts';
import { setBoxOwner } from '../workspaces.ts';
import { runtimeConformance } from './conformance.ts';
import { DockerRuntime } from './docker.ts';

/**
 * The conformance suite against the Docker daemon of this host.
 *
 * It needs the box image that BOX_IMAGE names and a running egress proxy
 * container, as EGRESS_PROXY_CONTAINER names it. No orchestrator may run on
 * the same daemon, because its orphan sweep removes the boxes of the suite.
 * It must run as root, so that the new box directories can be given to
 * BOX_UID.
 */

/** The port of the control channel of the egress proxy. */
const CONTROL_PORT = 3129;

runtimeConformance('Docker', async () => {
  const cfg = loadConfig({
    ...process.env,
    DATA_DIR: mkdtempSync(join(tmpdir(), 'boxes-conformance-')),
  });
  setBoxOwner(cfg.BOX_UID, cfg.BOX_GID);

  // The address of the proxy on its own network, where the orchestrator also is.
  const proxy = await dk.docker().getContainer(cfg.EGRESS_PROXY_CONTAINER).inspect();
  const ownNetwork = Object.entries(proxy.NetworkSettings.Networks).find(
    ([name]) => !name.startsWith(dk.names.network('')),
  );
  const ownAddress = ownNetwork?.[1].IPAddress;
  if (!ownAddress) throw new Error(`${cfg.EGRESS_PROXY_CONTAINER} has no network of its own`);

  return {
    runtime: new DockerRuntime(cfg),
    boxUid: cfg.BOX_UID,
    unreachable: [
      { label: 'the control port of the proxy', host: cfg.EGRESS_PROXY_ALIAS, port: CONTROL_PORT },
      { label: 'the network of the orchestrator', host: ownAddress, port: CONTROL_PORT },
    ],
    absentPaths: [{ label: 'the socket of the Docker daemon', path: '/var/run/docker.sock' }],
    breakIsolation: async (boxId) => {
      await dk
        .docker()
        .getNetwork(dk.names.network(boxId))
        .disconnect({ Container: cfg.EGRESS_PROXY_CONTAINER, Force: true });
    },
  };
});
