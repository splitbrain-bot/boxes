import { Duplex, PassThrough } from 'node:stream';
import * as dk from '../../orchestrator/src/docker.ts';

/** The prompt the fake shell writes. A test waits for it to know that the shell is ready. */
const PROMPT = 'agent@box:/workspace$ ';

/**
 * Creates a fake shell pty. It echoes the typed input and writes the prompt after each answer.
 *
 * @param answer Gives the output for each finished line.
 * @returns The stream of the pty.
 */
function fakeShell(answer: (line: string) => string): Duplex {
  let line = '';
  const shell = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          shell.push(`\r\n${answer(line)}\r\n${PROMPT}`);
          line = '';
          continue;
        }
        line += char;
        shell.push(char);
      }
      done();
    },
  });
  queueMicrotask(() => shell.push(PROMPT));
  return shell;
}

/** The client the orchestrator reaches the daemon through. */
type DockerClient = NonNullable<Parameters<typeof dk.setDockerForTests>[0]>;

/** A container the fake daemon has, and what the orchestrator reads off it. */
interface FakeContainer {
  /** The image it was created from, which decides whether it is current. */
  image: string;
  /** True when the container runs. */
  running: boolean;
}

/** One image of the deployment, as this daemon reports it. */
interface FakeImage {
  /** The digest the registry it was pulled from knows it by. */
  repoDigest: string;
  /** The image id. A container inspect returns this id as the image of the container. */
  id: string;
  /** The build time of the image, as an ISO timestamp. */
  builtAt: string;
  /** The image size in bytes. */
  sizeBytes: number;
}

/** The fake daemon, and the handles a test needs on it. */
export interface FakeDocker {
  /** The answer of the fake shell to a typed line. A test can replace it. */
  terminalAnswer: (line: string) => string;
  /**
   * Adds a container of the box image to the fake daemon.
   *
   * @param id The container id.
   * @param running True when the container runs.
   */
  addContainer(id: string, running: boolean): void;
  /** Removes the fake client from the orchestrator. */
  close(): void;
}

/** The box image every box container is created from. */
const BOX_IMAGE: FakeImage = {
  repoDigest: 'sha256:0011223344556677889900aabbccddeeff00112233445566778899aabbccddee',
  id: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  builtAt: '2026-08-12T22:40:00.000Z',
  // Gigabytes, like the real box image with its toolchains and browser.
  sizeBytes: 4_509_715_661,
};

/** The egress proxy's image, the second of the three the dashboard lists. */
const PROXY_IMAGE: FakeImage = {
  repoDigest: 'sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
  id: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  builtAt: '2026-08-30T09:15:00.000Z',
  sizeBytes: 188_743_680,
};

/** The container name the orchestrator reads the proxy's image off. */
const PROXY_CONTAINER = 'boxes-egress-proxy';

/** The build of the orchestrator's own image, read off the container it is in. */
const ORCHESTRATOR_IMAGE: FakeImage = {
  repoDigest: 'sha256:1a2b3c4d5e6f39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
  id: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  builtAt: '2026-08-30T09:20:00.000Z',
  sizeBytes: 419_430_400,
};

/**
 * The container this process pretends to run in, so the orchestrator can read
 * its own image as it does in a deployment. In a deployment, the orchestrator reads the real id from system files,
 * for example `/proc/self/mountinfo`. A test process cannot arrange these files.
 */
const SELF_CONTAINER = 'a'.repeat(64);

/** The container id that a test gives to the orchestrator as the id of its own container. */
export const FAKE_SELF_CONTAINER = SELF_CONTAINER;

/**
 * Creates a 404 error in the form of the daemon. The status code tells a missing object from a failure.
 *
 * @param what The kind and name of the missing object.
 * @returns The error.
 */
function notFound(what: string): Error & { statusCode: number } {
  return Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
}

/**
 * Replaces the shared Docker client of the orchestrator with a client that answers from memory.
 *
 * @param boxImage The tag of the box image. An image inspect by this tag gives the fake box image.
 * @param selfContainerId The id that the orchestrator reads as the id of its own container. Undefined makes the
 *   orchestrator read the real sources.
 * @returns The handles that a test uses to drive the fake daemon.
 */
export function installFakeDocker(boxImage: string, selfContainerId?: string): FakeDocker {
  /** Containers by id, including the ones the orchestrator creates itself. */
  const containers = new Map<string, FakeContainer>();
  // The health probe reads the proxy's image off this container.
  containers.set(PROXY_CONTAINER, { image: PROXY_IMAGE.id, running: true });
  containers.set(SELF_CONTAINER, { image: ORCHESTRATOR_IMAGE.id, running: true });

  let terminalAnswer: FakeDocker['terminalAnswer'] = (line) => `ran: ${line}`;

  const images = new Map<string, FakeImage>([
    [BOX_IMAGE.id, BOX_IMAGE],
    [PROXY_IMAGE.id, PROXY_IMAGE],
    [ORCHESTRATOR_IMAGE.id, ORCHESTRATOR_IMAGE],
  ]);

  /**
   * Finds the container with the id.
   *
   * @param id The container id.
   * @returns The container.
   * @throws Error The 404 of the daemon when the fake daemon has no such container.
   */
  const must = (id: string): FakeContainer => {
    const found = containers.get(id);
    if (!found) throw notFound(`container: ${id}`);
    return found;
  };

  /**
   * Creates one container's handle, with the calls that the orchestrator makes.
   *
   * @param id The container id.
   * @returns The handle.
   */
  const handle = (id: string): unknown => ({
    id,
    start: async () => {
      must(id).running = true;
    },
    stop: async () => {
      must(id).running = false;
    },
    remove: async () => {
      containers.delete(id);
    },
    inspect: async () => {
      const container = must(id);
      return { Id: id, Image: container.image, State: { Running: container.running } };
    },
    // A terminal asks for a pty. Every other exec gives no output, because the
    // review runs git through an injected runner.
    exec: async (opts: { Tty?: boolean }) => ({
      start: async () => {
        if (opts.Tty) return fakeShell((line) => terminalAnswer(line));
        const stream = new PassThrough();
        queueMicrotask(() => stream.end());
        return stream;
      },
      inspect: async () => ({ ExitCode: 0 }),
      resize: async () => undefined,
    }),
  });

  /**
   * Creates one network's handle. The egress proxy is always on the network.
   *
   * @returns The handle.
   */
  const network = (): unknown => ({
    inspect: async () => ({
      Containers: { proxy: { Name: PROXY_CONTAINER } },
      IPAM: { Config: [{ Subnet: '10.200.0.0/24' }] },
    }),
    connect: async () => undefined,
    remove: async () => undefined,
  });

  const client = {
    // The real modem demuxes exec streams. Getting it opens no connection.
    modem: dk.docker().modem,
    ping: async () => 'OK',
    createNetwork: async () => undefined,
    getNetwork: () => network(),
    getImage: (name: string) => ({
      inspect: async () => {
        // Either an image id read off a container, or the box image by its tag.
        const found = images.get(name) ?? (name === boxImage ? BOX_IMAGE : null);
        if (!found) throw notFound(`image: ${name}`);
        return {
          Id: found.id,
          RepoDigests: [`boxes@${found.repoDigest}`],
          Created: found.builtAt,
          Size: found.sizeBytes,
        };
      },
      remove: async () => undefined,
    }),
    createContainer: async (spec: { name: string }) => {
      // The orchestrator finds a box container by its name, so the name is the id.
      const id = spec.name;
      containers.set(id, { image: BOX_IMAGE.id, running: false });
      return handle(id);
    },
    getContainer: (id: string) => handle(id),
    listContainers: async () => [],
    listNetworks: async () => [],
    listImages: async () => [],
  };

  dk.setDockerForTests(client as unknown as DockerClient);
  dk.setSelfContainerIdForTests(selfContainerId);

  return {
    get terminalAnswer() {
      return terminalAnswer;
    },
    set terminalAnswer(fn: FakeDocker['terminalAnswer']) {
      terminalAnswer = fn;
    },
    addContainer: (id, running) => {
      containers.set(id, { image: BOX_IMAGE.id, running });
    },
    close: () => dk.setDockerForTests(null),
  };
}
