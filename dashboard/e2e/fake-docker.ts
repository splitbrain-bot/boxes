import { Duplex, PassThrough } from 'node:stream';
import * as dk from '../../orchestrator/src/docker.ts';

/**
 * A Docker daemon that is not there, answering everything the orchestrator
 * asks of one.
 *
 * The suite drives the real orchestrator, which creates networks, creates and
 * starts containers, inspects images and runs commands in boxes. None of that
 * can happen in a test, and all of it is a method call on the shared Docker
 * client — so the client is what is replaced, the same way the orchestrator's
 * own tests replace it.
 *
 * Nothing here models Docker beyond what the routes read back: whether a
 * container runs, what image it was made from, and — for a terminal — a shell
 * that echoes and answers.
 */

/** The prompt the fake shell draws, which is how a test knows it is there. */
const PROMPT = 'agent@box:/workspace$ ';

/**
 * A pty that behaves enough like a shell to drive a terminal against.
 *
 * It echoes what is typed, the way a real one does, and answers a finished
 * line with `answer`. That is the whole contract the browser end has: bytes
 * in, bytes out, and a size it can be told.
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
  running: boolean;
}

/** One image of the deployment, as this daemon reports it. */
interface FakeImage {
  /** The digest the registry it was pulled from knows it by. */
  repoDigest: string;
  /** The image's own id, which is what a container inspect points at. */
  id: string;
  builtAt: string;
  sizeBytes: number;
}

/** The fake daemon, and the handles a test needs on it. */
export interface FakeDocker {
  /** What the fake shell answers a typed line with. Replaced by a test. */
  terminalAnswer: (line: string) => string;
  /** Puts a container the orchestrator will ask about into the daemon. */
  addContainer(id: string, running: boolean): void;
  /** Takes the fake client back out again. */
  close(): void;
}

/** The box image every box container is created from. */
const BOX_IMAGE: FakeImage = {
  repoDigest: 'sha256:0011223344556677889900aabbccddeeff00112233445566778899aabbccddee',
  id: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  builtAt: '2026-08-12T22:40:00.000Z',
  // Gigabytes, because the box image is: a language toolchain apiece and
  // a browser. Which is the reason the dashboard says so at all.
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
 * The container this process stands in, so the orchestrator's own image can be
 * read the way it is in a deployment. The real answer comes from files under
 * `/proc` that a test process cannot arrange.
 */
const SELF_CONTAINER = 'a'.repeat(64);

/** The container id a test process stands in, for the orchestrator's own image. */
export const FAKE_SELF_CONTAINER = SELF_CONTAINER;

/** A 404 as the daemon spells one, which is how absence is told from trouble. */
function notFound(what: string): Error & { statusCode: number } {
  return Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
}

/**
 * Installs a Docker client that answers from memory, and returns the handles
 * a test drives it with.
 *
 * Container ids are derived from the box label every object Boxes creates
 * carries, so a container can be addressed by the box it belongs to,
 * which is what the review's git runner needs.
 */
export function installFakeDocker(boxImage: string, selfContainerId?: string): FakeDocker {
  /** Containers by id, including the ones the orchestrator creates itself. */
  const containers = new Map<string, FakeContainer>();
  // The proxy, which the health probe reads the deployment's proxy image off.
  containers.set(PROXY_CONTAINER, { image: PROXY_IMAGE.id, running: true });
  containers.set(SELF_CONTAINER, { image: ORCHESTRATOR_IMAGE.id, running: true });

  let terminalAnswer: FakeDocker['terminalAnswer'] = (line) => `ran: ${line}`;

  const images = new Map<string, FakeImage>([
    [BOX_IMAGE.id, BOX_IMAGE],
    [PROXY_IMAGE.id, PROXY_IMAGE],
    [ORCHESTRATOR_IMAGE.id, ORCHESTRATOR_IMAGE],
  ]);

  /** The container behind an id, or the daemon's own 404. */
  const must = (id: string): FakeContainer => {
    const found = containers.get(id);
    if (!found) throw notFound(`container: ${id}`);
    return found;
  };

  /** One container's handle, with only the calls the orchestrator makes. */
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
    // A helper container runs a script and exits; the orchestrator waits for
    // it and reads its logs only when it failed.
    wait: async () => ({ StatusCode: 0 }),
    logs: async () => Buffer.from(''),
    inspect: async () => {
      const container = must(id);
      return {
        Image: container.image,
        State: { Running: container.running },
        // Both binds of a current box container. The orchestrator
        // recreates one that is missing the agent configuration mount.
        Mounts: [{ Destination: dk.AGENT_CONFIG_DIR }, { Destination: dk.WORKSPACE_DIR }],
      };
    },
    // A terminal asks for a pty; every other exec the orchestrator runs by
    // itself is a probe that produces nothing here, and review runs git
    // through its own injected runner.
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

  /** One network's handle. The egress proxy is always on it. */
  const network = (): unknown => ({
    inspect: async () => ({ Containers: { proxy: { Name: PROXY_CONTAINER } } }),
    connect: async () => undefined,
    remove: async () => undefined,
  });

  const client = {
    // Demuxing a Docker stream is a pure function of the modem, so the real
    // one is used rather than imitated. Asking for it makes no connection.
    modem: dk.docker().modem,
    ping: async () => 'OK',
    createNetwork: async () => undefined,
    getNetwork: () => network(),
    getVolume: () => ({ remove: async () => undefined }),
    getImage: (name: string) => ({
      inspect: async () => {
        // Either an id read off a container, or the configured box image
        // by the tag that names it.
        const found = images.get(name) ?? (name === boxImage ? BOX_IMAGE : null);
        if (!found) throw notFound(`image: ${name}`);
        return {
          Id: found.id,
          RepoDigests: [`boxes@${found.repoDigest}`],
          Created: found.builtAt,
          Size: found.sizeBytes,
          // The uid the box image was built on, which the orchestrator
          // compares against BOX_UID and warns about a drift in.
          Config: { User: String(process.getuid?.() ?? 0) },
        };
      },
      remove: async () => undefined,
    }),
    createContainer: async (spec: { name?: string; Labels?: Record<string, string> }) => {
      // Named after the box it belongs to, so the review's git runner can
      // find the workspace a container id stands for.
      const box = spec.Labels?.[dk.LABEL] ?? '';
      const id = spec.name ?? `helper-${box}-${containers.size}`;
      containers.set(id, { image: BOX_IMAGE.id, running: false });
      return handle(id);
    },
    getContainer: (id: string) => handle(id),
    listContainers: async () => [],
    listNetworks: async () => [],
    listVolumes: async () => ({ Volumes: [] }),
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
