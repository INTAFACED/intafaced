import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../../dist/outreach/archive-receiver.js', import.meta.url));
const fixtureEnvironment = (url: string, port: number) => ({
  PATH: process.env.PATH,
  OPS_ERASURE_ARCHIVE_URL: 'https://private-archive.example.test',
  OPS_ERASURE_ARCHIVE_DATABASE_URL: url,
  OPS_ERASURE_ARCHIVE_SECRET: randomBytes(40).toString('base64url'),
  OPS_ERASURE_ARCHIVE_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  OPS_ERASURE_ARCHIVE_TLS_INGRESS: 'trusted_loopback',
  OPS_ERASURE_ARCHIVE_PORT: String(port),
});
function child(environment: NodeJS.ProcessEnv) {
  const process = spawn(globalThis.process.execPath, [entry], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '',
    stdout = '';
  process.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  process.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const timeout = setTimeout(() => process.kill('SIGKILL'), 12000);
  timeout.unref();
  const done = once(process, 'exit')
    .then(([code, signal]) => ({ code, signal, stderr, stdout }))
    .finally(() => clearTimeout(timeout));
  return { process, done };
}
it('compiled configuration failure emits only a fixed code', async () => {
  const run = child({ OPS_ERASURE_ARCHIVE_URL: 'redaction-fixture-private-input' });
  const result = await run.done;
  expect(result).toEqual({ code: 1, signal: null, stderr: 'ops.crm.archive_startup_failed\n', stdout: '' });
}, 15000);
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('compiled archive receiver owned boot boundary', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'ops' });
  });
  afterAll(async () => {
    await db.drop();
  });
  it('sanitizes real SQL migration failure and terminates', async () => {
    const url = new URL(db.url);
    url.username = 'redaction_fixture_nonexistent_role';
    const run = child(fixtureEnvironment(url.href, 4122));
    const result = await run.done;
    expect(result).toEqual({ code: 1, signal: null, stderr: 'ops.crm.archive_startup_failed\n', stdout: '' });
  });
  it('sanitizes listen failure after migration and closes the SQL/app', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener missing');
    try {
      const result = await child(fixtureEnvironment(db.url, address.port)).done;
      expect(result).toEqual({ code: 1, signal: null, stderr: 'ops.crm.archive_startup_failed\n', stdout: '' });
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it('serves authenticated current after compiled boot and closes cleanly on SIGTERM', async () => {
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, '127.0.0.1', resolve));
    const address = reserved.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener missing');
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const environment = fixtureEnvironment(db.url, address.port);
    const run = child(environment);
    const url = `http://127.0.0.1:${address.port}/current`;
    try {
      let live = false;
      for (let attempt = 0; attempt < 100 && !live; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${environment.OPS_ERASURE_ARCHIVE_SECRET}`, 'content-type': 'application/json' },
            body: JSON.stringify({ nonce: '00000000-0000-4000-8000-000000000001' }),
          });
          live = response.status === 200;
        } catch {
          /* Wait for this owned process only. */
        }
        if (!live) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(live).toBe(true);
      run.process.kill('SIGTERM');
      expect(await run.done).toEqual({ code: 0, signal: null, stderr: '', stdout: '' });
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      if (run.process.exitCode === null) {
        run.process.kill('SIGTERM');
        await run.done;
      }
    }
  });
});
