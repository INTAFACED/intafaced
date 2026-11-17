/**
 * Unit card — compose passes RECONCILE_CRON_MINUTES empty into svc-ledger
 *
 * 1. Promise: host `.env` can pin reconcile cadence; compose does not invent
 *    60. Unset / empty stays unpublished and env.ts refuses boot.
 * 2. Break: compose `:-60` (or omitting the key) makes a blank host env look
 *    published as an hourly snapshot interval nobody chose.
 * 3. Done bar: docker-compose.apps.yml svc-ledger has
 *    RECONCILE_CRON_MINUTES: ${RECONCILE_CRON_MINUTES:-}
 *    env.ts preprocess blank → undefined, coerce int min 1, no `.default(60)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ledger block only) + env.ts
 * 6. RED: pin fails if cadence default is 60, compose bakes 60, or sibling
 *    ledger keys are restamped
 * 7. Collision: posting-compose-pin / operator-jwt-compose-pin — this pin only
 *    names RECONCILE_CRON_MINUTES
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NAME = 'RECONCILE_CRON_MINUTES';
const EMPTY_PASS = `${NAME}: \${${NAME}:-}`;

function ledgerServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-ledger');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose RECONCILE_CRON_MINUTES for svc-ledger', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-ledger/src/env.ts'), 'utf8');
  const block = ledgerServiceBlock(compose);

  it('env.ts refuses blank reconcile cadence — no 60 default', () => {
    expect(envTs).not.toMatch(/RECONCILE_CRON_MINUTES:[\s\S]{0,400}\.default\(60\)/);
    expect(envTs).toMatch(
      /RECONCILE_CRON_MINUTES:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\),\s*\)/,
    );
  });

  it('svc-ledger compose line is empty pass-through — no invented 60', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ledger/);
    expect(block, `${NAME} missing empty pass-through`).toContain(EMPTY_PASS);
    expect(block).toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-\\}`));
    expect(block).not.toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-60\\}`));
    expect(countAssignments(block, NAME), `${NAME} must appear once on svc-ledger`).toBe(1);
    expect(compose.match(/^\s+RECONCILE_CRON_MINUTES:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp posting kill or JWT_ACCESS_SECRET', () => {
    expect(block).toMatch(/LEDGER_POSTING_ENABLED:\s*\$\{LEDGER_POSTING_ENABLED:-true\}/);
    expect(block).not.toMatch(/LEDGER_POSTING_ENABLED:\s*\$\{LEDGER_POSTING_ENABLED:-false\}/);
    expect(block).toMatch(/JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?/);
    expect(block).not.toMatch(/JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:-/);
  });
});
