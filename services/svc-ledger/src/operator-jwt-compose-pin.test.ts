/**
 * Unit card — compose stack passes operator JWT ttl / issuer / audience into svc-ledger
 *
 * 1. Promise: JWT_ACCESS_TTL_SECONDS, JWT_ISSUER, JWT_AUDIENCE, and
 *    JWT_REFRESH_TTL_SECONDS from host `.env` reach the container
 *    (authEnvSchema already defaults 900 / intafaced / intafaced.api / 2592000).
 * 2. Break: compose booted ledger with JWT_ACCESS_SECRET + posting/reconcile
 *    but no ttl / iss / aud / refresh → host pin of operator token life is a
 *    no-op and the process keeps schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-ledger has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 *    JWT_REFRESH_TTL_SECONDS: ${JWT_REFRESH_TTL_SECONDS:-2592000}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ledger block only)
 * 6. RED: pin fails if a unique key drops, defaults drift, posting is
 *    restamped OFF, or JWT_ACCESS_SECRET / reconcile lines are restamped
 * 7. Collision: JWT_ACCESS_SECRET, LEDGER_POSTING_ENABLED, and
 *    RECONCILE_CRON_MINUTES already in this block — this pin does not restamp them
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

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;
const REFRESH = /^\s+JWT_REFRESH_TTL_SECONDS:\s*\$\{JWT_REFRESH_TTL_SECONDS:-2592000\}\s*$/gm;
const JWT = /^\s+JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const POSTING = /^\s+LEDGER_POSTING_ENABLED:\s*\$\{LEDGER_POSTING_ENABLED:-true\}\s*$/gm;
const RECONCILE = /^\s+RECONCILE_CRON_MINUTES:\s*\$\{RECONCILE_CRON_MINUTES:-\}\s*$/gm;

describe('compose operator JWT ttl issuer audience for svc-ledger', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const authEnv = readFileSync(join(ROOT, 'packages/config/src/env.ts'), 'utf8');
  const block = ledgerServiceBlock(compose);

  it('authEnvSchema still defaults ttl / issuer / audience / refresh this pin tracks', () => {
    expect(authEnv).toMatch(/JWT_ACCESS_TTL_SECONDS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(60\)\.max\(3600\)\.default\(900\)/);
    expect(authEnv).toMatch(/JWT_ISSUER:\s*z\.string\(\)\.default\('intafaced'\)/);
    expect(authEnv).toMatch(/JWT_AUDIENCE:\s*z\.string\(\)\.default\('intafaced\.api'\)/);
    expect(authEnv).toMatch(/JWT_REFRESH_TTL_SECONDS:[\s\S]*?\.default\(60 \* 60 \* 24 \* 30\)/);
  });

  it('compose svc-ledger block passes unique keys once; defaults 900 / intafaced / intafaced.api / 2592000', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ledger/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(block.match(REFRESH)).toHaveLength(1);
  });

  it('does not restamp JWT_ACCESS_SECRET, posting, or reconcile', () => {
    expect(block.match(JWT)).toHaveLength(1);
    expect(block.match(POSTING)).toHaveLength(1);
    expect(block.match(RECONCILE)).toHaveLength(1);
    expect(block).not.toMatch(/LEDGER_POSTING_ENABLED:\s*\$\{LEDGER_POSTING_ENABLED:-false\}/);
  });
});
