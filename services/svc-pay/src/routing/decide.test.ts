import { describe, expect, it } from 'vitest';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { MemoryChain } from '../rails/chain-port.js';
import { RailRegistry } from '../rails/registry.js';
import { RoutingInputError } from '../routing-inputs.js';
import {
  REFERENCE_RAIL_ROUTING_PROFILES,
  selectSmartCheckoutRail,
  SmartRoutingApprovalRateUnsetError,
  SmartRoutingNoRailError,
  toRoutingDecisionRecord,
  type RailRoutingProfile,
} from './decide.js';

/**
 * Unit card — pay.routing product path · approval-rate honesty
 *
 * 1. Promise: geo/method/risk routing; refuse when data missing; blank/zero
 *    success-rate cannot win a rail; operator-declared rates may rank.
 * 2. Reachable break: tip chose a rail with no declared success fraction.
 * 3. Done bar: blank rate cannot win; declared rate may rank; missing
 *    geo/method/risk still `pay.routing_input_missing`.
 * 4. Class M-adjacent (chooses money path) but moves no value.
 * 5. Paths: services/svc-pay/src/routing/** + routing-inputs — not checkout money paths.
 */

function registry(): RailRegistry {
  return new RailRegistry([
    new CryptoNativeAdapter({
      chain: new MemoryChain(),
      secret: 'routing-crypto-test-secret-at-least-32',
      minConfirmations: 6,
      toleranceSeconds: 300,
    }),
    new CardSandboxAdapter({ secret: 'routing-decide-test-secret-at-least-32-chars', toleranceSeconds: 300 }),
  ]);
}

const preference = ['crypto-native', 'card-sandbox'] as const;

/** Test-only operator-declared fractions — never baked into REFERENCE profiles. */
function withDeclaredRates(profiles: readonly RailRoutingProfile[], rates: Readonly<Record<string, string>>): RailRoutingProfile[] {
  return profiles.map((p) => {
    const successRate = rates[p.railId];
    return successRate === undefined ? { ...p } : { ...p, successRate };
  });
}

describe('selectSmartCheckoutRail — geo/method/risk product path', () => {
  it('refuses when any required dimension is missing — never invents defaults', () => {
    expect(() =>
      selectSmartCheckoutRail({
        inputs: { method: 'crypto', riskBand: 'low' },
        preference,
        profiles: REFERENCE_RAIL_ROUTING_PROFILES,
        rails: registry(),
        policy: 'allow-sandbox',
      }),
    ).toThrow(RoutingInputError);

    expect(() =>
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', riskBand: 'low' },
        preference,
        profiles: REFERENCE_RAIL_ROUTING_PROFILES,
        rails: registry(),
        policy: 'allow-sandbox',
      }),
    ).toThrow(RoutingInputError);

    expect(() =>
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto' },
        preference,
        profiles: REFERENCE_RAIL_ROUTING_PROFILES,
        rails: registry(),
        policy: 'allow-sandbox',
      }),
    ).toThrow(RoutingInputError);
  });

  it('missing geo/method/risk still pay.routing_input_missing (not approval-rate)', () => {
    try {
      selectSmartCheckoutRail({
        inputs: { method: 'crypto', riskBand: 'low' },
        preference,
        profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'crypto-native': '0.90' }),
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('missing geo must refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingInputError);
      expect((e as RoutingInputError).code).toBe('pay.routing_input_missing');
      expect((e as RoutingInputError).missing).toEqual(['geo']);
    }
  });

  it('selects crypto-native for crypto + eligible geo/risk when a rate is declared', () => {
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'external:ok' },
      preference,
      profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'crypto-native': '0.91' }),
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect(decision.chosenRailId).toBe('crypto-native');
    expect(decision.adapter.id).toBe('crypto-native');
    expect(decision.inputs).toEqual({ geoCountry: 'DE', method: 'crypto', riskBand: 'external:ok' });
    expect(decision.considered.some((e) => e.railId === 'crypto-native' && e.outcome === 'chosen')).toBe(true);
  });

  it('skips crypto on method mismatch and chooses card-sandbox for card when a rate is declared', () => {
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'US', method: 'card', riskBand: 'low' },
      preference,
      profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'card-sandbox': '0.88' }),
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect(decision.chosenRailId).toBe('card-sandbox');
    const crypto = decision.considered.find((e) => e.railId === 'crypto-native');
    expect(crypto).toEqual({ railId: 'crypto-native', outcome: 'skipped', reason: 'method-mismatch' });
  });

  it('RC-merchant-08: a category limit skips every other rail, so a card payment finds no rail and crypto-native still works', () => {
    const profiles = withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'card-sandbox': '0.88', 'crypto-native': '0.91' });
    let refusal: unknown;
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'US', method: 'card', riskBand: 'low' },
        preference,
        profiles,
        rails: registry(),
        policy: 'allow-sandbox',
        onlyRails: ['crypto-native'],
      });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(SmartRoutingNoRailError);
    expect((refusal as SmartRoutingNoRailError).considered).toContainEqual({
      railId: 'card-sandbox',
      outcome: 'skipped',
      reason: 'category-restricted',
    });
    const crypto = selectSmartCheckoutRail({
      inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'external:ok' },
      preference,
      profiles,
      rails: registry(),
      policy: 'allow-sandbox',
      onlyRails: ['crypto-native'],
    });
    expect(crypto.chosenRailId).toBe('crypto-native');
  });

  it('skips a rail whose geo allowlist does not include the payer country', () => {
    const profiles: RailRoutingProfile[] = [{ railId: 'card-sandbox', methods: ['card'], countries: ['FR', 'US'], riskBands: ['low'] }];
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'card', riskBand: 'low' },
        preference: ['card-sandbox'],
        profiles,
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('geo mismatch must refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SmartRoutingNoRailError);
      expect((e as SmartRoutingNoRailError).considered[0]?.reason).toBe('geo-mismatch');
    }
  });

  it('walks preference: geo-mismatched first rail, then eligible second', () => {
    const profiles: RailRoutingProfile[] = [
      { railId: 'crypto-native', methods: ['crypto'], countries: ['US'], riskBands: ['low'] },
      { railId: 'card-sandbox', methods: ['card'], countries: ['DE'], riskBands: ['low'], successRate: '0.80' },
    ];
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'DE', method: 'card', riskBand: 'low' },
      preference,
      profiles,
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect(decision.chosenRailId).toBe('card-sandbox');
    expect(decision.considered.find((e) => e.railId === 'crypto-native')?.reason).toBe('method-mismatch');
  });

  it('skips a rail when risk band is not on the allowlist — never invents a score', () => {
    const profiles: RailRoutingProfile[] = [
      { railId: 'crypto-native', methods: ['crypto'], countries: ['*'], riskBands: ['low'] },
      { railId: 'card-sandbox', methods: ['card'], countries: ['*'], riskBands: ['low'] },
    ];
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'GB', method: 'crypto', riskBand: 'high' },
        preference,
        profiles,
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('high risk with low-only profiles must refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(SmartRoutingNoRailError);
      const err = e as SmartRoutingNoRailError;
      expect(err.code).toBe('pay.routing_no_rail');
      expect(err.considered.find((c) => c.railId === 'crypto-native')?.reason).toBe('risk-mismatch');
    }
  });

  it('skips rails with missing profiles rather than inventing eligibility', () => {
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
        preference,
        profiles: [],
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('empty profiles must refuse');
    } catch (e) {
      const err = e as SmartRoutingNoRailError;
      expect(err.considered.every((c) => c.reason === 'profile-missing')).toBe(true);
    }
  });

  it('skips rails that omit a dimension allowlist (unset ≠ wildcard)', () => {
    const profiles: RailRoutingProfile[] = [
      { railId: 'crypto-native', methods: ['crypto'], riskBands: ['low'] }, // countries omitted
    ];
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
        preference: ['crypto-native'],
        profiles,
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('geo-unset must skip');
    } catch (e) {
      expect((e as SmartRoutingNoRailError).considered[0]?.reason).toBe('geo-unset');
    }
  });

  it('under live-only, skips sandbox rails after dimension match', () => {
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'card', riskBand: 'low' },
        preference: ['card-sandbox'],
        profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'card-sandbox': '0.99' }),
        rails: registry(),
        policy: 'live-only',
      });
      expect.unreachable('sandbox under live-only must refuse');
    } catch (e) {
      expect((e as SmartRoutingNoRailError).considered[0]?.reason).toBe('sandbox');
    }
  });

  it('refuses blank approval-rate / geo scores on inputs — never invents ranking numbers', () => {
    expect(() =>
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low', approvalRate: '' },
        preference,
        profiles: REFERENCE_RAIL_ROUTING_PROFILES,
        rails: registry(),
        policy: 'allow-sandbox',
      }),
    ).toThrow(RoutingInputError);

    expect(() =>
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low', geoScore: '   ' },
        preference,
        profiles: REFERENCE_RAIL_ROUTING_PROFILES,
        rails: registry(),
        policy: 'allow-sandbox',
      }),
    ).toThrow(RoutingInputError);
  });

  it('blank rail success-rate cannot win — skip approval-rate-unset', () => {
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
        preference,
        profiles: REFERENCE_RAIL_ROUTING_PROFILES,
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('unset success-rate must not choose a rail');
    } catch (e) {
      expect(e).toBeInstanceOf(SmartRoutingApprovalRateUnsetError);
      const err = e as SmartRoutingApprovalRateUnsetError;
      expect(err.code).toBe('pay.routing_approval_rate_unset');
      expect(err.considered.find((c) => c.railId === 'crypto-native')?.reason).toBe('approval-rate-unset');
    }
  });

  it('zero declared success-rate cannot win a rail', () => {
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
        preference: ['crypto-native'],
        profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'crypto-native': '0' }),
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('zero success-rate must not choose a rail');
    } catch (e) {
      expect(e).toBeInstanceOf(SmartRoutingApprovalRateUnsetError);
      expect((e as SmartRoutingApprovalRateUnsetError).considered[0]?.reason).toBe('approval-rate-unset');
    }
  });

  it('guessed JS number / fraction-above-1 cannot win a rail', () => {
    const numberProfile = [{ ...REFERENCE_RAIL_ROUTING_PROFILES[0]!, successRate: 0.95 as unknown as string }];
    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
        preference: ['crypto-native'],
        profiles: numberProfile,
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('JS number success-rate must not choose a rail');
    } catch (e) {
      expect((e as SmartRoutingApprovalRateUnsetError).code).toBe('pay.routing_approval_rate_unset');
    }

    try {
      selectSmartCheckoutRail({
        inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
        preference: ['crypto-native'],
        profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'crypto-native': '1.2' }),
        rails: registry(),
        policy: 'allow-sandbox',
      });
      expect.unreachable('fraction above 1 must not choose a rail');
    } catch (e) {
      expect((e as SmartRoutingApprovalRateUnsetError).considered[0]?.reason).toBe('approval-rate-unset');
    }
  });

  it('declared operator rate may rank when present — higher fraction wins over preference order', () => {
    const profiles: RailRoutingProfile[] = [
      {
        railId: 'crypto-native',
        methods: ['card'],
        countries: ['*'],
        riskBands: ['low'],
        successRate: '0.70',
      },
      {
        railId: 'card-sandbox',
        methods: ['card'],
        countries: ['*'],
        riskBands: ['low'],
        successRate: '0.91',
      },
    ];
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'US', method: 'card', riskBand: 'low' },
      preference,
      profiles,
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect(decision.chosenRailId).toBe('card-sandbox');
    expect(decision.considered.find((e) => e.railId === 'crypto-native')).toEqual({
      railId: 'crypto-native',
      outcome: 'skipped',
      reason: 'outranked-success-rate',
    });
    const record = toRoutingDecisionRecord(decision);
    expect(record).not.toHaveProperty('approvalRate');
    expect(record).not.toHaveProperty('costBps');
  });

  it('equal declared rates keep the earlier preference entry and do not call the later slot outranked', () => {
    const profiles: RailRoutingProfile[] = [
      {
        railId: 'crypto-native',
        methods: ['card'],
        countries: ['*'],
        riskBands: ['low'],
        successRate: '0.80',
      },
      {
        railId: 'card-sandbox',
        methods: ['card'],
        countries: ['*'],
        riskBands: ['low'],
        successRate: '0.80',
      },
    ];
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'US', method: 'card', riskBand: 'low' },
      preference,
      profiles,
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect(decision.chosenRailId).toBe('crypto-native');
    expect(decision.adapter.id).toBe('crypto-native');
    expect(decision.considered.find((e) => e.railId === 'crypto-native')).toEqual({
      railId: 'crypto-native',
      outcome: 'chosen',
    });
    expect(decision.considered.find((e) => e.railId === 'card-sandbox')).toEqual({
      railId: 'card-sandbox',
      outcome: 'skipped',
      reason: 'tied-declared-rate-lost-preference-order',
    });
    expect(decision.considered.some((e) => e.reason === 'outranked-success-rate')).toBe(false);
  });

  it('the same rail id listed twice records one chosen entry', () => {
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
      preference: ['crypto-native', 'crypto-native'],
      profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'crypto-native': '0.91' }),
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect(decision.chosenRailId).toBe('crypto-native');
    const chosen = decision.considered.filter((e) => e.outcome === 'chosen');
    expect(chosen).toEqual([{ railId: 'crypto-native', outcome: 'chosen' }]);
    expect(decision.considered).toEqual([
      { railId: 'crypto-native', outcome: 'chosen' },
      {
        railId: 'crypto-native',
        outcome: 'skipped',
        reason: 'tied-declared-rate-lost-preference-order',
      },
    ]);
  });

  it('omitted scores stay omitted on the decision — no default approval-rate', () => {
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'DE', method: 'crypto', riskBand: 'low' },
      preference,
      profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'crypto-native': '0.84' }),
      rails: registry(),
      policy: 'allow-sandbox',
    });
    expect(decision).not.toHaveProperty('approvalRate');
    expect(decision).not.toHaveProperty('geoScore');
    expect(decision).not.toHaveProperty('methodRank');
    const record = toRoutingDecisionRecord(decision);
    expect(record).not.toHaveProperty('approvalRate');
    expect(record).not.toHaveProperty('geoScore');
    expect(record).not.toHaveProperty('methodRank');
  });

  it('decision record for payment_events carries reasons and bans invent scores', () => {
    const decision = selectSmartCheckoutRail({
      inputs: { geoCountry: 'fr', method: 'crypto', riskBand: 'low' },
      preference,
      profiles: withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, { 'crypto-native': '0.77' }),
      rails: registry(),
      policy: 'allow-sandbox',
    });
    const record = toRoutingDecisionRecord(decision);
    expect(record.kind).toBe('pay.routing.decision');
    expect(record.chosenRailId).toBe('crypto-native');
    expect(record.geoCountry).toBe('fr');
    expect(record).not.toHaveProperty('approvalRate');
    expect(record).not.toHaveProperty('costBps');
  });
});
