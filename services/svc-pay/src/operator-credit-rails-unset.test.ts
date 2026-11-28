import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { operatorCreditRailsSchema } from './operator-credit-rails-env.js';
import { payEnv } from './env.testkit.js';

/**
 * Owner operator-credit allow-list is refuse-closed when unset.
 *
 * `z.string().default('card-sandbox')` plus compose `:-card-sandbox` treated
 * blank as a published sandbox acquirer. Blank is unset; `card-sandbox` only
 * when the owner publishes it. Same class as card-sim ≠ issuer.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('PAY_OPERATOR_CREDIT_RAILS unset refuse', () => {
  it('the boot settings refuse a blank allow-list rather than defaulting it to card-sandbox', () => {
    for (const blank of [undefined, '', '   ', ',']) {
      expect(() => payEnv({ PAY_OPERATOR_CREDIT_RAILS: blank })).toThrow(/PAY_OPERATOR_CREDIT_RAILS/);
    }
    expect(payEnv({ PAY_OPERATOR_CREDIT_RAILS: 'card-sandbox' }).PAY_OPERATOR_CREDIT_RAILS).toEqual(['card-sandbox']);
    expect(payEnv({ PAY_OPERATOR_CREDIT_RAILS: 'crypto-native' }).PAY_OPERATOR_CREDIT_RAILS).toEqual(['crypto-native']);
  });

  it('compose empty pass-through — never a baked card-sandbox', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-pay:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(/PAY_OPERATOR_CREDIT_RAILS:\s*\$\{PAY_OPERATOR_CREDIT_RAILS:-\}/);
    expect(block).not.toMatch(/PAY_OPERATOR_CREDIT_RAILS:\s*\$\{PAY_OPERATOR_CREDIT_RAILS:-card-sandbox\}/);
    expect(block).not.toMatch(/PAY_OPERATOR_CREDIT_RAILS:\s*card-sandbox/);
  });

  it('blank / whitespace refuse; owner card-sandbox is allowed', () => {
    expect(operatorCreditRailsSchema.safeParse(undefined).success).toBe(false);
    expect(operatorCreditRailsSchema.safeParse('').success).toBe(false);
    expect(operatorCreditRailsSchema.safeParse('   ').success).toBe(false);
    expect(operatorCreditRailsSchema.safeParse(',').success).toBe(false);
    expect(operatorCreditRailsSchema.parse('card-sandbox')).toEqual(['card-sandbox']);
    expect(operatorCreditRailsSchema.parse('card-sandbox,crypto-native')).toEqual(['card-sandbox', 'crypto-native']);
  });
});
