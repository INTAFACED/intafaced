/**
 * P2P block/RFQ: firm quote/accept/expire. Not a book fill. Never invent a mid
 * or the house capacity model. Last look refuses with a named code.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import {
  BlockRfqError,
  BlockRfqService,
  RFQ_ALLOCATION_RESIDUAL,
  RFQ_GIVE_UP_RESIDUAL,
  RFQ_LAST_LOOK_RESIDUAL,
  RFQ_UNLABELED_CAPACITY_RESIDUAL,
  RFQ_UNNAMED_RECEIVING_RESIDUAL,
  acceptBlockQuote,
  expireBlockQuote,
  parseNamedReceivingAccount,
  parseRequiredCapacity,
  parseRequiredExpiry,
  parseRequiredFirmness,
  parseRequiredPrice,
  parseRequiredSize,
  presentBlockQuote,
} from './block-rfq.js';
import { MemoryBlockQuoteStore } from './block-rfq-store.js';

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-26T12:00:00.000Z');
const EXPIRY = '2026-08-26T12:05:00.000Z';

const maker = { userId: MAKER } as Principal;
const taker = { userId: TAKER } as Principal;
const stranger = { userId: STRANGER } as Principal;

function service(now = NOW) {
  return new BlockRfqService(new MemoryBlockQuoteStore(), { now: () => now });
}

function quoteBody(over: Record<string, unknown> = {}) {
  return {
    takerId: TAKER,
    side: 'sell' as const,
    asset: 'USDT',
    fiatCurrency: 'USD',
    size: '1',
    price: '1',
    expiresAt: EXPIRY,
    capacity: 'principal',
    firmness: 'firm',
    ...over,
  };
}

describe('block/RFQ — missing size/price/expiry refuse', () => {
  it('refuses blank size — never invents quantity', () => {
    for (const raw of ['', '   ', null, undefined] as const) {
      try {
        parseRequiredSize(raw);
        expect.unreachable('must refuse blank size');
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_missing_size');
      }
    }
  });

  it('refuses blank price — never invents a mid', () => {
    for (const raw of ['', '   ', null, undefined] as const) {
      try {
        parseRequiredPrice(raw);
        expect.unreachable('must refuse blank price');
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_missing_price');
      }
    }
  });

  it('refuses blank expiry — never invents a TTL', () => {
    for (const raw of ['', '   ', null, undefined] as const) {
      try {
        parseRequiredExpiry(raw, NOW);
        expect.unreachable('must refuse blank expiry');
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_missing_expiry');
      }
    }
  });
});

describe('block/RFQ — last look / not-firm refuse', () => {
  it('unlabeled firmness is undisclosed last look — named refuse, never silent firm', () => {
    for (const firmness of ['', '   ', null, undefined] as const) {
      try {
        parseRequiredFirmness({ firmness });
        expect.unreachable('must refuse undisclosed last look');
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_last_look_forbidden');
        expect((err as BlockRfqError).residual).toBe(RFQ_LAST_LOOK_RESIDUAL);
      }
    }
  });

  it('last look and not-firm-until-expiry refuse with the named code', () => {
    const cases = [
      { firmness: 'firm', lastLook: true },
      { firmness: 'firm', lastLook: 'undisclosed' },
      { firmness: 'firm', lastLook: 'last-look' },
      { firmness: 'indicative' },
      { firmness: 'last_look' },
      { firmness: 'subject_to_last_look' },
    ] as const;
    for (const input of cases) {
      try {
        parseRequiredFirmness(input);
        expect.unreachable(`must refuse ${JSON.stringify(input)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_last_look_forbidden');
      }
    }
  });

  it('quote lastLook / indicative refuses — never posts a non-firm quote', async () => {
    await expect(service().quote(maker, quoteBody({ lastLook: true }))).rejects.toMatchObject({
      code: 'p2p.rfq_last_look_forbidden',
    });
    await expect(service().quote(maker, quoteBody({ firmness: 'indicative' }))).rejects.toMatchObject({
      code: 'p2p.rfq_last_look_forbidden',
    });
    await expect(service().quote(maker, quoteBody({ firmness: undefined }))).rejects.toMatchObject({
      code: 'p2p.rfq_last_look_forbidden',
    });
  });
});

describe('block/RFQ — capacity must be labeled', () => {
  it('blank or invented house labels refuse — never invent principal', () => {
    for (const raw of ['', '   ', null, undefined, 'house', 'platform', 'dealer', 'internal'] as const) {
      try {
        parseRequiredCapacity(raw);
        expect.unreachable(`must refuse unlabeled capacity ${String(raw)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_unlabeled_capacity');
        expect((err as BlockRfqError).residual).toBe(RFQ_UNLABELED_CAPACITY_RESIDUAL);
      }
    }
  });

  it('principal, matched-principal and agency are labeled on the quote', async () => {
    const principalQ = await service().quote(maker, quoteBody());
    expect(principalQ.capacity).toBe('principal');
    expect(principalQ.firmness).toBe('firm');
    expect(principalQ.lastLook).toBe(false);

    const matched = await service().quote(maker, quoteBody({ capacity: 'matched-principal' }));
    expect(matched.capacity).toBe('matched_principal');

    const agency = await service().quote(maker, quoteBody({ capacity: 'agency' }));
    expect(agency.capacity).toBe('agency');
  });

  it('quote without capacity refuses rather than inventing the house model', async () => {
    await expect(service().quote(maker, quoteBody({ capacity: undefined }))).rejects.toMatchObject({
      code: 'p2p.rfq_unlabeled_capacity',
    });
  });
});

describe('block/RFQ — quote / accept / expire', () => {
  it('quotes exact decimal strings and is not a book fill', async () => {
    const quoted = await service().quote(
      maker,
      quoteBody({
        size: '100.50',
        price: '1.02',
      }),
    );
    expect(quoted.size).toBe('100.5');
    expect(quoted.price).toBe('1.02');
    expect(quoted.notional).toBe('102.51');
    expect(quoted.lifecycle).toBe('open');
    expect(quoted.bookFill).toBe(false);
    expect(quoted.midInvented).toBe(false);
    expect(quoted.lastLook).toBe(false);
    expect(quoted.capacity).toBe('principal');
    expect(quoted.firmness).toBe('firm');
    expect(quoted.expiresAt).toBe(new Date(EXPIRY).toISOString());
  });

  it('accept binds the quoted price — last look on a different price refuses', async () => {
    const svc = service();
    const quoted = await svc.quote(maker, quoteBody({ size: '10', price: '1.05' }));
    await expect(svc.accept(taker, { quoteId: quoted.quoteId, assertedPrice: '1.04' })).rejects.toMatchObject({
      code: 'p2p.rfq_last_look_forbidden',
    });
    const bound = await svc.accept(taker, { quoteId: quoted.quoteId, assertedPrice: '1.05' });
    expect(bound.lifecycle).toBe('bound');
    expect(bound.fillPrice).toBe('1.05');
    expect(bound.bookFill).toBe(false);
    expect(bound.lastLook).toBe(false);
    const again = await svc.accept(taker, { quoteId: quoted.quoteId });
    expect(again.acceptedAt).toBe(bound.acceptedAt);
  });

  it('clock-expired accept refuses rather than requote', async () => {
    const store = new MemoryBlockQuoteStore();
    const open = new BlockRfqService(store, { now: () => NOW });
    const quoted = await open.quote(maker, quoteBody({ side: 'buy', size: '5', price: '1' }));
    const later = new BlockRfqService(store, { now: () => new Date('2026-08-26T12:06:00.000Z') });
    await expect(later.accept(taker, { quoteId: quoted.quoteId })).rejects.toMatchObject({ code: 'p2p.rfq_expired' });
  });

  it('expire then accept refuses — not a book fill and not a requote', async () => {
    const svc = service();
    const quoted = await svc.quote(maker, quoteBody({ size: '8', price: '1.01' }));
    const expired = await svc.expire(maker, { quoteId: quoted.quoteId });
    expect(expired.lifecycle).toBe('expired');
    expect(expired.bookFill).toBe(false);
    await expect(svc.accept(taker, { quoteId: quoted.quoteId })).rejects.toMatchObject({ code: 'p2p.rfq_expired' });
  });

  it('stranger cannot accept; maker cannot accept their own quote', async () => {
    const svc = service();
    const quoted = await svc.quote(maker, quoteBody());
    const missing = await svc.accept(stranger, { quoteId: 'missing-quote' }).catch((err: unknown) => err);
    const foreign = await svc.accept(stranger, { quoteId: quoted.quoteId }).catch((err: unknown) => err);
    expect(foreign).toMatchObject({ code: 'p2p.rfq_not_found', message: 'Block/RFQ quote not found' });
    expect(missing).toMatchObject({ code: 'p2p.rfq_not_found', message: 'Block/RFQ quote not found' });
    await expect(svc.accept(maker, { quoteId: quoted.quoteId })).rejects.toMatchObject({ code: 'p2p.rfq_not_a_party' });
    await expect(svc.expire(stranger, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'p2p.rfq_not_found',
      message: 'Block/RFQ quote not found',
    });
  });

  it('self-quote refuses', async () => {
    await expect(service().quote(maker, quoteBody({ takerId: MAKER }))).rejects.toMatchObject({ code: 'p2p.rfq_self_trade' });
  });

  it('bound quote cannot expire into a book unwind', async () => {
    const quote = {
      quoteId: 'q',
      makerId: MAKER,
      takerId: TAKER,
      side: 'sell' as const,
      asset: 'USDT',
      fiatCurrency: 'USD',
      size: parseAmount('1'),
      price: parseAmount('1'),
      notional: parseAmount('1'),
      createdAt: NOW.toISOString(),
      expiresAt: EXPIRY,
      lifecycle: 'bound' as const,
      acceptedAt: NOW.toISOString(),
      fillPrice: parseAmount('1'),
      capacity: 'principal' as const,
      firmness: 'firm' as const,
      bookFill: false as const,
    };
    expect(() => expireBlockQuote({ quote, now: NOW })).toThrow(BlockRfqError);
    expect(presentBlockQuote(acceptBlockQuote({ quote, now: NOW })).bookFill).toBe(false);
    expect(presentBlockQuote(quote).lastLook).toBe(false);
  });
});

describe('block/RFQ — unnamed receiving account refuses', () => {
  it('blank receiving account refuses — never invents maker, taker, house or omnibus', () => {
    for (const raw of ['', '   ', null, undefined] as const) {
      try {
        parseNamedReceivingAccount(raw);
        expect.unreachable('must refuse unnamed receiving account');
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_unnamed_receiving_account');
        expect((err as BlockRfqError).residual).toBe(RFQ_UNNAMED_RECEIVING_RESIDUAL);
      }
    }
  });

  it('allocate without a named receiving account refuses — never invents a destination', () => {
    const svc = service();
    for (const input of [
      { quoteId: '00000000-0000-4000-8000-000000000001' },
      { quoteId: '00000000-0000-4000-8000-000000000001', allocations: [] },
      { quoteId: '00000000-0000-4000-8000-000000000001', allocations: [{ receivingAccount: '   ' }] },
      { quoteId: '00000000-0000-4000-8000-000000000001', allocations: [{ receivingAccount: null }] },
    ] as const) {
      try {
        svc.allocate(taker, input);
        expect.unreachable('must refuse unnamed allocation');
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_unnamed_receiving_account');
        expect((err as BlockRfqError).residual).toBe(RFQ_UNNAMED_RECEIVING_RESIDUAL);
      }
    }
  });

  it('give-up without a named receiving account refuses — never invents a carrying plug', () => {
    const svc = service();
    for (const receivingAccount of [undefined, '', '   ', null] as const) {
      try {
        svc.giveUp(taker, { quoteId: '00000000-0000-4000-8000-000000000001', receivingAccount });
        expect.unreachable('must refuse unnamed give-up');
      } catch (err) {
        expect(err).toBeInstanceOf(BlockRfqError);
        expect((err as BlockRfqError).code).toBe('p2p.rfq_unnamed_receiving_account');
        expect((err as BlockRfqError).residual).toBe(RFQ_UNNAMED_RECEIVING_RESIDUAL);
      }
    }
  });
});

describe('block/RFQ — allocation / give-up refuse-closed', () => {
  it('named allocation still refuses — never invents a split', async () => {
    const svc = service();
    const quoted = await svc.quote(maker, quoteBody());
    try {
      svc.allocate(taker, {
        quoteId: quoted.quoteId,
        allocations: [{ receivingAccount: 'fund-a' }],
      });
      expect.unreachable('must refuse allocation');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockRfqError);
      expect((err as BlockRfqError).code).toBe('p2p.rfq_allocation_refused');
      expect((err as BlockRfqError).residual).toBe(RFQ_ALLOCATION_RESIDUAL);
    }
  });

  it('named give-up still refuses — never invents a clearing map', () => {
    const svc = service();
    try {
      svc.giveUp(taker, {
        quoteId: '00000000-0000-4000-8000-000000000001',
        receivingAccount: 'carrying-1',
      });
      expect.unreachable('must refuse give-up');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockRfqError);
      expect((err as BlockRfqError).code).toBe('p2p.rfq_give_up_refused');
      expect((err as BlockRfqError).residual).toBe(RFQ_GIVE_UP_RESIDUAL);
    }
  });
});
