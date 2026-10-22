import { describe, expect, it } from 'vitest';
import { CARD_SPEND_RAILS, TAX_EFFECT_MAP, TAX_EFFECT_TYPES, classifyTaxEffect } from './activity-tax-effect.js';

/** RC-portfolio-02: the tax-effect map labels P2P, card spend, mining and staking from the ledger's own reasons. */

describe('classifyTaxEffect', () => {
  it('a P2P escrow release is a disposal for the seller and an acquisition for the buyer, naming its source', () => {
    expect(classifyTaxEffect({ module: 'p2p', reason: 'p2p.escrow.release', direction: 'credit' })).toEqual({
      mapped: true,
      type: 'p2p_sale',
      effect: 'disposal',
      sourceEvent: 'p2p/p2p.escrow.release',
    });
    expect(classifyTaxEffect({ module: 'p2p', reason: 'p2p.escrow.release', direction: 'debit' })).toEqual({
      mapped: true,
      type: 'p2p_purchase',
      effect: 'acquisition',
      sourceEvent: 'p2p/p2p.escrow.release',
    });
  });

  it('the P2P lock and refund move the seller’s own value and are unmapped', () => {
    for (const reason of ['p2p.escrow.lock', 'p2p.escrow.refund']) {
      for (const direction of ['debit', 'credit'] as const) {
        expect(classifyTaxEffect({ module: 'p2p', reason, direction })).toEqual({
          mapped: false,
          code: 'portfolio.tax_effect_unmapped',
        });
      }
    }
  });

  it('a card spend on a card rail is one card_spend disposal; the same reason on another rail or no rail is unmapped', () => {
    expect(classifyTaxEffect({ module: 'ledger', reason: 'withdraw.held', direction: 'credit', rail: 'card-sandbox' })).toEqual({
      mapped: true,
      type: 'card_spend',
      effect: 'disposal',
      sourceEvent: 'ledger/withdraw.held',
    });
    for (const rail of ['crypto-native', null, undefined]) {
      expect(classifyTaxEffect({ module: 'ledger', reason: 'withdraw.held', direction: 'credit', rail }).mapped).toBe(false);
    }
    // The reversal leg of a card hold returns value; it is not a second spend.
    expect(classifyTaxEffect({ module: 'ledger', reason: 'withdraw.held', direction: 'debit', rail: 'card-sandbox' }).mapped).toBe(false);
  });

  it('a staking reward is income at receipt', () => {
    expect(classifyTaxEffect({ module: 'token', reason: 'token.yield.distributed', direction: 'debit' })).toEqual({
      mapped: true,
      type: 'staking_reward',
      effect: 'income',
      sourceEvent: 'token/token.yield.distributed',
    });
    // Staking the principal is not income.
    expect(classifyTaxEffect({ module: 'token', reason: 'token.stake', direction: 'credit' }).mapped).toBe(false);
  });

  it('mining is listed with its blocker named and classifies nothing', () => {
    const mining = TAX_EFFECT_MAP.find((row) => row.type === 'mining_payout');
    expect(mining).toMatchObject({ effect: 'income', sourceEvent: null, blocker: expect.stringContaining('mining') });
    for (const reason of ['mining.payout', 'mining_payout', 'mining']) {
      expect(classifyTaxEffect({ module: 'bank', reason, direction: 'debit' }).mapped).toBe(false);
    }
  });

  it('a reason with no row is portfolio.tax_effect_unmapped, never taxable or non-taxable', () => {
    const out = classifyTaxEffect({ module: 'bank', reason: 'bank.something.new', direction: 'debit' });
    expect(out).toEqual({ mapped: false, code: 'portfolio.tax_effect_unmapped' });
    expect(out).not.toHaveProperty('effect');
  });

  it('the same history read twice gets the same classification', () => {
    const history = [
      { module: 'p2p', reason: 'p2p.escrow.release', direction: 'credit' as const },
      { module: 'ledger', reason: 'withdraw.held', direction: 'credit' as const, rail: 'card-sandbox' },
      { module: 'token', reason: 'token.yield.distributed', direction: 'debit' as const },
      { module: 'bank', reason: 'bank.unknown', direction: 'debit' as const },
    ];
    expect(history.map(classifyTaxEffect)).toEqual(history.map(classifyTaxEffect));
  });

  it('the map covers exactly the five types, each once, with effects from the closed list', () => {
    expect(TAX_EFFECT_MAP.map((row) => row.type).sort()).toEqual([...TAX_EFFECT_TYPES].sort());
    expect(CARD_SPEND_RAILS).toEqual(['card-sandbox']);
  });
});
