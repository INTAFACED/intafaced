/**
 * Unit card — academy max room capacity is owner-published; blank refuses
 *
 * 1. Promise: ACADEMY_MAX_ROOM_CAPACITY from host `.env` reaches the
 *    container. Unset / blank does not become 5000. createRoom refuses
 *    academy.room_capacity_unset. Never invent a ceiling.
 * 2. Break: compose `:-5000` or env.ts `.default(5_000)` looks published
 *    when the operator never set a lobby ceiling.
 * 3. Done bar: docker-compose.apps.yml svc-academy has
 *    ACADEMY_MAX_ROOM_CAPACITY: ${ACADEMY_MAX_ROOM_CAPACITY:-}
 *    env.ts preprocess blank → undefined, union undefined | 1..100_000,
 *    no `.default(5_000)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-academy block only), env.ts,
 *    access/max-room-capacity.ts, academy-service.ts createRoom
 * 6. RED: pin fails if capacity default is 5000, compose bakes 5000, clamp
 *    invents 1/100_000, or sibling academy keys are restamped
 * 7. Collision: jwt / stream / paper / tournament / ambassador / video /
 *    LiveKit compose pins — this pin does not restamp JWT_*, LIVEKIT_*,
 *    ACADEMY_STREAM_PROVIDER, ACADEMY_VIDEO_URL_TTL_SECONDS,
 *    ACADEMY_PAPER_TRADING_ENABLED, ACADEMY_TOURNAMENT_ENABLED,
 *    TRADE_URL, or S3 endpoint/bucket/keys
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublishedMaxRoomCapacity } from './max-room-capacity.js';
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

const LINE = /^\s+ACADEMY_MAX_ROOM_CAPACITY:\s*\$\{ACADEMY_MAX_ROOM_CAPACITY:-\}\s*$/gm;
const JWT_TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const STREAM = /^\s+ACADEMY_STREAM_PROVIDER:\s*\$\{ACADEMY_STREAM_PROVIDER:-none\}\s*$/gm;
const PAPER = /^\s+ACADEMY_PAPER_TRADING_ENABLED:\s*\$\{ACADEMY_PAPER_TRADING_ENABLED:-true\}\s*$/gm;
const TOURNAMENT = /^\s+ACADEMY_TOURNAMENT_ENABLED:\s*\$\{ACADEMY_TOURNAMENT_ENABLED:-true\}\s*$/gm;
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
 * production still defaulted 5000.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('ACADEMY_MAX_ROOM_CAPACITY', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('../env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose ACADEMY_MAX_ROOM_CAPACITY for svc-academy', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-academy/src/env.ts'), 'utf8');
  const helperTs = readFileSync(join(HERE, 'max-room-capacity.ts'), 'utf8');
  const block = academyServiceBlock(compose);

  it('env.ts refuses blank capacity — no 5000 default; LiveKit TTL still 3600', () => {
    expect(envTs).not.toMatch(/ACADEMY_MAX_ROOM_CAPACITY:[\s\S]{0,400}\.default\(5_000\)/);
    expect(envTs).not.toMatch(/ACADEMY_MAX_ROOM_CAPACITY:[\s\S]{0,400}\.default\(5000\)/);
    expect(envTs).toMatch(
      /ACADEMY_MAX_ROOM_CAPACITY:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.union\(\[z\.undefined\(\), z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100_000\)\]\),\s*\)/,
    );
    expect(envTs).toMatch(/LIVEKIT_TOKEN_TTL_SECONDS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(60\)\.max\(86_400\)\.default\(3600\)/);
  });

  it('compose svc-academy block is the unique home; capacity is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-academy/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toMatch(/ACADEMY_MAX_ROOM_CAPACITY:\s*\$\{ACADEMY_MAX_ROOM_CAPACITY:-5000\}/);
    expect(countAssignments(block, 'ACADEMY_MAX_ROOM_CAPACITY')).toBe(1);

    const hits = compose.match(/^\s+ACADEMY_MAX_ROOM_CAPACITY:/gm) ?? [];
    expect(hits, 'ACADEMY_MAX_ROOM_CAPACITY must appear once (svc-academy only)').toHaveLength(1);
  });

  it('does not restamp jwt/stream/paper/tournament/video/LiveKit or clamp-invent seats', () => {
    expect(block.match(JWT_TTL)).toHaveLength(1);
    expect(block.match(STREAM)).toHaveLength(1);
    expect(block.match(PAPER)).toHaveLength(1);
    expect(block.match(TOURNAMENT)).toHaveLength(1);
    expect(block.match(VIDEO_TTL)).toHaveLength(1);
    expect(block).toMatch(/LIVEKIT_TOKEN_TTL_SECONDS:\s*\$\{LIVEKIT_TOKEN_TTL_SECONDS:-3600\}/);
    expect(helperTs).toMatch(/academy\.room_capacity_unset/);
    expect(helperTs).not.toMatch(/Math\.max\(1,\s*Math\.min\(100_?000/);
  });
});

describe('svc-academy ACADEMY_MAX_ROOM_CAPACITY refuse-closed', () => {
  it('env.ts source keeps the refuse-closed shape production loadEnv parses', () => {
    const envTs = readFileSync(join(HERE, '..', 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/ACADEMY_MAX_ROOM_CAPACITY:[\s\S]{0,400}\.default\(5_000\)/);
  });

  it('unset ACADEMY_MAX_ROOM_CAPACITY is unpublished (no invent 5000)', async () => {
    const parsed = await loadWith({ ACADEMY_MAX_ROOM_CAPACITY: undefined });
    expect(parsed.ACADEMY_MAX_ROOM_CAPACITY).toBeUndefined();
  });

  it('blank ACADEMY_MAX_ROOM_CAPACITY is unpublished', async () => {
    const parsed = await loadWith({ ACADEMY_MAX_ROOM_CAPACITY: '' });
    expect(parsed.ACADEMY_MAX_ROOM_CAPACITY).toBeUndefined();
  });

  it('whitespace ACADEMY_MAX_ROOM_CAPACITY is unpublished', async () => {
    const parsed = await loadWith({ ACADEMY_MAX_ROOM_CAPACITY: '   ' });
    expect(parsed.ACADEMY_MAX_ROOM_CAPACITY).toBeUndefined();
  });

  it('zero ACADEMY_MAX_ROOM_CAPACITY refuses (no invent 1 seat)', async () => {
    await expect(loadWith({ ACADEMY_MAX_ROOM_CAPACITY: '0' })).rejects.toThrow(/ACADEMY_MAX_ROOM_CAPACITY/);
  });

  it('explicit owner pin 5000 is accepted (not invented)', async () => {
    const parsed = await loadWith({ ACADEMY_MAX_ROOM_CAPACITY: '5000' });
    expect(parsed.ACADEMY_MAX_ROOM_CAPACITY).toBe(5000);
  });
});

describe('assertPublishedMaxRoomCapacity', () => {
  it('unset / NaN / 0 / 100001 refuse by name — never invent 5000', () => {
    for (const value of [undefined, Number.NaN, 0, 100_001] as const) {
      try {
        assertPublishedMaxRoomCapacity(value);
        expect.unreachable('expected refuse');
      } catch (err) {
        expect(err).toMatchObject({ code: 'academy.room_capacity_unset' });
      }
    }
  });

  it('owner-published 5000 is the ceiling', () => {
    expect(assertPublishedMaxRoomCapacity(5000)).toBe(5000);
  });
});
