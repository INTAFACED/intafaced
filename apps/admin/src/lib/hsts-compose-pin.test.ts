/**
 * Compose must pass the HSTS stage into the admin container, with the gentle default.
 *
 * The console reads HSTS_MAX_AGE_SECONDS / HSTS_INCLUDE_SUBDOMAINS per request (middleware) and validates them at boot
 * (instrumentation). The host-side names are ADMIN_HSTS_* so a later customer service can take its own without a collision.
 * The defaults are today's value (one day, host-only); a raised default here would silently pin every deployment that forgot
 * to set it, so the default is pinned. There is no preload knob anywhere in compose.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const COMPOSE = resolve(ROOT, 'docker-compose.apps.yml');
const ENV_EXAMPLE = resolve(ROOT, '.env.example');

function adminServiceBlock(source: string): string {
  const match = source.match(/^  admin:\n(?:.*\n)*?(?=^  [a-z]|^[a-z]|\Z)/m);
  if (!match) throw new Error('admin service block missing from docker-compose.apps.yml');
  return match[0];
}

function assignmentLines(block: string, key: string): string[] {
  return block.split('\n').filter((line) => new RegExp(`^\\s+${key}:`).test(line));
}

describe('compose HSTS env for admin', () => {
  const block = adminServiceBlock(readFileSync(COMPOSE, 'utf8'));

  it('passes each knob once, from the ADMIN_HSTS_* host variable, defaulting to one day / host-only', () => {
    expect(assignmentLines(block, 'HSTS_MAX_AGE_SECONDS')).toEqual(['      HSTS_MAX_AGE_SECONDS: ${ADMIN_HSTS_MAX_AGE_SECONDS:-86400}']);
    expect(assignmentLines(block, 'HSTS_INCLUDE_SUBDOMAINS')).toEqual([
      '      HSTS_INCLUDE_SUBDOMAINS: ${ADMIN_HSTS_INCLUDE_SUBDOMAINS:-false}',
    ]);
  });

  it('has no preload knob and no NEXT_PUBLIC_ spelling, in compose or .env.example', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const example = readFileSync(ENV_EXAMPLE, 'utf8');
    for (const text of [compose, example]) {
      expect(text).not.toMatch(/HSTS_PRELOAD/);
      expect(text).not.toMatch(/NEXT_PUBLIC_[A-Z_]*HSTS/);
    }
  });

  it('documents both host variables in .env.example, commented out at the safe default', () => {
    const example = readFileSync(ENV_EXAMPLE, 'utf8');
    expect(example).toMatch(/^# ADMIN_HSTS_MAX_AGE_SECONDS=86400$/m);
    expect(example).toMatch(/^# ADMIN_HSTS_INCLUDE_SUBDOMAINS=false$/m);
  });
});
