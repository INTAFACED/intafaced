import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { describe, expect, it, vi } from 'vitest';
import { LocalTestTapeError, localTestTapeRetimeEnabled } from './local-test-tape.js';
import { LOCAL_TEST_TAPE_RETIME_PATH, registerLocalTestTapeRoutes } from './local-test-tape-routes.js';

const SECRET = 'tape-retime-route-secret-32-chars';
const here = dirname(fileURLToPath(import.meta.url));

/** [label, APP_ENV, allowed?]. Unset and empty count as NOT dev. */
const ENV_MATRIX: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
  ['dev', 'dev', true],
  ['test', 'test', true],
  ['staging', 'staging', false],
  ['prod', 'prod', false],
  ['production', 'production', false],
  ['unset', undefined, false],
  ['empty', '', false],
];

describe.each(ENV_MATRIX)('TRADE_LOCAL_TEST_TAPE_RETIME under APP_ENV=%s', (_label, appEnv, allowed) => {
  const env = (flag: string | undefined) => ({
    ...(appEnv === undefined ? {} : { APP_ENV: appEnv }),
    ...(flag === undefined ? {} : { TRADE_LOCAL_TEST_TAPE_RETIME: flag }),
  });

  it('is off when unset, blank or off', () => {
    for (const flag of [undefined, '', '  ', 'off', 'OFF']) expect(localTestTapeRetimeEnabled(env(flag))).toBe(false);
  });

  it(allowed ? 'is on when on' : 'throws when on', () => {
    if (allowed) expect(localTestTapeRetimeEnabled(env('on'))).toBe(true);
    else expect(() => localTestTapeRetimeEnabled(env('on'))).toThrow(LocalTestTapeError);
  });

  it('throws on any other value', () => {
    for (const flag of ['1', 'true', 'yes', 'onn']) {
      expect(() => localTestTapeRetimeEnabled(env(flag))).toThrow(/must be unset, off or on/);
    }
  });
});

describe('tape retime route', () => {
  const body = JSON.stringify({ marketId: '22222222-2222-4222-8222-222222222222', startMs: 1, stepMs: 60_000 });
  const app = () => {
    const sql = { begin: vi.fn() };
    const instance = Fastify();
    registerLocalTestTapeRoutes(instance, { internalSecret: SECRET, sql: sql as never });
    return { instance, sql };
  };

  it('refuses no auth and a tampered body before touching the database', async () => {
    const { instance, sql } = app();
    const none = await instance.inject({
      method: 'POST',
      url: LOCAL_TEST_TAPE_RETIME_PATH,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(none.statusCode).toBe(401);
    const tampered = await instance.inject({
      method: 'POST',
      url: LOCAL_TEST_TAPE_RETIME_PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('local-test-market', SECRET, body) },
      payload: body.replace('60000', '120000'),
    });
    expect(tampered.statusCode).toBe(401);
    expect(sql.begin).not.toHaveBeenCalled();
  });

  it('refuses an invalid body', async () => {
    const { instance, sql } = app();
    const bad = JSON.stringify({ marketId: 'not-a-uuid', startMs: 1, stepMs: 60_000, extra: true });
    const response = await instance.inject({
      method: 'POST',
      url: LOCAL_TEST_TAPE_RETIME_PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('local-test-market', SECRET, bad) },
      payload: bad,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('trade.local_test_tape_invalid');
    expect(sql.begin).not.toHaveBeenCalled();
  });
});

describe('index.ts wiring', () => {
  const source = readFileSync(join(here, '..', 'index.ts'), 'utf8');

  it('checks the flag before opening the database, and registers the route only when it is on', () => {
    const check = source.indexOf('const localTestTapeRetime = localTestTapeRetimeEnabled(process.env);');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(source.indexOf('postgres(env.DATABASE_URL'));
    expect(source.match(/registerLocalTestTapeRoutes\(/g)).toHaveLength(1);
    expect(source).toMatch(/if \(localTestTapeRetime\) \{\n\s+registerLocalTestTapeRoutes\(/);
  });
});
