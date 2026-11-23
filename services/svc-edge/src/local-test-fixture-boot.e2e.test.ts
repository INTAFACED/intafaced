import { LOCAL_TEST_FIXTURE_REFUSE_CODE } from '@intafaced/config';
import { describe, expect, it } from 'vitest';
import { startEdge, stopEdge } from './edge-boot.testkit.js';

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

const ZZ_LIST = 'ZZ:local-test-stand-in';
// A real list: includes XK (Kosovo), which is real and not "user-assigned".
const REAL_LIST = 'KP:UN resolution ref,XK:counsel-reviewed ref';
const REAL_SOURCE = 'counsel-reviewed-2026-10';

type Outcome = { listened: boolean; exitCode: number | null; output: string };

/** Boot the real entrypoint. Resolves when it listens (then kills it) or when it exits. */
async function boot(extra: Record<string, string | undefined>): Promise<Outcome> {
  // Start from a clean env: nothing from the developer's shell or vitest config may leak in.
  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? '',
    SERVICE_NAME: 'svc-edge',
    OTEL_ENABLED: 'false',
    JWT_ACCESS_SECRET: 'j'.repeat(48),
    EDGE_PRINCIPAL_SECRET: 'e'.repeat(48),
    EDGE_RATE_LIMIT_MAX: '300',
    EDGE_RATE_LIMIT_WINDOW_MS: '60000',
    EDGE_BODY_LIMIT_BYTES: '1048576',
    EDGE_KILL_STATE_PATH: '',
    ...extra,
  };
  const started = await startEdge(childEnv);
  if (!started.listened) return { listened: false, exitCode: started.exitCode, output: started.output };
  await stopEdge(started.child);
  return { listened: true, exitCode: started.child.exitCode, output: started.output() };
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
