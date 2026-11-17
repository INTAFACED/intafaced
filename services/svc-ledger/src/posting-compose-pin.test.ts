/**
 * Unit card — compose stack passes posting freeze + reconcile cadence into svc-ledger
 *
 * 1. Promise: LEDGER_POSTING_ENABLED from host `.env` reaches the container
 *    (env.ts already declares it). RECONCILE_CRON_MINUTES is pass-through empty
 *    — cadence is owner-published, never invented 60.
 * 2. Break: compose booted ledger with JWT + internal secret but no posting
 *    kill → operator freeze after a mismatch is a no-op and the process keeps
 *    schema defaults forever. Compose `:-60` would publish hourly snapshots.
 * 3. Done bar: docker-compose.apps.yml svc-ledger has
 *    LEDGER_POSTING_ENABLED: ${LEDGER_POSTING_ENABLED:-true}
 *    RECONCILE_CRON_MINUTES: ${RECONCILE_CRON_MINUTES:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ledger block only)
 * 6. RED: pin fails if a unique key drops, posting defaults OFF, cron bakes
 *    60, or JWT / INTERNAL_SERVICE_SECRET are restamped
 * 7. Collision: JWT_ACCESS_SECRET already in this block; *internal-secret
 *    already merges INTERNAL_SERVICE_SECRET — this pin does not restamp them
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function ledgerServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-ledger');
}

const POSTING = /^\s+LEDGER_POSTING_ENABLED:\s*\$\{LEDGER_POSTING_ENABLED:-true\}\s*$/gm;
const RECONCILE = /^\s+RECONCILE_CRON_MINUTES:\s*\$\{RECONCILE_CRON_MINUTES:-\}\s*$/gm;
const JWT = /^\s+JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;

describe('compose posting freeze and reconcile cadence for svc-ledger', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-ledger/src/env.ts'), 'utf8');
  const block = ledgerServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks; cadence has no invented 60', () => {
    expect(envTs).not.toMatch(/RECONCILE_CRON_MINUTES:[\s\S]{0,400}\.default\(60\)/);
    expect(envTs).toMatch(
      /RECONCILE_CRON_MINUTES:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\),\s*\)/,
    );
    expect(envTs).toMatch(/LEDGER_POSTING_ENABLED:\s*z\s*\n\s*\.union\(\[z\.boolean\(\),\s*z\.string\(\)\]\)\s*\n\s*\.default\(true\)/);
  });

  it('compose svc-ledger block passes unique keys once; posting default true, cron empty', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ledger/);
    expect(block.match(POSTING)).toHaveLength(1);
    expect(block.match(RECONCILE)).toHaveLength(1);
    expect(block).not.toMatch(/LEDGER_POSTING_ENABLED:\s*\$\{LEDGER_POSTING_ENABLED:-false\}/);
    expect(block).not.toMatch(/RECONCILE_CRON_MINUTES:\s*\$\{RECONCILE_CRON_MINUTES:-60\}/);
  });

  it('does not restamp INTERNAL_SERVICE_SECRET or JWT_ACCESS_SECRET', () => {
    expect(block.match(JWT)).toHaveLength(1);
    expect(block).not.toMatch(/INTERNAL_SERVICE_SECRET:/);
  });

  it('JWT_ACCESS_SECRET refuses boot when unset — no silent allow via empty default', () => {
    expect(block).toMatch(/JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?/);
    expect(block).not.toMatch(/JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:-/);
  });
});
