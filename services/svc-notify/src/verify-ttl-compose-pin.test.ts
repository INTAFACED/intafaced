/**
 * Unit card — notify verify TTL is owner-published; blank refuses
 *
 * 1. Promise: NOTIFY_VERIFY_TTL_MINUTES from host `.env` reaches the
 *    container. Unset / blank does not become 15. registerTarget refuses
 *    notify.verify_ttl_unset. Never invent minutes.
 * 2. Break: compose `:-15` or env.ts `.default(15)` looks published
 *    when the operator never set a confirmation-code lifetime.
 * 3. Done bar: docker-compose.apps.yml svc-notify has
 *    NOTIFY_VERIFY_TTL_MINUTES: ${NOTIFY_VERIFY_TTL_MINUTES:-}
 *    env.ts blankAsAbsent optional 1..120, no `.default(15)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-notify block only), env.ts,
 *    notify-service.ts
 * 6. RED: pin fails if TTL default is 15, compose bakes 15, or sibling
 *    notify keys are restamped
 * 7. Collision: gateway timeout / SMS cap / delivery attempts / fanout
 *    compose pins — this pin does not restamp NOTIFY_GATEWAY_TIMEOUT_MS,
 *    NOTIFY_SMS_MAX_CHARS, NOTIFY_FANOUT_ENABLED, TRADE_URL.
 *    NOTIFY_MAX_DELIVERY_ATTEMPTS is empty pass-through (unset refuse).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const ROOT = resolve(import.meta.dirname, '../../..');

function notifyServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-notify');
}

const LINE = /^\s+NOTIFY_VERIFY_TTL_MINUTES:\s*\$\{NOTIFY_VERIFY_TTL_MINUTES:-\}\s*$/gm;
const GATEWAY_TIMEOUT = /^\s+NOTIFY_GATEWAY_TIMEOUT_MS:\s*\$\{NOTIFY_GATEWAY_TIMEOUT_MS:-5000\}\s*$/gm;
const SMS_CHARS = /^\s+NOTIFY_SMS_MAX_CHARS:\s*\$\{NOTIFY_SMS_MAX_CHARS:-480\}\s*$/gm;
const MAX_ATTEMPTS = /^\s+NOTIFY_MAX_DELIVERY_ATTEMPTS:\s*\$\{NOTIFY_MAX_DELIVERY_ATTEMPTS:-\}\s*$/gm;
const FANOUT = /^\s+NOTIFY_FANOUT_ENABLED:\s*\$\{NOTIFY_FANOUT_ENABLED:-true\}\s*$/gm;

describe('compose NOTIFY_VERIFY_TTL_MINUTES for svc-notify', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const envTs = readFileSync(resolve(ROOT, 'services/svc-notify/src/env.ts'), 'utf8');
  const serviceTs = readFileSync(resolve(import.meta.dirname, 'notify-service.ts'), 'utf8');
  const block = notifyServiceBlock(compose);

  it('env.ts refuses blank TTL — no 15 default', () => {
    expect(envTs).not.toMatch(/NOTIFY_VERIFY_TTL_MINUTES:[\s\S]{0,400}\.default\(15\)/);
    expect(envTs).toMatch(
      /NOTIFY_VERIFY_TTL_MINUTES:\s*blankAsAbsent\(z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(120\)\.optional\(\)\)/,
    );
  });

  it('compose svc-notify block is the unique home; TTL is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-notify/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toMatch(/NOTIFY_VERIFY_TTL_MINUTES:\s*\$\{NOTIFY_VERIFY_TTL_MINUTES:-15\}/);
    const hits = compose.match(/^\s+NOTIFY_VERIFY_TTL_MINUTES:/gm) ?? [];
    expect(hits, 'NOTIFY_VERIFY_TTL_MINUTES must appear once (svc-notify only)').toHaveLength(1);
  });

  it('does not restamp gateway timeout / SMS cap / attempts / fanout', () => {
    expect(block.match(GATEWAY_TIMEOUT)).toHaveLength(1);
    expect(block.match(SMS_CHARS)).toHaveLength(1);
    expect(block.match(MAX_ATTEMPTS)).toHaveLength(1);
    expect(block.match(FANOUT)).toHaveLength(1);
    expect(serviceTs).toMatch(/notify\.verify_ttl_unset/);
    expect(serviceTs).not.toMatch(/DEFAULT_VERIFY_TTL_MINUTES/);
  });
});
