import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boots the shipped `index.ts` as a real child process, for the tests that need the real module-scope wiring.
 *
 * The child binds port 0 and the OS picks a port that is this process's alone; its origin is read back from
 * Fastify's own "Server listening at" line. No port number is ever chosen here and handed over: a number freed by a
 * probe can be taken by another test process before the child binds it, and then the edge exits with EADDRINUSE or
 * another process's server answers /health for ours.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');

/** The origin in Fastify's own line once its socket is bound, or null before then. */
export function listeningOrigin(output: string): string | null {
  return /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? null;
}

export type EdgeStart =
  | { readonly listened: true; readonly child: ChildProcess; readonly base: string; readonly output: () => string }
  | { readonly listened: false; readonly exitCode: number | null; readonly output: string };

export type EdgeStartOptions = {
  /** Extra `--import` modules loaded before the entrypoint. */
  readonly imports?: readonly string[];
  readonly timeoutMs?: number;
};

/**
 * Starts the edge with `env`, on loopback, on a port the OS picks, logging at info so the listening line is printed.
 * Resolves `listened: true` once that line is printed and /health answers on it, or `listened: false` when the
 * process exits first.
 */
export async function startEdge(env: Record<string, string | undefined>, opts: EdgeStartOptions = {}): Promise<EdgeStart> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  childEnv.HTTP_HOST = '127.0.0.1';
  childEnv.HTTP_PORT = '0';
  childEnv.LOG_LEVEL = 'info';

  const args = [...(opts.imports ?? []).flatMap((m) => ['--import', m]), ENTRYPOINT];
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: join(HERE, '..'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const bound = new Promise<string | null>((resolve) => {
    let found = false;
    const onData = (d: Buffer) => {
      output += d.toString();
      // Read the log only until the line is found: a busy edge logs every request at info.
      const origin = found ? null : listeningOrigin(output);
      if (origin) {
        found = true;
        resolve(origin);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void exited.then(() => resolve(listeningOrigin(output)));
  });

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<'timeout'>((resolve) => deadline.addEventListener('abort', () => resolve('timeout'), { once: true }));
  const origin = await Promise.race([bound, timedOut]);

  if (origin === 'timeout') {
    child.kill();
    await exited;
    throw new Error(`svc-edge printed no listening line within ${timeoutMs} ms:\n${output}`);
  }
  if (origin === null || child.exitCode !== null) {
    await exited;
    return { listened: false, exitCode: child.exitCode, output };
  }
  const health = await fetch(`${origin}/health`).catch((err: unknown) => err);
  if (!(health instanceof Response) || !health.ok) {
    child.kill();
    await exited;
    throw new Error(
      `svc-edge listened at ${origin} but /health did not answer ok (${String(health instanceof Response ? health.status : health)}):\n${output}`,
    );
  }
  return { listened: true, child, base: origin, output: () => output };
}

/** `startEdge`, for a test that needs the edge up: throws when it exits before listening. */
export async function bootEdge(
  env: Record<string, string | undefined>,
  opts: EdgeStartOptions = {},
): Promise<{ child: ChildProcess; base: string; output: () => string }> {
  const started = await startEdge(env, opts);
  if (!started.listened) throw new Error(`svc-edge exited with ${started.exitCode} before listening:\n${started.output}`);
  return started;
}

/** Stops a child started here and waits until it has exited, so its port is free before the next file. */
export async function stopEdge(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await exited;
}
