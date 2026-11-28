import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOwnerIntegerEnv } from './fee-bps-env.js';
import { payEnv } from './env.testkit.js';
import { PayError, publishedDefaultFeeBps } from './payment-service.js';

/**
 * Owner house take is refuse-closed when unset.
 *
 * `z.coerce.number()` treated blank `PAY_DEFAULT_FEE_BPS` as 0 bps (Number("") === 0),
 * so settlement ran free. Blank is unset; 0 is only when the owner publishes 0.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('PAY_DEFAULT_FEE_BPS unset refuse', () => {
  it('blank / omit parse to null — never 0', () => {
    expect(parseOwnerIntegerEnv(undefined)).toBeNull();
    expect(parseOwnerIntegerEnv(null)).toBeNull();
    expect(parseOwnerIntegerEnv('')).toBeNull();
    expect(parseOwnerIntegerEnv('   ')).toBeNull();
    expect(parseOwnerIntegerEnv('250')).toBe(250);
    expect(parseOwnerIntegerEnv(0)).toBe(0);
  });

  it('the boot settings read a blank or missing default fee as unset — never 0', () => {
    expect(payEnv({ PAY_DEFAULT_FEE_BPS: undefined }).PAY_DEFAULT_FEE_BPS).toBeNull();
    expect(payEnv({ PAY_DEFAULT_FEE_BPS: '' }).PAY_DEFAULT_FEE_BPS).toBeNull();
    expect(payEnv({ PAY_DEFAULT_FEE_BPS: '   ' }).PAY_DEFAULT_FEE_BPS).toBeNull();
    expect(payEnv({ PAY_DEFAULT_FEE_BPS: '250' }).PAY_DEFAULT_FEE_BPS).toBe(250);
    expect(payEnv({ PAY_DEFAULT_FEE_BPS: '0' }).PAY_DEFAULT_FEE_BPS).toBe(0);
  });

  it('compose passes empty — never a baked 0', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-pay:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(/PAY_DEFAULT_FEE_BPS:\s*\$\{PAY_DEFAULT_FEE_BPS:-\}/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*\$\{PAY_DEFAULT_FEE_BPS:-0\}/);
    expect(block).not.toMatch(/PAY_DEFAULT_FEE_BPS:\s*['"]?0/);
  });

  it('publishedDefaultFeeBps refuses null rather than inventing 0', () => {
    expect(() => publishedDefaultFeeBps(null)).toThrow(PayError);
    expect(() => publishedDefaultFeeBps(undefined)).toThrow(expect.objectContaining({ code: 'pay.fee_bps_unset' }));
    expect(publishedDefaultFeeBps(0)).toBe(0);
    expect(publishedDefaultFeeBps(250)).toBe(250);
  });
});
