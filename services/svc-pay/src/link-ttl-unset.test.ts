import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { payEnv } from './env.testkit.js';
import { PayError, publishedLinkDefaultTtlDays, publishedLinkMaxTtlDays } from './payment-service.js';

/**
 * Owner payment-link default / max lifetime is refuse-closed when unset.
 *
 * `z.coerce.number().default(30)` / `.default(365)` treated blank TTL env as a
 * published capability URL. Blank is unset; 30 / 365 only when the owner
 * publishes them. Mint-path refuse with a real merchant lives in
 * payment-service.test.ts (PG-hard).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('PAY_LINK_DEFAULT_TTL_DAYS unset refuse', () => {
  it('the boot settings refuse a blank default lifetime rather than defaulting it to 30', () => {
    for (const blank of [undefined, '', ' ', '0', '3651']) {
      expect(() => payEnv({ PAY_LINK_DEFAULT_TTL_DAYS: blank })).toThrow(/PAY_LINK_DEFAULT_TTL_DAYS/);
    }
    expect(payEnv({ PAY_LINK_DEFAULT_TTL_DAYS: '30' }).PAY_LINK_DEFAULT_TTL_DAYS).toBe(30);
    expect(payEnv({ PAY_LINK_DEFAULT_TTL_DAYS: '1' }).PAY_LINK_DEFAULT_TTL_DAYS).toBe(1);
  });

  it('compose refuses missing — never a baked 30', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-pay:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(/PAY_LINK_DEFAULT_TTL_DAYS:\s*\$\{PAY_LINK_DEFAULT_TTL_DAYS:\?missing — copy \.env\.example to \.env\}/);
    expect(block).not.toMatch(/PAY_LINK_DEFAULT_TTL_DAYS:\s*\$\{PAY_LINK_DEFAULT_TTL_DAYS:-30\}/);
    expect(block).not.toMatch(/PAY_LINK_DEFAULT_TTL_DAYS:\s*['"]?30/);
  });

  it('publishedLinkDefaultTtlDays refuses null rather than inventing 30', () => {
    expect(() => publishedLinkDefaultTtlDays(null)).toThrow(PayError);
    expect(() => publishedLinkDefaultTtlDays(undefined)).toThrow(expect.objectContaining({ code: 'pay.link_ttl_unset' }));
    expect(publishedLinkDefaultTtlDays(30)).toBe(30);
    expect(publishedLinkDefaultTtlDays(1)).toBe(1);
  });
});

describe('PAY_LINK_MAX_TTL_DAYS unset refuse', () => {
  it('the boot settings refuse a blank maximum lifetime rather than defaulting it to 365', () => {
    for (const blank of [undefined, '', ' ', '0', '3651']) {
      expect(() => payEnv({ PAY_LINK_MAX_TTL_DAYS: blank })).toThrow(/PAY_LINK_MAX_TTL_DAYS/);
    }
    expect(payEnv({ PAY_LINK_MAX_TTL_DAYS: '365' }).PAY_LINK_MAX_TTL_DAYS).toBe(365);
    expect(payEnv({ PAY_LINK_MAX_TTL_DAYS: '3650' }).PAY_LINK_MAX_TTL_DAYS).toBe(3650);
  });

  it('compose refuses missing — never a baked 365', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-pay:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(/PAY_LINK_MAX_TTL_DAYS:\s*\$\{PAY_LINK_MAX_TTL_DAYS:\?missing — copy \.env\.example to \.env\}/);
    expect(block).not.toMatch(/PAY_LINK_MAX_TTL_DAYS:\s*\$\{PAY_LINK_MAX_TTL_DAYS:-365\}/);
    expect(block).not.toMatch(/PAY_LINK_MAX_TTL_DAYS:\s*['"]?365/);
  });

  it('publishedLinkMaxTtlDays refuses null rather than inventing 365', () => {
    expect(() => publishedLinkMaxTtlDays(null)).toThrow(PayError);
    expect(() => publishedLinkMaxTtlDays(undefined)).toThrow(expect.objectContaining({ code: 'pay.link_max_ttl_unset' }));
    expect(publishedLinkMaxTtlDays(365)).toBe(365);
    expect(publishedLinkMaxTtlDays(1)).toBe(1);
  });
});
