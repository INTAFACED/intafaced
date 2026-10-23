import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertIdempotencyConflictBoot, DEFAULT_IDEMPOTENCY_CONFLICT_MODE } from './idempotency-conflict-mode.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('idempotency conflict boot', () => {
  it('defaults to refuse', () => {
    expect(DEFAULT_IDEMPOTENCY_CONFLICT_MODE).toBe('refuse');
    const env = readFileSync(join(here, 'env.ts'), 'utf8');
    expect(env).toContain('.default(DEFAULT_IDEMPOTENCY_CONFLICT_MODE)');
    const compose = readFileSync(join(here, '..', '..', '..', 'docker-compose.apps.yml'), 'utf8');
    expect(compose).toContain('LEDGER_IDEMPOTENCY_CONFLICT_MODE: ${LEDGER_IDEMPOTENCY_CONFLICT_MODE:-refuse}');
  });

  it('allows detect only for an explicit dev or test APP_ENV', () => {
    expect(() => assertIdempotencyConflictBoot('detect', 'dev')).not.toThrow();
    expect(() => assertIdempotencyConflictBoot('detect', 'test')).not.toThrow();
    expect(() => assertIdempotencyConflictBoot('refuse', 'prod')).not.toThrow();
    expect(() => assertIdempotencyConflictBoot('refuse', undefined)).not.toThrow();
    for (const appEnv of [undefined, '', '   ', 'staging', 'prod', 'production', 'DEV', 'Test']) {
      expect(() => assertIdempotencyConflictBoot('detect', appEnv), String(appEnv)).toThrow(/APP_ENV=/);
    }
  });
});
