/**
 * Unit card — notify max delivery attempts is owner-published; blank refuses
 *
 * 1. Promise: NOTIFY_MAX_DELIVERY_ATTEMPTS from host `.env` reaches the
 *    container. Unset / blank does not become 3. Boot wiring refuses
 *    notify.max_delivery_attempts_unset. Never invent a retry ceiling.
 * 2. Break: compose `:-3` or env.ts `.default(3)` looks published
 *    when the operator never set the attempt bound.
 * 3. Done bar: docker-compose.apps.yml svc-notify has
 *    NOTIFY_MAX_DELIVERY_ATTEMPTS: ${NOTIFY_MAX_DELIVERY_ATTEMPTS:-}
 *    env.ts blankAsAbsent optional 1..5, no `.default(3)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-notify block only), env.ts,
 *    max-delivery-attempts.ts
 * 6. RED: pin fails if attempts default is 3, compose bakes 3, or sibling
 *    notify keys are restamped
 * 7. Collision: gateway timeout / SMS cap / verify TTL / fanout
 *    compose pins — this pin does not restamp NOTIFY_GATEWAY_TIMEOUT_MS,
 *    NOTIFY_SMS_MAX_CHARS, NOTIFY_VERIFY_TTL_MINUTES,
 *    NOTIFY_FANOUT_ENABLED, TRADE_URL
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const ROOT = resolve(import.meta.dirname, '../../..');

function notifyServiceBlock(source: string): string {
  // (?![\s\S]) is the end of the string. In JavaScript \Z is a literal Z.
  const match = source.match(/^  svc-notify:\n(?:.*(?:\n|$))*?(?=^  [a-z]|(?![\s\S]))/m);
  if (!match) throw new Error('svc-notify service block missing from docker-compose.apps.yml');
  return match[0];
}

const LINE = /^\s+NOTIFY_MAX_DELIVERY_ATTEMPTS:\s*\$\{NOTIFY_MAX_DELIVERY_ATTEMPTS:-\}\s*$/gm;
const GATEWAY_TIMEOUT = /^\s+NOTIFY_GATEWAY_TIMEOUT_MS:\s*\$\{NOTIFY_GATEWAY_TIMEOUT_MS:-5000\}\s*$/gm;
const SMS_CHARS = /^\s+NOTIFY_SMS_MAX_CHARS:\s*\$\{NOTIFY_SMS_MAX_CHARS:-480\}\s*$/gm;
const VERIFY_TTL = /^\s+NOTIFY_VERIFY_TTL_MINUTES:\s*\$\{NOTIFY_VERIFY_TTL_MINUTES:-\}\s*$/gm;
const FANOUT = /^\s+NOTIFY_FANOUT_ENABLED:\s*\$\{NOTIFY_FANOUT_ENABLED:-true\}\s*$/gm;

describe('compose NOTIFY_MAX_DELIVERY_ATTEMPTS for svc-notify', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const envTs = readFileSync(resolve(ROOT, 'services/svc-notify/src/env.ts'), 'utf8');
  const helperTs = readFileSync(resolve(import.meta.dirname, 'max-delivery-attempts.ts'), 'utf8');
  const block = notifyServiceBlock(compose);

  it('env.ts refuses blank attempts — no 3 default', () => {
    expect(envTs).not.toMatch(/NOTIFY_MAX_DELIVERY_ATTEMPTS:[\s\S]{0,400}\.default\(3\)/);
    expect(envTs).toMatch(
      /NOTIFY_MAX_DELIVERY_ATTEMPTS:\s*blankAsAbsent\(z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(5\)\.optional\(\)\)/,
    );
  });

  it('compose svc-notify block is the unique home; attempts is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-notify/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toMatch(/NOTIFY_MAX_DELIVERY_ATTEMPTS:\s*\$\{NOTIFY_MAX_DELIVERY_ATTEMPTS:-3\}/);
    const hits = compose.match(/^\s+NOTIFY_MAX_DELIVERY_ATTEMPTS:/gm) ?? [];
    expect(hits, 'NOTIFY_MAX_DELIVERY_ATTEMPTS must appear once (svc-notify only)').toHaveLength(1);
  });

  it('does not restamp gateway timeout / SMS cap / verify TTL / fanout', () => {
    expect(block.match(GATEWAY_TIMEOUT)).toHaveLength(1);
    expect(block.match(SMS_CHARS)).toHaveLength(1);
    expect(block.match(VERIFY_TTL)).toHaveLength(1);
    expect(block.match(FANOUT)).toHaveLength(1);
    expect(helperTs).toMatch(/notify\.max_delivery_attempts_unset/);
    expect(helperTs).not.toMatch(/DEFAULT_MAX_DELIVERY_ATTEMPTS/);
  });
});

describe('notifyServiceBlock fixtures', () => {
  const attemptsLine = '    NOTIFY_MAX_DELIVERY_ATTEMPTS: ${NOTIFY_MAX_DELIVERY_ATTEMPTS:-}';

  it('matches a svc-notify block that runs to EOF', () => {
    const withNewline = `  svc-notify:\n${attemptsLine}\n`;
    const withoutNewline = `  svc-notify:\n${attemptsLine}`;
    for (const source of [withNewline, withoutNewline]) {
      const block = notifyServiceBlock(source);
      expect(block).toBe(source);
      expect(block.match(LINE)).toHaveLength(1);
    }
  });

  it('does not end the block on a line whose first character is Z', () => {
    const source = [
      '  svc-notify:',
      '    SERVICE_NAME: svc-notify',
      'Z_STILL_IN_BLOCK: kept',
      attemptsLine,
      '  svc-support:',
      '    SERVICE_NAME: svc-support',
      '',
    ].join('\n');
    const block = notifyServiceBlock(source);
    expect(block).toContain('Z_STILL_IN_BLOCK: kept');
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toContain('svc-support');
  });
});
