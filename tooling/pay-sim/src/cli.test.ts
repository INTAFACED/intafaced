import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

function tsxCli(): string {
  const candidates = [
    new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
    new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate.pathname;
  }
  throw new Error('tsx CLI is not installed');
}

const tsx = tsxCli();
const cli = new URL('./cli.ts', import.meta.url).pathname;

/**
 * Help and the refusal path must not inherit the runner's environment.
 * A set starter fee with APP_ENV=production refuses svc-pay boot. Help does
 * not boot, so that pair must still print help and must not open a database.
 */
function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...overrides };
}

it('prints honest help without a DB and rejects unsafe options without leaking secrets', async () => {
  const help = await exec(process.execPath, [tsx, cli, '--help'], {
    env: childEnv({ APP_ENV: 'production', PAY_MERCHANT_STARTER_FEE_BPS: '250' }),
    timeout: 15_000,
  });
  expect(help.stdout).toContain('TEST DATA');
  expect(help.stdout).toContain('6e618f75a8ffd2ef7d254f72bbecbf29c559331f');
  expect(help.stdout).toContain('W9 screening is not built on this main');
  const secret = 'NEVER-PRINT-THIS-PASSWORD';
  try {
    await exec(process.execPath, [tsx, cli, `--${secret}`], {
      env: childEnv({
        APP_ENV: 'test',
        PAY_MERCHANT_STARTER_FEE_BPS: '250',
        TEST_DATABASE_URL: `postgres://test:${secret}@remote.example/live_test`,
      }),
      timeout: 15_000,
    });
    throw new Error('unsafe CLI unexpectedly succeeded');
  } catch (e) {
    const error = e as Error & { stdout?: string; stderr?: string; code?: number };
    expect(error.code).toBe(1);
    expect(error.stderr).toContain('No pass report');
    expect(`${error.stdout}${error.stderr}`).not.toContain(secret);
  }
});
