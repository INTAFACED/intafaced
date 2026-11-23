/**
 * Unit card — compose x-service-env passes DATABASE_POOL_MAX empty
 *
 * 1. Promise: host `.env` can pin pool size; compose does not invent 10.
 *    Unset / empty stays unpublished and postgresEnvSchema refuses boot.
 * 2. Break: compose `:-10` (or omitting the key) makes a blank host env look
 *    published as a pool size nobody chose.
 * 3. Done bar: docker-compose.apps.yml x-service-env has
 *    DATABASE_POOL_MAX: ${DATABASE_POOL_MAX:-}
 *    env.ts preprocess blank → undefined, coerce int min 1 max 200, no `.default(10)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (x-service-env only) + env.ts
 * 6. RED: pin fails if pool default is 10, compose bakes 10, or sibling
 *    x-service-env keys are restamped
 * 7. Collision: INTERNAL_SERVICE_BODY_BIND compose pin — this pin only names
 *    DATABASE_POOL_MAX
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv, postgresEnvSchema } from './env.js';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const NAME = 'DATABASE_POOL_MAX';
const EMPTY_PASS = `${NAME}: \${${NAME}:-}`;

function serviceEnvAnchor(source: string): string {
  const match = source.match(/^x-service-env: &service-env\n(?: .*\n)*/m);
  if (!match) throw new Error('x-service-env anchor missing from docker-compose.apps.yml');
  return match[0];
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose DATABASE_POOL_MAX via *service-env', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const anchor = serviceEnvAnchor(compose);

  it('postgresEnvSchema refuses a blank pool size and invents no 10', () => {
    const url = 'postgres://u:p@localhost:5432/db';
    for (const blank of [undefined, '', '   ']) {
      const source = blank === undefined ? { DATABASE_URL: url } : { DATABASE_URL: url, [NAME]: blank };
      expect(() => loadEnv(postgresEnvSchema, source), `${NAME}=${String(blank)}`).toThrow(EnvError);
    }
    for (const bad of ['0', '201', '2.5', 'ten']) {
      expect(() => loadEnv(postgresEnvSchema, { DATABASE_URL: url, [NAME]: bad }), `${NAME}=${bad}`).toThrow(EnvError);
    }
    expect(loadEnv(postgresEnvSchema, { DATABASE_URL: url, [NAME]: '1' })[NAME]).toBe(1);
    expect(loadEnv(postgresEnvSchema, { DATABASE_URL: url, [NAME]: '200' })[NAME]).toBe(200);
    expect(loadEnv(postgresEnvSchema, { DATABASE_URL: url, [NAME]: ' 7 ' })[NAME]).toBe(7);
  });

  it('x-service-env compose line is empty pass-through — no invented 10', () => {
    expect(anchor, `${NAME} missing empty pass-through`).toContain(EMPTY_PASS);
    expect(anchor).toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-\\}`));
    expect(anchor).not.toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-10\\}`));
    expect(countAssignments(anchor, NAME), `${NAME} must appear once on x-service-env`).toBe(1);
    expect(compose.match(/^\s+DATABASE_POOL_MAX:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp DATABASE_SSL or INTERNAL_SERVICE_BODY_BIND', () => {
    expect(anchor).toMatch(/DATABASE_SSL:\s*'false'/);
    expect(compose).toMatch(/INTERNAL_SERVICE_BODY_BIND:\s*\$\{INTERNAL_SERVICE_BODY_BIND:-accept-both\}/);
    expect(compose).not.toMatch(/INTERNAL_SERVICE_BODY_BIND:\s*\$\{INTERNAL_SERVICE_BODY_BIND:-require\}/);
  });
});
