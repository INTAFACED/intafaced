import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_TEST_FIXTURE_REFUSE_CODE } from '@intafaced/config';
import { describe, expect, it } from 'vitest';

/**
 * THE SHIPPED ENTRYPOINT, BOOTED, MUST REFUSE LOCAL-TEST STAND-INS (issue #4611).
 *
 * `assertNoLocalTestFixtures` is unit-tested in packages/config. That proves the
 * function; it does not prove `index.ts` calls it. Delete the call and every
 * config test still passes while an edge on staging/prod boots on a `ZZ` screening
 * list or with fail-closed switched off. So this boots the real module (same
 * approach as metrics.boot.e2e.test.ts) with APP_ENV and the stand-ins varied.
 *
 * Refusal = the child exits non-zero, never listens, and names the stable code.
 * "Starts" = /health answers on the real socket.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');

const ZZ_LIST = 'ZZ:local-test-stand-in';
// A real list: includes XK (Kosovo), which is real and not "user-assigned".
const REAL_LIST = 'KP:UN resolution ref,XK:counsel-reviewed ref';
const REAL_SOURCE = 'counsel-reviewed-2026-10';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Outcome = { listened: boolean; exitCode: number | null; output: string };

/** Boot the real entrypoint. Resolves when it listens (then kills it) or when it exits. */
async function boot(extra: Record<string, string | undefined>): Promise<Outcome> {
  const port = await freePort();
  // Start from a clean env: nothing from the developer's shell or vitest config may leak in.
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SERVICE_NAME: 'svc-edge',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    LOG_LEVEL: 'fatal',
    OTEL_ENABLED: 'false',
    JWT_ACCESS_SECRET: 'test-only-signing-secret-at-least-32-characters-long',
    EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
    EDGE_RATE_LIMIT_MAX: '300',
    EDGE_RATE_LIMIT_WINDOW_MS: '60000',
    EDGE_BODY_LIMIT_BYTES: '1048576',
    EDGE_KILL_STATE_PATH: '',
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) childEnv[k] = v;

  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const deadline = Date.now() + 60_000;
  let listened = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        listened = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (child.exitCode === null) child.kill();
  await exited;
  return { listened, exitCode: child.exitCode, output };
}

const REFUSING_ENVS: ReadonlyArray<readonly [string, string | undefined]> = [
  ['staging', 'staging'],
  ['prod', 'prod'],
  ['unset', undefined],
];

describe('svc-edge boot refuses local-test stand-ins outside explicit dev/test', () => {
  describe.each(REFUSING_ENVS)('APP_ENV=%s', (_label, appEnv) => {
    it('refuses to start on a ZZ screening list', async () => {
      const out = await boot({ APP_ENV: appEnv, INTAFACED_SANCTIONS_REGIONS: ZZ_LIST, INTAFACED_SANCTIONS_LIST_SOURCE: REAL_SOURCE });
      expect(out.listened).toBe(false);
      expect(out.exitCode).not.toBe(0);
      expect(out.output).toContain(LOCAL_TEST_FIXTURE_REFUSE_CODE);
    }, 90_000);

    it('refuses to start with INTAFACED_SCREENING_FAIL_CLOSED=off even on a real list', async () => {
      const out = await boot({
        APP_ENV: appEnv,
        INTAFACED_SANCTIONS_REGIONS: REAL_LIST,
        INTAFACED_SANCTIONS_LIST_SOURCE: REAL_SOURCE,
        INTAFACED_SCREENING_FAIL_CLOSED: 'off',
      });
      expect(out.listened).toBe(false);
      expect(out.exitCode).not.toBe(0);
      expect(out.output).toContain(LOCAL_TEST_FIXTURE_REFUSE_CODE);
    }, 90_000);
  });

  it('refuses to start with an EMPTY APP_ENV and a ZZ list', async () => {
    // An empty APP_ENV is rejected by the env schema or the guard; either way it must not listen.
    const out = await boot({ APP_ENV: '', INTAFACED_SANCTIONS_REGIONS: ZZ_LIST, INTAFACED_SANCTIONS_LIST_SOURCE: REAL_SOURCE });
    expect(out.listened).toBe(false);
    expect(out.exitCode).not.toBe(0);
  }, 90_000);

  it('refuses to start with an EMPTY APP_ENV and fail-closed off', async () => {
    const out = await boot({
      APP_ENV: '',
      INTAFACED_SANCTIONS_REGIONS: REAL_LIST,
      INTAFACED_SANCTIONS_LIST_SOURCE: REAL_SOURCE,
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    });
    expect(out.listened).toBe(false);
    expect(out.exitCode).not.toBe(0);
  }, 90_000);

  it.each(['dev', 'test'])(
    'starts under APP_ENV=%s with a ZZ list and fail-closed off',
    async (appEnv) => {
      const out = await boot({
        APP_ENV: appEnv,
        INTAFACED_SANCTIONS_REGIONS: ZZ_LIST,
        INTAFACED_SCREENING_FAIL_CLOSED: 'off',
      });
      expect(out.output).not.toContain(LOCAL_TEST_FIXTURE_REFUSE_CODE);
      expect(out.listened).toBe(true);
    },
    90_000,
  );

  it.each(['dev', 'test', 'staging', 'prod'])(
    'starts under APP_ENV=%s with a real list containing XK',
    async (appEnv) => {
      const out = await boot({
        APP_ENV: appEnv,
        INTAFACED_SANCTIONS_REGIONS: REAL_LIST,
        INTAFACED_SANCTIONS_LIST_SOURCE: REAL_SOURCE,
      });
      expect(out.output).not.toContain(LOCAL_TEST_FIXTURE_REFUSE_CODE);
      expect(out.listened).toBe(true);
    },
    90_000,
  );
});
