import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Docker from 'dockerode';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { loadConfig } from '../config.ts';
import * as dk from '../docker.ts';
import { DockerRuntime } from './docker.ts';

/** The networks of the fake daemon, as subnet by network name. */
let networks: Map<string, string>;
/** The temporary data directory of the current test. */
let dir: string;

/**
 * Makes an error shaped like the 404 of the daemon for a missing object.
 *
 * @param what The kind of the object, for the message.
 * @returns The error.
 */
function notFound(what: string): Error {
  return Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-runtime-'));
  networks = new Map();
  dk.setDockerForTests({
    listNetworks: async () =>
      [...networks].map(([name, subnet]) => ({
        Name: name,
        Labels: { [dk.LABEL]: name.slice('bn-'.length) },
        IPAM: { Config: [{ Subnet: subnet }] },
      })),
    // The delay lets a second listing run before the network exists, as when
    // two creates run at once.
    createNetwork: async (opts: { Name: string; IPAM: { Config: Array<{ Subnet: string }> } }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      networks.set(opts.Name, opts.IPAM.Config[0]!.Subnet);
    },
    getNetwork: (name: string) => ({
      inspect: async () => {
        const subnet = networks.get(name);
        if (!subnet) throw notFound('network');
        return { Containers: {}, IPAM: { Config: [{ Subnet: subnet }] } };
      },
      connect: async () => {},
    }),
    createContainer: async () => ({ id: 'created' }),
    getContainer: (name: string) => ({
      inspect: async () => {
        if (name !== 'box-a1') throw notFound('container');
        return {
          Id: 'abcdef0123456789',
          Image: 'sha256:0123456789abcdef',
          State: { Running: true },
        };
      },
    }),
  } as unknown as Docker);
});

afterEach(() => {
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Makes a runtime over the fake daemon, with a pool of four subnets.
 *
 * @returns The runtime.
 */
function dockerRuntime(): DockerRuntime {
  return new DockerRuntime(loadConfig({ DATA_DIR: dir, BOX_SUBNET_POOL: '10.9.0.0/22' }));
}

describe('the subnet of a new box network', () => {
  it('is the first one that no box network holds', async () => {
    networks.set('bn-old', '10.9.0.0/24');
    networks.set('bn-older', '10.9.2.0/24');

    await dockerRuntime().ensure({ boxId: 'new', env: {} });

    assert.equal(networks.get('bn-new'), '10.9.1.0/24');
  });

  it('differs for two boxes created at once', async () => {
    const rt = dockerRuntime();

    await Promise.all([rt.ensure({ boxId: 'one', env: {} }), rt.ensure({ boxId: 'two', env: {} })]);

    assert.notEqual(networks.get('bn-one'), networks.get('bn-two'));
  });

  it('fails the create when the pool is full', async () => {
    for (let i = 0; i < 4; i++) networks.set(`bn-b${i}`, `10.9.${i}.0/24`);

    await assert.rejects(() => dockerRuntime().ensure({ boxId: 'new', env: {} }), /No free subnet/);
  });
});

describe('the facts of the details page', () => {
  it('names the container, the network with its subnet, and the image', async () => {
    networks.set('bn-a1', '10.9.3.0/24');

    assert.deepEqual(await dockerRuntime().details('a1'), [
      ['Container', 'abcdef012345'],
      ['Network', 'bn-a1 (10.9.3.0/24)'],
      ['Image', '0123456789ab'],
    ]);
  });

  it('leaves out what the daemon does not have', async () => {
    assert.deepEqual(await dockerRuntime().details('gone'), []);
  });
});

describe('a login', () => {
  it('removes its container when the start fails', async () => {
    const removed: string[] = [];
    dk.setDockerForTests({
      createContainer: async () => ({ id: 'login-1' }),
      getContainer: (id: string) => ({
        start: async () => {
          throw new Error('no start');
        },
        remove: async () => {
          removed.push(id);
        },
      }),
    } as unknown as Docker);

    await assert.rejects(() => dockerRuntime().startLogin('claude'), /no start/);
    assert.deepEqual(removed, ['login-1']);
  });
});
