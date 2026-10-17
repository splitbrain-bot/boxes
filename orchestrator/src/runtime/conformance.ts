import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { HOME_DIR, NIX_DIR, type ProcessStream, type Runtime, WORKSPACE_DIR } from './runtime.ts';

/**
 * The conformance suite of the Runtime interface.
 *
 * It checks what a real runtime does when the interface is called, on real
 * infrastructure and with the real box image. A check is part of it when it
 * calls only the interface and can fail because of the runtime. Each runtime
 * has an entry file that calls runtimeConformance with its own subject.
 */

/** One address that a box must not be able to connect to. */
export interface Target {
  /** What the address is, for the name of the check. */
  label: string;
  /** The host name or the IP address. */
  host: string;
  /** The TCP port. */
  port: number;
}

/** One path that must not exist inside a box. */
export interface AbsentPath {
  /** What the path is, for the name of the check. */
  label: string;
  /** The absolute path in the box. */
  path: string;
}

/** A runtime under test, and the facts about it that only its entry file knows. */
export interface ConformanceSubject {
  /** The runtime, not yet prepared. */
  runtime: Runtime;
  /** The uid that the processes of a box run as. */
  boxUid: number;
  /**
   * The addresses that a box must not reach, other than the internet and
   * another box, which the suite checks itself.
   */
  unreachable: Target[];
  /** The paths that must not exist in a box, for example a socket of the runtime. */
  absentPaths: AbsentPath[];
  /** Breaks the isolation of a running box from outside, as an operator could. */
  breakIsolation(boxId: string): Promise<void>;
}

/** An address on the internet, which a box must reach only through the proxy. */
const INTERNET: Target = { label: 'the internet without the proxy', host: '1.1.1.1', port: 443 };

/** The port that the listener in the second box binds to. */
const SIBLING_PORT = 8080;

/** How long one connection attempt from a box may take, in seconds. */
const CONNECT_SECONDS = 5;

/** The command that connects to an address from inside a box, and exits 0 when it can. */
function connectCommand(target: Target): string[] {
  return [
    'timeout',
    `${CONNECT_SECONDS}s`,
    'bash',
    '-c',
    'exec 3<>"/dev/tcp/$0/$1"',
    target.host,
    String(target.port),
  ];
}

/** A box id of the suite. The prefix makes a left-over box easy to find. */
function boxId(): string {
  return `conf${randomBytes(3).toString('hex')}`;
}

/** Everything a stream produces until it ends, as a buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Resolves when the output of a process contains a text. Fails after a time. */
function waitForOutput(proc: ProcessStream, text: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(
      () => reject(new Error(`no ${JSON.stringify(text)} in the output: ${JSON.stringify(seen)}`)),
      timeoutMs,
    );
    proc.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      if (seen.includes(text)) {
        clearTimeout(timer);
        resolve(seen);
      }
    });
  });
}

/** Resolves with the value of a promise, or fails after a time. */
async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers the conformance checks for one runtime.
 *
 * The checks share one box and run in order, because each start of a box
 * costs seconds. A second box serves the isolation checks. Both are removed
 * at the end, also when a check fails.
 *
 * @param name The name of the runtime, for the names of the checks.
 * @param setup Creates the subject. It is called once, before the first check.
 */
export function runtimeConformance(name: string, setup: () => Promise<ConformanceSubject>): void {
  describe(`the ${name} runtime`, () => {
    const box = boxId();
    const sibling = boxId();
    const env = { BOXES_CONFORMANCE: box };
    let subject: ConformanceSubject;
    let rt: Runtime;

    /** Runs a command in the box and fails the check when its exit code is not 0. */
    async function sh(script: string, id = box): Promise<string> {
      const out = await rt.run(id, ['sh', '-c', script]);
      assert.equal(out.code, 0, `${script}: ${out.stderr}`);
      return out.stdout;
    }

    /** Whether the box can open a TCP connection to an address. */
    async function canConnect(target: Target, id = box): Promise<boolean> {
      const out = await rt.run(id, connectCommand(target), {
        timeoutMs: (CONNECT_SECONDS + 5) * 1000,
      });
      return out.code === 0;
    }

    beforeAll(async () => {
      subject = await setup();
      rt = subject.runtime;
      await rt.prepare();
      await rt.ensureImage();
    });

    afterAll(async () => {
      if (!rt) return;
      for (const id of [box, sibling]) {
        await rt.remove(id).catch(() => {});
        await rt.removeStorage(id).catch(() => {});
      }
    });

    describe('a new box', () => {
      it('has all of its storage', async () => {
        await rt.createStorage(box);
        assert.deepEqual(await rt.missingStorage(box), []);
      });

      it('is stopped before its first start', async () => {
        await rt.ensure({ boxId: box, env });
        assert.equal(await rt.state(box), 'stopped');
      });

      it('runs after a start', async () => {
        await rt.start({ boxId: box, env });
        assert.equal(await rt.state(box), 'running');
      });

      it('has the environment of its spec', async () => {
        assert.equal(await sh('printf %s "$BOXES_CONFORMANCE"'), box);
      });

      it('has its init as pid 1, holding the box open', async () => {
        // The entrypoint replaces itself with the sleep a moment after the start.
        let processes = '';
        for (let i = 0; i < 20; i++) {
          processes = await sh('ps -eo ppid=,args=');
          if (/^\s*1\s+sleep infinity$/m.test(processes)) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.fail(`no sleep infinity under pid 1 in:\n${processes}`);
      });

      it('names the image it runs', async () => {
        assert.ok(await rt.imageOf(box));
      });
    });

    describe('ensure', () => {
      it('leaves a running box as it is', async () => {
        // /tmp lives only as long as the container.
        await sh('touch /tmp/conformance');
        await rt.ensure({ boxId: box, env });
        assert.equal(await rt.state(box), 'running');
        await sh('test -e /tmp/conformance');
      });

      it('repairs the isolation of a running box', async () => {
        assert.equal(await rt.isolated(box), true);
        await subject.breakIsolation(box);
        assert.equal(await rt.isolated(box), false);
        await rt.ensure({ boxId: box, env });
        assert.equal(await rt.isolated(box), true);
      });
    });

    describe('the storage', () => {
      for (const dir of [WORKSPACE_DIR, HOME_DIR, NIX_DIR]) {
        it(`lets the box user write in ${dir}, and the files belong to that user`, async () => {
          const owner = await sh(`touch ${dir}/.conformance && stat -c %u ${dir}/.conformance`);
          assert.equal(owner.trim(), String(subject.boxUid));
        });
      }

      it('keeps the files across a stop and a start', async () => {
        await rt.stop(box);
        assert.equal(await rt.state(box), 'stopped');
        await rt.ensure({ boxId: box, env });
        await rt.start({ boxId: box, env });
        await sh(
          `test -e ${WORKSPACE_DIR}/.conformance -a -e ${HOME_DIR}/.conformance -a -e ${NIX_DIR}/.conformance`,
        );
      });

      it('keeps the files when the box is removed and made again', async () => {
        await rt.remove(box);
        assert.equal(await rt.state(box), 'stopped');
        await rt.ensure({ boxId: box, env });
        await rt.start({ boxId: box, env });
        await sh(
          `test -e ${WORKSPACE_DIR}/.conformance -a -e ${HOME_DIR}/.conformance -a -e ${NIX_DIR}/.conformance`,
        );
      });
    });

    describe('run', () => {
      it('gives stdout, stderr and the exit code apart', async () => {
        const out = await rt.run(box, ['sh', '-c', 'echo out; echo err >&2; exit 3']);
        assert.deepEqual(out, { stdout: 'out\n', stderr: 'err\n', code: 3 });
      });

      it('gives 126 or 127 for a command the box does not have', async () => {
        const out = await rt.run(box, ['boxes-conformance-missing']);
        assert.ok(out.code === 126 || out.code === 127, `exit code ${out.code}`);
      });

      it('keeps no more output than maxOutput', async () => {
        const out = await rt.run(box, ['sh', '-c', 'head -c 100000 /dev/zero | tr "\\0" x'], {
          maxOutput: 1000,
        });
        assert.equal(out.code, 0);
        assert.equal(out.stdout, 'x'.repeat(1000));
      });

      it('ends a command at its timeout', async () => {
        const started = Date.now();
        const out = await rt.run(box, ['sleep', '30'], { timeoutMs: 1000 });
        assert.notEqual(out.code, 0);
        assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
      });

      it('applies the working directory and the variables, as the box user', async () => {
        const out = await rt.run(box, ['sh', '-c', 'pwd; echo "$CONFORMANCE_VAR"; id -u'], {
          workingDir: HOME_DIR,
          env: { CONFORMANCE_VAR: 'set' },
        });
        assert.equal(out.stdout, `${HOME_DIR}\nset\n${subject.boxUid}\n`);
      });
    });

    describe('spawn', () => {
      it('passes stdin through, and ends the process when stdin ends', async () => {
        const proc = await rt.spawn(box, ['cat']);
        const output = collect(proc.stdout);
        proc.stdin.end('hello');
        assert.equal((await output).toString('utf8'), 'hello');
        assert.equal(await within(proc.exited, 10_000, 'the exit'), 0);
      });

      it('carries 1 MiB both ways without a change', async () => {
        const data = randomBytes(1024 * 1024);
        const proc = await rt.spawn(box, ['cat']);
        const output = collect(proc.stdout);
        proc.stdin.end(data);
        assert.ok((await within(output, 30_000, 'the output')).equals(data));
        await within(proc.exited, 10_000, 'the exit');
      });

      it('gives stderr apart, and the exit code', async () => {
        const proc = await rt.spawn(box, ['sh', '-c', 'echo err >&2; exit 7']);
        const stderr = collect(proc.stderr);
        proc.stdin.end();
        assert.equal(await within(proc.exited, 10_000, 'the exit'), 7);
        assert.equal((await stderr).toString('utf8'), 'err\n');
      });

      it('gives 126 or 127 for a command the box does not have', async () => {
        const proc = await rt.spawn(box, ['boxes-conformance-missing']);
        proc.stdin.end();
        const code = await within(proc.exited, 10_000, 'the exit');
        assert.ok(code === 126 || code === 127, `exit code ${code}`);
      });

      it('gives a terminal of the size asked for, and resizes it', async () => {
        const proc = await rt.spawn(box, ['sh', '-c', 'stty size; read line; stty size'], {
          tty: { cols: 100, rows: 30 },
        });
        const stderr = collect(proc.stderr);
        await waitForOutput(proc, '30 100');
        await proc.resize(120, 40);
        const resized = waitForOutput(proc, '40 120');
        proc.stdin.write('\r');
        await resized;
        await within(proc.exited, 10_000, 'the exit');
        assert.equal((await stderr).length, 0);
      });

      it('ends the stream at a kill', async () => {
        const proc = await rt.spawn(box, ['sleep', '300']);
        proc.kill();
        await within(proc.exited, 10_000, 'the end of the stream');
      });
    });

    describe('the isolation', () => {
      beforeAll(async () => {
        await rt.createStorage(sibling);
        await rt.ensure({ boxId: sibling, env: {} });
        await rt.start({ boxId: sibling, env: {} });
      });

      it('lets a box reach the front door of the egress proxy', async () => {
        const url = new URL(rt.proxyUrl());
        assert.equal(
          await canConnect({ label: 'proxy', host: url.hostname, port: Number(url.port) }),
          true,
        );
      });

      it(`keeps a box from ${INTERNET.label}`, async () => {
        assert.equal(await canConnect(INTERNET), false);
      });

      it('keeps a box from another box', async () => {
        const address = (await sh('hostname -i', sibling)).trim().split(/\s+/)[0]!;
        const target = { label: 'the other box', host: address, port: SIBLING_PORT };
        const listener = await rt.spawn(sibling, [
          'node',
          '-e',
          `require('net').createServer((s) => s.end()).listen(${SIBLING_PORT}, () => console.log('listening'))`,
        ]);
        try {
          await waitForOutput(listener, 'listening');
          // The listener answers in its own box, so a failure below is the isolation.
          assert.equal(await canConnect(target, sibling), true);
          assert.equal(await canConnect(target), false);
        } finally {
          listener.kill();
        }
      });

      it('keeps a box from each address of the runtime', async () => {
        for (const target of subject.unreachable) {
          assert.equal(
            await canConnect(target),
            false,
            `${target.label} (${target.host}:${target.port})`,
          );
        }
      });

      it('gives a box none of the paths of the runtime', async () => {
        for (const absent of subject.absentPaths) {
          const out = await rt.run(box, ['test', '-e', absent.path]);
          assert.notEqual(out.code, 0, `${absent.label} (${absent.path})`);
        }
      });
    });

    describe('a login', () => {
      const credentialId = `conformance-${box}`;

      it('runs as the box user in its home, with a direct route to the internet', async () => {
        const login = await rt.startLogin(credentialId);
        try {
          const proc = await login.spawn(['sh', '-c', 'id -u; pwd']);
          const output = collect(proc.stdout);
          proc.stdin.end();
          assert.equal((await output).toString('utf8'), `${subject.boxUid}\n${HOME_DIR}\n`);
          const connect = await login.spawn(connectCommand(INTERNET));
          connect.stdin.end();
          assert.equal(await within(connect.exited, 15_000, 'the connection'), 0);
        } finally {
          await login.remove();
        }
        const left = (await rt.inventory()).filter(
          (obj) => obj.kind === 'login' && obj.credentialId === credentialId,
        );
        assert.deepEqual(left, []);
        // A second remove is allowed.
        await login.remove();
      });
    });

    describe('the facts', () => {
      it('reports the runtime as healthy', async () => {
        await rt.health();
      });

      it('gives the details of a box as label and value', async () => {
        const details = await rt.details(box);
        assert.ok(details.length > 0);
        for (const [label, value] of details) {
          assert.equal(typeof label, 'string');
          assert.equal(typeof value, 'string');
        }
      });

      it('names the image of a new box', async () => {
        assert.ok((await rt.deploymentImages()).box);
      });
    });

    describe('the inventory', () => {
      it('lists the objects of a box in the order they are removed in', async () => {
        const kinds = (await rt.inventory())
          .filter((obj) => obj.kind !== 'login' && obj.boxId === box)
          .map((obj) => obj.kind);
        assert.deepEqual(kinds, ['box', 'isolation', 'storage']);
      });

      it('removes each object, and then the box has no storage', async () => {
        const objects = (await rt.inventory()).filter(
          (obj) => obj.kind !== 'login' && obj.boxId === box,
        );
        for (const obj of objects) await rt.removeObject(obj);
        const left = (await rt.inventory()).filter(
          (obj) => obj.kind !== 'login' && obj.boxId === box,
        );
        assert.deepEqual(left, []);
        assert.equal(await rt.state(box), 'stopped');
        assert.notDeepEqual(await rt.missingStorage(box), []);
      });
    });
  });
}
