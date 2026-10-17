import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const tsx = new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname;
const cli = new URL('./cli.ts', import.meta.url).pathname;

it('prints honest help without a DB and rejects unsafe options without leaking secrets', async () => {
  const help = await exec(process.execPath, [tsx, cli, '--help'], { env: { ...process.env, APP_ENV: 'production' }, timeout: 5000 });
  expect(help.stdout).toContain('TEST DATA');
  expect(help.stdout).toContain('6e618f75a8ffd2ef7d254f72bbecbf29c559331f');
  expect(help.stdout).toContain('W9 screening is not built on this main');
  const secret = 'NEVER-PRINT-THIS-PASSWORD';
  try {
    await exec(process.execPath, [tsx, cli, `--${secret}`], {
      env: { ...process.env, APP_ENV: 'test', TEST_DATABASE_URL: `postgres://test:${secret}@remote.example/live_test` },
      timeout: 5000,
    });
    throw new Error('unsafe CLI unexpectedly succeeded');
  } catch (e) {
    const error = e as Error & { stdout?: string; stderr?: string; code?: number };
    expect(error.code).toBe(1);
    expect(error.stderr).toContain('No pass report');
    expect(`${error.stdout}${error.stderr}`).not.toContain(secret);
  }
});
