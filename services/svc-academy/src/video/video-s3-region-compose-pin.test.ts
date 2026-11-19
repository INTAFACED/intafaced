/**
 * Unit card — academy video S3 region is owner-published; blank refuses
 *
 * 1. Promise: ACADEMY_VIDEO_S3_REGION from host `.env` reaches the
 *    container. Unset / blank does not become us-east-1. Grant refuses
 *    academy.video_s3_region_unset when storage is otherwise configured.
 *    Never invent a region.
 * 2. Break: compose `:-us-east-1` or env.ts `.default('us-east-1')` looks
 *    published when the operator never set a signing region.
 * 3. Done bar: docker-compose.apps.yml svc-academy has
 *    ACADEMY_VIDEO_S3_REGION: ${ACADEMY_VIDEO_S3_REGION:-}
 *    env.ts `.default('')`, no `.default('us-east-1')`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-academy block only), env.ts,
 *    video/storage.ts
 * 6. RED: pin fails if region default is us-east-1, compose bakes
 *    us-east-1, signGetObjectUrl falls back, or sibling academy keys are
 *    restamped
 * 7. Collision: jwt / stream / paper / tournament / ambassador / TTL
 *    compose pins — this pin does not restamp JWT_*, LIVEKIT_*,
 *    ACADEMY_STREAM_PROVIDER, ACADEMY_MAX_ROOM_CAPACITY,
 *    ACADEMY_PAPER_TRADING_ENABLED, ACADEMY_TOURNAMENT_ENABLED,
 *    TRADE_URL, ACADEMY_VIDEO_URL_TTL_SECONDS, or S3 endpoint/bucket/keys
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

const LINE = /^\s+ACADEMY_VIDEO_S3_REGION:\s*\$\{ACADEMY_VIDEO_S3_REGION:-\}\s*$/gm;
const JWT_TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const STREAM = /^\s+ACADEMY_STREAM_PROVIDER:\s*\$\{ACADEMY_STREAM_PROVIDER:-none\}\s*$/gm;
const PAPER = /^\s+ACADEMY_PAPER_TRADING_ENABLED:\s*\$\{ACADEMY_PAPER_TRADING_ENABLED:-true\}\s*$/gm;
const TOURNAMENT = /^\s+ACADEMY_TOURNAMENT_ENABLED:\s*\$\{ACADEMY_TOURNAMENT_ENABLED:-true\}\s*$/gm;
const S3_ENDPOINT = /^\s+ACADEMY_VIDEO_S3_ENDPOINT:\s*\$\{ACADEMY_VIDEO_S3_ENDPOINT:-\}\s*$/gm;
const VIDEO_TTL = /^\s+ACADEMY_VIDEO_URL_TTL_SECONDS:\s*\$\{ACADEMY_VIDEO_URL_TTL_SECONDS:-\}\s*$/gm;

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
 * production still defaulted us-east-1.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('ACADEMY_VIDEO_S3_REGION', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('../env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose ACADEMY_VIDEO_S3_REGION for svc-academy', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-academy/src/env.ts'), 'utf8');
  const storageTs = readFileSync(join(HERE, 'storage.ts'), 'utf8');
  const block = academyServiceBlock(compose);

  it('env.ts refuses blank region — no us-east-1 default; S3 still empty-default off', () => {
    expect(envTs).not.toMatch(/ACADEMY_VIDEO_S3_REGION:[\s\S]{0,400}\.default\('us-east-1'\)/);
    expect(envTs).toMatch(/ACADEMY_VIDEO_S3_REGION:\s*z\.string\(\)\.optional\(\)\.default\(''\)/);
    expect(envTs).toMatch(/ACADEMY_VIDEO_S3_ENDPOINT:\s*z\.string\(\)\.optional\(\)\.default\(''\)/);
  });

  it('compose svc-academy block is the unique home; region is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-academy/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toMatch(/ACADEMY_VIDEO_S3_REGION:\s*\$\{ACADEMY_VIDEO_S3_REGION:-us-east-1\}/);
    expect(countAssignments(block, 'ACADEMY_VIDEO_S3_REGION')).toBe(1);

    const hits = compose.match(/^\s+ACADEMY_VIDEO_S3_REGION:/gm) ?? [];
    expect(hits, 'ACADEMY_VIDEO_S3_REGION must appear once (svc-academy only)').toHaveLength(1);
  });

  it('does not restamp jwt/stream/paper/tournament/TTL/S3 or invent us-east-1', () => {
    expect(block.match(JWT_TTL)).toHaveLength(1);
    expect(block.match(STREAM)).toHaveLength(1);
    expect(block.match(PAPER)).toHaveLength(1);
    expect(block.match(TOURNAMENT)).toHaveLength(1);
    expect(block.match(S3_ENDPOINT)).toHaveLength(1);
    expect(block.match(VIDEO_TTL)).toHaveLength(1);
    expect(block).toMatch(/LIVEKIT_TOKEN_TTL_SECONDS:\s*\$\{LIVEKIT_TOKEN_TTL_SECONDS:-3600\}/);
    expect(storageTs).toMatch(/academy\.video_s3_region_unset/);
    expect(storageTs).not.toMatch(/region\.trim\(\)\s*\|\|\s*'us-east-1'/);
  });
});

describe('svc-academy ACADEMY_VIDEO_S3_REGION refuse-closed', () => {
  it('env.ts source keeps the refuse-closed shape production loadEnv parses', () => {
    const envTs = readFileSync(join(HERE, '..', 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/ACADEMY_VIDEO_S3_REGION:[\s\S]{0,400}\.default\('us-east-1'\)/);
  });

  it('unset ACADEMY_VIDEO_S3_REGION is unpublished (no invent us-east-1)', async () => {
    const parsed = await loadWith({ ACADEMY_VIDEO_S3_REGION: undefined });
    expect(parsed.ACADEMY_VIDEO_S3_REGION).toBe('');
  });

  it('blank ACADEMY_VIDEO_S3_REGION is unpublished', async () => {
    const parsed = await loadWith({ ACADEMY_VIDEO_S3_REGION: '' });
    expect(parsed.ACADEMY_VIDEO_S3_REGION).toBe('');
  });

  it('explicit owner pin is accepted (not invented)', async () => {
    const parsed = await loadWith({ ACADEMY_VIDEO_S3_REGION: 'us-east-1' });
    expect(parsed.ACADEMY_VIDEO_S3_REGION).toBe('us-east-1');
  });
});
