import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_TEST_FIXTURE_REFUSE_CODE } from '@intafaced/config';
import { describe, expect, it } from 'vitest';

/**
 * THE SHIPPED ENTRYPOINT MUST REFUSE LOCAL-TEST STAND-INS.
 *
 * `assertNoLocalTestFixtures` is unit-tested in packages/config. That proves the
 * function; it does not prove `index.ts` calls it. This boots the real module
 * with a fixture list and no explicit dev/test APP_ENV. Refusal is a non-zero
 * exit that names the stable code, before postgres is opened.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');
const SECRET = 'p'.repeat(48);

const FIXTURE_LIST = 'ZZ:local-test-stand-in';
const FIXTURE_SOURCE = 'test-fixture-not-a-real-list';

function bootEnv(extra: Record<string, string | undefined>): Record<string, string> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SERVICE_NAME: 'svc-pay',
    HTTP_HOST: '127.0.0.1',
    LOG_LEVEL: 'fatal',
    OTEL_ENABLED: 'false',
    DATABASE_URL: 'postgres://127.0.0.1:1/pay_boot',
    DATABASE_POOL_MAX: '2',
    EDGE_PRINCIPAL_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: 'i'.repeat(48),
    PAY_CRYPTO_WEBHOOK_SECRET: SECRET,
    PAY_CARD_SANDBOX_WEBHOOK_SECRET: 'c'.repeat(48),
    PAY_MIN_CONFIRMATIONS: '6',
    PAY_WEBHOOK_TOLERANCE_SECONDS: '300',
    PAY_OPERATOR_CREDIT_RAILS: 'card-sandbox',
    PAY_CHECKOUT_SESSION_TTL_SECONDS: '900',
    PAY_LINK_DEFAULT_TTL_DAYS: '30',
    PAY_LINK_MAX_TTL_DAYS: '365',
    PAY_CHECKOUT_MAX_OPEN_SESSIONS: '25',
    INTAFACED_SANCTIONS_REGIONS: FIXTURE_LIST,
    INTAFACED_SANCTIONS_LIST_SOURCE: FIXTURE_SOURCE,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return childEnv;
}

async function boot(extra: Record<string, string | undefined>): Promise<{ exitCode: number | null; output: string }> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: join(HERE, '..'),
    env: bootEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 120_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { exitCode, output };
}

describe('svc-pay boot refuses local-test screening fixtures without an explicit test env', () => {
  it('APP_ENV unset with a fixture list refuses before listen', async () => {
    const out = await boot({ APP_ENV: undefined });
    expect(out.exitCode).not.toBe(0);
    expect(out.output).toContain(LOCAL_TEST_FIXTURE_REFUSE_CODE);
  }, 150_000);

  it('APP_ENV unset with screening fail-closed off refuses', async () => {
    const out = await boot({
      APP_ENV: undefined,
      INTAFACED_SANCTIONS_REGIONS: undefined,
      INTAFACED_SANCTIONS_LIST_SOURCE: undefined,
      INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.output).toContain(LOCAL_TEST_FIXTURE_REFUSE_CODE);
  }, 150_000);
});
