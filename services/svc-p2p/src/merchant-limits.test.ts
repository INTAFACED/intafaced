import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  ceilingOnWire,
  checkOfferLimit,
  describeLimits,
  limitFor,
  limitsConfigured,
  limitsOnWire,
  NO_OFFER_LIMITS,
  offerLimitsFromEnv,
  offerLimitsPosture,
  type OfferLimitPolicy,
} from './merchant-limits.js';
import type { MerchantStatus } from './merchant-programme.js';

const policy = (standard: string | null, merchant: string | null): OfferLimitPolicy => ({
  standardMaxAmount: standard === null ? null : parseAmount(standard),
  merchantMaxAmount: merchant === null ? null : parseAmount(merchant),
});

/** Every status the programme can be in, so a new one cannot be added silently. */
const ALL_STATUSES: MerchantStatus[] = ['applied', 'approved', 'rejected', 'suspended', 'withdrawn'];

describe('merchant offer limits', () => {
  describe('unset env stays unlimited — no invented ceiling', () => {
    it('maps missing P2P_OFFER_MAX_STANDARD/MERCHANT to both-null policy', () => {
      const policy = offerLimitsFromEnv({});
      expect(policy.standardMaxAmount).toBeNull();
      expect(policy.merchantMaxAmount).toBeNull();
      expect(limitsConfigured(policy)).toBe(false);
      expect(limitsOnWire(policy).standardMax).toBeNull();
      expect(limitsOnWire(policy).merchantMax).toBeNull();
      expect(offerLimitsPosture(policy)).toBe('unset');
      expect(limitsOnWire(policy).posture).toBe('unset');
    });

    it('treats blank env strings as unset, not as zero or a default max', () => {
      const policy = offerLimitsFromEnv({
        P2P_OFFER_MAX_STANDARD: '',
        P2P_OFFER_MAX_MERCHANT: '   ',
      });
      expect(policy).toEqual(NO_OFFER_LIMITS);
      expect(
        checkOfferLimit({
          status: null,
          maxAmt: parseAmount('999999999'),
          asset: 'USDT',
          policy,
        }).withinLimit,
      ).toBe(true);
    });

    it('does not bake a numeric default into NO_OFFER_LIMITS or this module', async () => {
      expect(NO_OFFER_LIMITS).toEqual({ standardMaxAmount: null, merchantMaxAmount: null, standardMode: 'unset', merchantMode: 'unset' });
      const module = await import('./merchant-limits.js');
      expect(Object.keys(module).filter((name) => /default/i.test(name))).toEqual([]);
      for (const env of [{}, { P2P_OFFER_MAX_STANDARD: '', P2P_OFFER_MAX_MERCHANT: '  ' }]) {
        const policy = offerLimitsFromEnv(env);
        expect(policy).toEqual(NO_OFFER_LIMITS);
        for (const status of [null, ...ALL_STATUSES]) {
          expect(limitFor(status, policy)).toBeNull();
          expect(checkOfferLimit({ status, maxAmt: parseAmount('1000000000'), asset: 'USDT', policy })).toEqual({ withinLimit: true });
        }
      }
    });

    it('still parses an owner-set decimal when present — magnitudes stay env-only', () => {
      const policy = offerLimitsFromEnv({
        P2P_OFFER_MAX_STANDARD: '1000',
        P2P_OFFER_MAX_MERCHANT: '5000',
      });
      expect(policy.standardMaxAmount).toBe(parseAmount('1000'));
      expect(policy.merchantMaxAmount).toBe(parseAmount('5000'));
      expect(offerLimitsPosture(policy)).toBe('configured');
    });

    it('accepts the literal unlimited as owner confirmation, not a magnitude', () => {
      const policy = offerLimitsFromEnv({
        P2P_OFFER_MAX_STANDARD: 'unlimited',
        P2P_OFFER_MAX_MERCHANT: 'UNLIMITED',
      });
      expect(policy.standardMaxAmount).toBeNull();
      expect(policy.merchantMaxAmount).toBeNull();
      expect(offerLimitsPosture(policy)).toBe('unlimited');
      expect(limitsOnWire(policy).posture).toBe('unlimited');
      expect(limitsOnWire(policy).configured).toBe(false);
      expect(limitsOnWire(policy).standardMode).toBe('unlimited');
      expect(limitsOnWire(policy).merchantMode).toBe('unlimited');
    });
  });

  describe('the default is no limit', () => {
    it('lets any account offer any size when nothing is configured', () => {
      // This is the load-bearing non-breaking property: Stage 2 ships the
      // mechanism, not the policy, so an existing deployment that sets neither
      // env var must refuse exactly nothing it allowed before.
      for (const status of [...ALL_STATUSES, null]) {
        const verdict = checkOfferLimit({
          status,
          maxAmt: parseAmount('999999999'),
          asset: 'USDT',
          policy: NO_OFFER_LIMITS,
        });
        expect(verdict.withinLimit, `status ${status} must be unlimited by default`).toBe(true);
      }
    });

    it('reports no ceiling for every status', () => {
      for (const status of [...ALL_STATUSES, null]) {
        expect(limitFor(status, NO_OFFER_LIMITS)).toBeNull();
      }
    });
  });

  describe('which ceiling applies', () => {
    const p = policy('1000', '5000');

    it('gives the merchant ceiling to an approved merchant only', () => {
      expect(limitFor('approved', p)).toBe(parseAmount('5000'));
    });

    it.each(['applied', 'rejected', 'suspended', 'withdrawn'] as const)('leaves %s on the standard ceiling', (status) => {
      // Suspension has to actually take something away — that is the whole
      // reason Stage 1 made it reversible.
      expect(limitFor(status, p)).toBe(parseAmount('1000'));
    });

    it('treats "not in the programme" as standard, never as an error', () => {
      expect(limitFor(null, p)).toBe(parseAmount('1000'));
    });
  });

  describe('the boundary', () => {
    const p = policy('1000', '5000');

    it('allows an offer exactly at the ceiling', () => {
      expect(checkOfferLimit({ status: null, maxAmt: parseAmount('1000'), asset: 'USDT', policy: p }).withinLimit).toBe(true);
    });

    it('refuses one smallest unit above the ceiling', () => {
      const oneOver = parseAmount('1000') + 1n;
      expect(checkOfferLimit({ status: null, maxAmt: oneOver, asset: 'USDT', policy: p }).withinLimit).toBe(false);
    });

    it('allows an approved merchant the size that refuses a standard account', () => {
      const size = parseAmount('4000');
      expect(checkOfferLimit({ status: null, maxAmt: size, asset: 'USDT', policy: p }).withinLimit).toBe(false);
      expect(checkOfferLimit({ status: 'approved', maxAmt: size, asset: 'USDT', policy: p }).withinLimit).toBe(true);
    });

    it('allows zero', () => {
      expect(checkOfferLimit({ status: null, maxAmt: 0n, asset: 'USDT', policy: p }).withinLimit).toBe(true);
    });
  });

  describe('the refusal says something the trader can act on', () => {
    it('names the size, the asset and the ceiling', () => {
      const verdict = checkOfferLimit({
        status: null,
        maxAmt: parseAmount('2500'),
        asset: 'USDT',
        policy: policy('1000', '5000'),
      });
      expect(verdict.withinLimit).toBe(false);
      if (verdict.withinLimit) return;
      expect(verdict.reason).toContain('2500');
      expect(verdict.reason).toContain('1000');
      expect(verdict.reason).toContain('USDT');
    });

    it('points a standard account at the programme when it would actually help', () => {
      const verdict = checkOfferLimit({
        status: null,
        maxAmt: parseAmount('2500'),
        asset: 'USDT',
        policy: policy('1000', '5000'),
      });
      if (verdict.withinLimit) throw new Error('expected a refusal');
      expect(verdict.reason).toMatch(/merchant/i);
    });

    it('does not point at the programme when merchants get the same ceiling', () => {
      // Advertising a route that raises nothing would be advice that wastes an
      // application on the trader's behalf.
      const verdict = checkOfferLimit({
        status: null,
        maxAmt: parseAmount('2500'),
        asset: 'USDT',
        policy: policy('1000', '1000'),
      });
      if (verdict.withinLimit) throw new Error('expected a refusal');
      expect(verdict.reason).not.toMatch(/merchant programme/i);
    });

    it('does not tell an approved merchant to apply to the programme', () => {
      const verdict = checkOfferLimit({
        status: 'approved',
        maxAmt: parseAmount('9000'),
        asset: 'USDT',
        policy: policy('1000', '5000'),
      });
      if (verdict.withinLimit) throw new Error('expected a refusal');
      expect(verdict.reason).not.toMatch(/apply/i);
    });
  });

  describe('the boot line states the posture', () => {
    it('warns when nothing is configured, and says the badge buys nothing', () => {
      const posture = describeLimits(NO_OFFER_LIMITS);
      expect(posture.level).toBe('warn');
      expect(posture.summary).toMatch(/NONE CONFIGURED/);
      expect(posture.summary).toContain('P2P_OFFER_MAX_STANDARD');
    });

    it('reports both figures at info once armed', () => {
      const posture = describeLimits(policy('1000', '5000'));
      expect(posture.level).toBe('info');
      expect(posture.summary).toContain('1000');
      expect(posture.summary).toContain('5000');
    });

    it('names a half-configured posture without pretending the other half was confirmed unlimited', () => {
      const posture = describeLimits(policy('1000', null));
      expect(posture.level).toBe('info');
      expect(posture.summary).toContain('1000');
      expect(posture.summary).toContain('unset');
      expect(posture.summary).not.toMatch(/owner-confirmed/);
    });

    it('names owner-confirmed unlimited without inventing a number', () => {
      const posture = describeLimits(offerLimitsFromEnv({ P2P_OFFER_MAX_STANDARD: 'unlimited', P2P_OFFER_MAX_MERCHANT: 'unlimited' }));
      expect(posture.level).toBe('info');
      expect(posture.summary).toMatch(/UNLIMITED \(owner-confirmed\)/);
    });
  });

  describe('wire posture — clients learn ceilings without a refuse-first probe', () => {
    it('marks unconfigured as not configured and null maxes', () => {
      expect(limitsConfigured(NO_OFFER_LIMITS)).toBe(false);
      const wire = limitsOnWire(NO_OFFER_LIMITS);
      expect(wire.configured).toBe(false);
      expect(wire.posture).toBe('unset');
      expect(wire.standardMode).toBe('unset');
      expect(wire.merchantMode).toBe('unset');
      expect(wire.standardMax).toBeNull();
      expect(wire.merchantMax).toBeNull();
      expect(wire.summary).toMatch(/NONE CONFIGURED/);
    });

    it('exposes decimal strings when armed — never invents a missing half', () => {
      expect(limitsConfigured(policy('1000', '5000'))).toBe(true);
      const wire = limitsOnWire(policy('1000', null));
      expect(wire.configured).toBe(true);
      expect(wire.posture).toBe('configured');
      expect(wire.standardMode).toBe('capped');
      expect(wire.merchantMode).toBe('unset');
      expect(wire.standardMax).toBe('1000');
      expect(wire.merchantMax).toBeNull();
    });

    it('puts an approved merchant on the merchant band and everyone else on standard', () => {
      const p = policy('1000', '5000');
      expect(ceilingOnWire('approved', p)).toEqual({
        maxAmount: '5000',
        band: 'merchant',
        limitMode: 'capped',
        merchantStatus: 'approved',
      });
      expect(ceilingOnWire('applied', p)).toEqual({
        maxAmount: '1000',
        band: 'standard',
        limitMode: 'capped',
        merchantStatus: 'applied',
      });
      expect(ceilingOnWire(null, p)).toEqual({
        maxAmount: '1000',
        band: 'standard',
        limitMode: 'capped',
        merchantStatus: null,
      });
      expect(ceilingOnWire(null, NO_OFFER_LIMITS)).toEqual({
        maxAmount: null,
        band: 'standard',
        limitMode: 'unset',
        merchantStatus: null,
      });
    });
  });
});
