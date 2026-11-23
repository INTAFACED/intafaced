import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boot the shipped svc-edge entrypoint as a real process, for the boot e2e tests.
 *
 * The child binds port 0 and the base URL is read from Fastify's own
 * `Server listening at <url>` line, so the port is the one the kernel handed
 * the child. The test never picks a port: a port picked here and passed in
 * could be taken by another test while the child is still importing.
 *
 * Excluded from the production build (tsconfig.json), included in the test
 * typecheck.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');
const BOOT_DEADLINE_MS = 60_000;
const LISTENING = /Server listening at (http:\/\/[^\s"]+)/;

export type BootedEdge = {
  readonly child: ChildProcess;
  /** Everything the child wrote to stdout and stderr so far. */
  readonly output: () => string;
  /** The base URL once the child listens and `/health` answers; rejects if it exits first or never listens. */
  readonly listening: Promise<string>;
  /** Settles once the child has exited and its stdout and stderr are drained. */
  readonly closed: Promise<void>;
};

/**
 * Spawn the entrypoint with `env` as its whole environment. `HTTP_PORT` and
 * `LOG_LEVEL` are set here: port 0, and `info` so the listening line is written.
 */
export function startEdge(env: Readonly<Record<string, string>>): BootedEdge {
  // `--import tsx` keeps this to ONE process, so a kill cannot leave an orphan
  // holding the port. `tsx src/index.ts` would spawn a grandchild that survives
  // killing its parent on Windows.
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: { ...env, HTTP_PORT: '0', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const read = () => output;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

  const listening = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`svc-edge never listened within ${BOOT_DEADLINE_MS}ms:\n${output}`)), BOOT_DEADLINE_MS);
    // `close`, not `exit`: it fires after stdout and stderr are drained, so the error carries the whole refusal.
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`svc-edge exited with ${code} before listening:\n${output}`));
    };
    const onData = (d: Buffer) => {
      output += d.toString();
      const url = LISTENING.exec(output)?.[1];
      if (url === undefined) return;
      clearTimeout(timer);
      child.off('close', onExit);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.stdout?.on('data', (more: Buffer) => (output += more.toString()));
      child.stderr?.on('data', (more: Buffer) => (output += more.toString()));
      resolve(confirmHealth(url, read));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('close', onExit);
  });
  // A caller that only waits for exit must not see an unhandled rejection.
  listening.catch(() => undefined);

  return { child, output: read, listening, closed };
}

/** The listening line comes after `app.listen()` resolves; `/health` must answer on it. */
async function confirmHealth(base: string, output: () => string): Promise<string> {
  const res = await fetch(`${base}/health`);
  if (!res.ok) throw new Error(`svc-edge listened at ${base} but /health answered ${res.status}:\n${output()}`);
  return base;
}

/** Kill the child (if still running) and wait until it has exited and its output is drained. */
export async function stopEdge(edge: BootedEdge): Promise<void> {
  const { child } = edge;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await edge.closed;
}
