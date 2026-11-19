/**
 * Unit card — academy video URL TTL is owner-published; blank refuses
 *
 * 1. Promise: ACADEMY_VIDEO_URL_TTL_SECONDS from host `.env` reaches the
 *    container. Unset / blank does not become 300. Grant refuses
 *    academy.video_url_ttl_unset. Never invent seconds.
 * 2. Break: compose `:-300` or env.ts `.default(300)` looks published
 *    when the operator never set a signed-GET lifetime.
 * 3. Done bar: docker-compose.apps.yml svc-academy has
 *    ACADEMY_VIDEO_URL_TTL_SECONDS: ${ACADEMY_VIDEO_URL_TTL_SECONDS:-}
 *    env.ts preprocess blank → undefined, union undefined | 1..3600,
 *    no `.default(300)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-academy block only), env.ts,
 *    video/storage.ts
 * 6. RED: pin fails if TTL default is 300, compose bakes 300, clamp
 *    invents 1/3600, or sibling academy keys are restamped
 * 7. Collision: jwt / stream / paper / tournament / ambassador / S3
 *    compose pins — this pin does not restamp JWT_*, LIVEKIT_*,
 *    ACADEMY_STREAM_PROVIDER, ACADEMY_MAX_ROOM_CAPACITY,
 *    ACADEMY_PAPER_TRADING_ENABLED, ACADEMY_TOURNAMENT_ENABLED,
 *    TRADE_URL, or S3 endpoint/bucket/keys
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);

function academyServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-academy');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const LINE = /^\s+ACADEMY_VIDEO_URL_TTL_SECONDS:\s*\$\{ACADEMY_VIDEO_URL_TTL_SECONDS:-\}\s*$/gm;
const JWT_TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const STREAM = /^\s+ACADEMY_STREAM_PROVIDER:\s*\$\{ACADEMY_STREAM_PROVIDER:-none\}\s*$/gm;
const PAPER = /^\s+ACADEMY_PAPER_TRADING_ENABLED:\s*\$\{ACADEMY_PAPER_TRADING_ENABLED:-true\}\s*$/gm;
const TOURNAMENT = /^\s+ACADEMY_TOURNAMENT_ENABLED:\s*\$\{ACADEMY_TOURNAMENT_ENABLED:-true\}\s*$/gm;
const S3_ENDPOINT = /^\s+ACADEMY_VIDEO_S3_ENDPOINT:\s*\$\{ACADEMY_VIDEO_S3_ENDPOINT:-\}\s*$/gm;

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
};

/**
 * Load production env.ts the way the process does.
 *
 * `vi.resetModules` + explicit clears are load-bearing: env.ts calls
 * `loadEnv(process.env)` at import. A forked Zod slice would stay green if
 * production still defaulted 300.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('ACADEMY_VIDEO_URL_TTL_SECONDS', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('../env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose ACADEMY_VIDEO_URL_TTL_SECONDS for svc-academy', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-academy/src/env.ts'), 'utf8');
  const storageTs = readFileSync(join(HERE, 'storage.ts'), 'utf8');
  const block = academyServiceBlock(compose);

  it('env.ts refuses blank TTL — no 300 default; S3 still empty-default off', () => {
    expect(envTs).not.toMatch(/ACADEMY_VIDEO_URL_TTL_SECONDS:[\s\S]{0,400}\.default\(300\)/);
    expect(envTs).toMatch(
      /ACADEMY_VIDEO_URL_TTL_SECONDS:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.union\(\[z\.undefined\(\), z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(3600\)\]\),\s*\)/,
    );
    expect(envTs).toMatch(/ACADEMY_VIDEO_S3_ENDPOINT:\s*z\.string\(\)\.optional\(\)\.default\(''\)/);
  });

  it('compose svc-academy block is the unique home; TTL is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-academy/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toMatch(/ACADEMY_VIDEO_URL_TTL_SECONDS:\s*\$\{ACADEMY_VIDEO_URL_TTL_SECONDS:-300\}/);
    expect(countAssignments(block, 'ACADEMY_VIDEO_URL_TTL_SECONDS')).toBe(1);

    const hits = compose.match(/^\s+ACADEMY_VIDEO_URL_TTL_SECONDS:/gm) ?? [];
    expect(hits, 'ACADEMY_VIDEO_URL_TTL_SECONDS must appear once (svc-academy only)').toHaveLength(1);
  });

  it('does not restamp jwt/stream/paper/tournament/S3 or clamp-invent seconds', () => {
    expect(block.match(JWT_TTL)).toHaveLength(1);
    expect(block.match(STREAM)).toHaveLength(1);
    expect(block.match(PAPER)).toHaveLength(1);
    expect(block.match(TOURNAMENT)).toHaveLength(1);
    expect(block.match(S3_ENDPOINT)).toHaveLength(1);
    expect(block).toMatch(/LIVEKIT_TOKEN_TTL_SECONDS:\s*\$\{LIVEKIT_TOKEN_TTL_SECONDS:-3600\}/);
    expect(storageTs).toMatch(/academy\.video_url_ttl_unset/);
    expect(storageTs).not.toMatch(/Math\.max\(1,\s*Math\.min\(3600/);
  });
});

describe('svc-academy ACADEMY_VIDEO_URL_TTL_SECONDS refuse-closed', () => {
  it('env.ts source keeps the refuse-closed shape production loadEnv parses', () => {
    const envTs = readFileSync(join(HERE, '..', 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/ACADEMY_VIDEO_URL_TTL_SECONDS:[\s\S]{0,400}\.default\(300\)/);
  });

  it('unset ACADEMY_VIDEO_URL_TTL_SECONDS is unpublished (no invent 300)', async () => {
    const parsed = await loadWith({ ACADEMY_VIDEO_URL_TTL_SECONDS: undefined });
    expect(parsed.ACADEMY_VIDEO_URL_TTL_SECONDS).toBeUndefined();
  });

  it('blank ACADEMY_VIDEO_URL_TTL_SECONDS is unpublished', async () => {
    const parsed = await loadWith({ ACADEMY_VIDEO_URL_TTL_SECONDS: '' });
    expect(parsed.ACADEMY_VIDEO_URL_TTL_SECONDS).toBeUndefined();
  });

  it('whitespace ACADEMY_VIDEO_URL_TTL_SECONDS is unpublished', async () => {
    const parsed = await loadWith({ ACADEMY_VIDEO_URL_TTL_SECONDS: '   ' });
    expect(parsed.ACADEMY_VIDEO_URL_TTL_SECONDS).toBeUndefined();
  });

  it('zero ACADEMY_VIDEO_URL_TTL_SECONDS refuses (no invent 1s)', async () => {
    await expect(loadWith({ ACADEMY_VIDEO_URL_TTL_SECONDS: '0' })).rejects.toThrow(/ACADEMY_VIDEO_URL_TTL_SECONDS/);
  });

  it('explicit owner pin is accepted (not invented)', async () => {
    const parsed = await loadWith({ ACADEMY_VIDEO_URL_TTL_SECONDS: '120' });
    expect(parsed.ACADEMY_VIDEO_URL_TTL_SECONDS).toBe(120);
  });
});
