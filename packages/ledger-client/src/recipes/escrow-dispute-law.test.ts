import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { parseAmount, formatAmount } from '../money.js';
import { houseFees, tradeEscrowAccount, userAvailable } from '../accounts.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { assertEscrowDisputeRuling, assertEscrowRefundResolution, isNaturalPersonId } from './escrow-dispute-law.js';

const SELLER = '11111111-1111-1111-1111-111111111111';
const BUYER = '22222222-2222-2222-2222-222222222222';
const MODERATOR = 'abcdef01-2345-6789-abcd-ef0123456789';
const DISPUTE = 'fedcba98-7654-3210-fedc-ba9876543210';

const amt = (s: string) => parseAmount(s);

async function fund(ledger: MemoryLedger, userId: string, assetId: string, amount: string) {
  await ledger.post(
    recipes.deposit({
      userId,
      assetId,
      amount: amt(amount),
      rail: 'test',
      railRef: `fund-${userId}-${assetId}-${amount}-${Math.random()}`,
    }),
  );
}

describe('escrow dispute law (ADR D-S-08) — recipe layer', () => {
  it('isNaturalPersonId is an allowlist of lowercase UUIDs', () => {
    expect(isNaturalPersonId(MODERATOR)).toBe(true);
    expect(isNaturalPersonId('system:p2p-backstop')).toBe(false);
    expect(isNaturalPersonId('System:p2p-backstop')).toBe(false);
    expect(isNaturalPersonId('timeout')).toBe(false);
    expect(isNaturalPersonId(MODERATOR.toUpperCase())).toBe(false);
  });

  it('happy-path escrowRelease / escrowRefund omit ruling and still post', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger, SELLER, 'USDT', '100');
    await ledger.post(recipes.escrowLock({ tradeId: 't-happy', sellerId: SELLER, buyerId: BUYER, assetId: 'USDT', amount: amt('100') }));
    await ledger.post(
      recipes.escrowRelease({
        tradeId: 't-happy',
        sellerId: SELLER,
        buyerId: BUYER,
        assetId: 'USDT',
        amount: amt('100'),
        feeBps: 0,
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('100');

    await fund(ledger, SELLER, 'USDT', '50');
    await ledger.post(recipes.escrowLock({ tradeId: 't-cancel', sellerId: SELLER, buyerId: BUYER, assetId: 'USDT', amount: amt('50') }));
    await ledger.post(
      recipes.escrowRefund({
        tradeId: 't-cancel',
        sellerId: SELLER,
        buyerId: BUYER,
        assetId: 'USDT',
        amount: amt('50'),
        resolution: 'cancelled',
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(SELLER, 'USDT'))).amount)).toBe('50');
  });

  it('moderated release posts with ruling meta and moves value once', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger, SELLER, 'USDT', '100');
    await ledger.post(recipes.escrowLock({ tradeId: 't-mod-rel', sellerId: SELLER, buyerId: BUYER, assetId: 'USDT', amount: amt('100') }));

    const req = recipes.escrowRelease({
      tradeId: 't-mod-rel',
      sellerId: SELLER,
      buyerId: BUYER,
      assetId: 'USDT',
      amount: amt('100'),
      feeBps: 100,
      ruling: { disputeId: DISPUTE, rulingBy: MODERATOR, notes: 'buyer paid' },
    });
    expect(req.meta).toMatchObject({
      tradeId: 't-mod-rel',
      feeBps: 100,
      disputeId: DISPUTE,
      rulingBy: MODERATOR,
      rulingNotes: 'buyer paid',
    });
    expect(req.idempotencyKey).toBe('p2p.escrow.release:t-mod-rel');

    await ledger.post(req);
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('99');
    expect(formatAmount((await ledger.balance(houseFees('p2p', 'USDT'))).amount)).toBe('1');
    expect(formatAmount((await ledger.balance(tradeEscrowAccount(SELLER, 'USDT', 't-mod-rel'))).amount)).toBe('0');
  });

  it('moderated refund posts with ruling meta back to seller', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger, SELLER, 'USDT', '100');
    await ledger.post(recipes.escrowLock({ tradeId: 't-mod-ref', sellerId: SELLER, buyerId: BUYER, assetId: 'USDT', amount: amt('100') }));

    const req = recipes.escrowRefund({
      tradeId: 't-mod-ref',
      sellerId: SELLER,
      buyerId: BUYER,
      assetId: 'USDT',
      amount: amt('100'),
      resolution: 'moderator.refund',
      ruling: { disputeId: DISPUTE, rulingBy: MODERATOR },
    });
    expect(req.meta).toMatchObject({
      resolution: 'moderator.refund',
      disputeId: DISPUTE,
      rulingBy: MODERATOR,
    });

    await ledger.post(req);
    expect(formatAmount((await ledger.balance(userAvailable(SELLER, 'USDT'))).amount)).toBe('100');
  });

  it('release refuses system / timeout / empty rulingBy when dispute disposition is claimed', () => {
    const base = {
      tradeId: 't-refuse-rel',
      sellerId: SELLER,
      buyerId: BUYER,
      assetId: 'USDT',
      amount: amt('100'),
      feeBps: 0,
    };

    for (const rulingBy of ['system:p2p-backstop', 'timeout', 'automation:p2p', '', 'NOT-A-UUID']) {
      expect(() =>
        recipes.escrowRelease({
          ...base,
          ruling: { disputeId: DISPUTE, rulingBy },
        }),
      ).toThrow(InvalidEntryError);
    }

    expect(() =>
      recipes.escrowRelease({
        ...base,
        ruling: { disputeId: '', rulingBy: MODERATOR },
      }),
    ).toThrow(/disputeId is required/);
  });

  it('refund refuses machine resolution strings even without ruling', () => {
    const base = {
      tradeId: 't-refuse-res',
      sellerId: SELLER,
      buyerId: BUYER,
      assetId: 'USDT',
      amount: amt('100'),
    };

    for (const resolution of ['system:p2p-backstop', 'timeout', 'backstop', 'auto-refund', 'automation:x']) {
      expect(() => recipes.escrowRefund({ ...base, resolution })).toThrow(InvalidEntryError);
    }
  });

  it('refund refuses machine rulingBy when dispute disposition is claimed', () => {
    expect(() =>
      recipes.escrowRefund({
        tradeId: 't-refuse-ref',
        sellerId: SELLER,
        buyerId: BUYER,
        assetId: 'USDT',
        amount: amt('100'),
        resolution: 'moderator.refund',
        ruling: { disputeId: DISPUTE, rulingBy: 'system:p2p-backstop' },
      }),
    ).toThrow(/cannot dispose of disputed escrow/);
  });

  it('assert helpers match recipe refusals', () => {
    expect(() => assertEscrowDisputeRuling({ disputeId: DISPUTE, rulingBy: 'system:x' }, 'x')).toThrow(InvalidEntryError);
    expect(() => assertEscrowRefundResolution('system:p2p-backstop', 'x')).toThrow(InvalidEntryError);
    expect(() => assertEscrowDisputeRuling({ disputeId: DISPUTE, rulingBy: MODERATOR }, 'x')).not.toThrow();
  });
});
