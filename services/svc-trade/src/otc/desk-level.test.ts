/**
 * CB-otc-08 — the lowest verification tier the desk prices for.
 * The tiers, asset, provider and numbers below are TEST fixtures, not an owner desk law.
 */
import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { otcDeskLawStatusLine, parseOtcDeskLawJson, type OtcDeskLaw, type OtcMinTier } from './desk-law.js';
import { OTC_DESK_LAW_RESIDUAL, OtcError } from './errors.js';
import { createObservedOtcMidSource } from './mid-source.js';
import { parseOtcMakerDirectoryJson } from './maker-directory.js';
import { parseOtcConvertBoundsJson } from './otc-convert-bounds.js';
import { MemoryOtcQuoteStore } from './quote-store.js';

const BASE = { published: true, spreadBps: 25, minStake: '1', counterparty: 'platform', quoteTtlMs: 15_000, maxMidAgeSeconds: 60 };
const parse = (extra: Record<string, unknown>) => parseOtcDeskLawJson(JSON.stringify({ ...BASE, ...extra }));

describe('desk verification level in the desk law (CB-otc-08)', () => {
  it('reads each owner tier', () => {
    for (const tier of ['basic', 'full', 'institutional']) {
      const law = parse({ minTier: tier });
      expect(law.published && law.minTier).toBe(tier);
    }
  });

  it('left out or null is blank, never a default level', () => {
    for (const law of [parse({}), parse({ minTier: null })]) {
      expect(law.published && law.minTier).toBeNull();
    }
  });

  it("'none', an unknown tier or a non-string refuses at boot with trade.otc_desk_law_blank", () => {
    for (const bad of ['none', 'Full', '', 2, ['full']]) {
      try {
        parse({ minTier: bad });
        expect.unreachable(`should refuse ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OtcError);
        expect((err as OtcError).code).toBe('trade.otc_desk_law_blank');
      }
    }
  });

  it('the status line names the level, and "unset" when it is blank', () => {
    expect(/(?:^| )minTier=(\S+)/.exec(otcDeskLawStatusLine(parse({ minTier: 'full' })))?.[1]).toBe('full');
    expect(/(?:^| )minTier=(\S+)/.exec(otcDeskLawStatusLine(parse({})))?.[1]).toBe('unset');
  });
});

describe('a quote is for a caller at the desk level or above (CB-otc-08)', () => {
  const now = () => new Date('2026-10-22T03:00:00.000Z');
  const at = (tier: Principal['tier'] | undefined) => ({ userId: '00000000-0000-4000-8000-000000000001', tier }) as Principal;
  const LAW: Extract<OtcDeskLaw, { published: true }> = {
    published: true,
    spreadBps: 50,
    minStake: parseAmount('500'),
    counterparty: 'platform',
    quoteTtlMs: 60_000,
    maxMidAgeSeconds: 60,
    // A zero desk minimum is an owner value: these quotes are not held by the CB-otc-07 minimum.
    minNotional: { USDT: 0n },
    assets: ['BTC'],
  };
  class CountingStore extends MemoryOtcQuoteStore {
    saved = 0;
    override async saveOpen(...args: Parameters<MemoryOtcQuoteStore['saveOpen']>) {
      this.saved += 1;
      return super.saveOpen(...args);
    }
  }
  const desk = (minTier: OtcMinTier | null | undefined) => {
    const store = new CountingStore();
    const counts = { stakeReads: 0 };
    const svc = new OtcDeskService(
      new MemoryLedger(),
      {
        stakeOf: async () => {
          counts.stakeReads += 1;
          return parseAmount('9999');
        },
      },
      {
        law: { ...LAW, minTier },
        midSource: createObservedOtcMidSource('BTC/USDT:200', now),
        makerDirectory: parseOtcMakerDirectoryJson(
          JSON.stringify({ selectCap: 1, makers: [{ id: 'house', name: 'TEST house desk', route: 'platform' }] }),
        ),
        // TEST convert bounds, so a convert reaches the level gate.
        convertBounds: parseOtcConvertBoundsJson(JSON.stringify({ convert: { minQty: '0.1', maxQty: '10' } })),
        store,
        now,
      },
    );
    return { svc, store, counts };
  };
  const req = { side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerIds: ['house'] };
  const convert = { flow: 'convert' as const, side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' };

  it('deskStatus publishes the level, and null with its blocker when it is blank', () => {
    expect(desk('full').svc.deskStatus()).toMatchObject({ minTier: 'full', residuals: { minTier: null } });
    expect(desk(null).svc.deskStatus()).toMatchObject({ minTier: null, residuals: { minTier: OTC_DESK_LAW_RESIDUAL } });
  });

  it('with the level blank every quote and convert refuses trade.otc_level_unset, before any stake read, and records nothing', async () => {
    for (const minTier of [null, undefined]) {
      const { svc, store, counts } = desk(minTier);
      await expect(svc.quote(at('institutional'), req)).rejects.toMatchObject({
        code: 'trade.otc_level_unset',
        residual: OTC_DESK_LAW_RESIDUAL,
      });
      await expect(svc.convertQuote(at('institutional'), convert)).rejects.toMatchObject({ code: 'trade.otc_level_unset' });
      expect(counts.stakeReads).toBe(0);
      expect(store.saved).toBe(0);
    }
  });

  it('a caller below the level refuses trade.otc_level_insufficient naming both tiers, before any stake read, and records nothing', async () => {
    const { svc, store, counts } = desk('full');
    for (const tier of ['none', 'basic'] as const) {
      await expect(svc.quote(at(tier), req)).rejects.toMatchObject({
        code: 'trade.otc_level_insufficient',
        message: `The desk prices for full verification and above. Your account is at ${tier}.`,
      });
      await expect(svc.convertQuote(at(tier), convert)).rejects.toMatchObject({ code: 'trade.otc_level_insufficient' });
    }
    // A principal that carries no tier is below every level, never let through.
    await expect(svc.quote(at(undefined), req)).rejects.toMatchObject({ code: 'trade.otc_level_insufficient' });
    expect(counts.stakeReads).toBe(0);
    expect(store.saved).toBe(0);
  });

  it('a convert below the level is refused on the level before its bounds are read, so no bound is named', async () => {
    const { svc } = desk('full');
    for (const qty of ['0.01', '1', '99']) {
      await expect(svc.convertQuote(at('basic'), { ...convert, qty })).rejects.toMatchObject({ code: 'trade.otc_level_insufficient' });
    }
    await expect(desk(null).svc.convertQuote(at('full'), { ...convert, qty: '99' })).rejects.toMatchObject({
      code: 'trade.otc_level_unset',
    });
  });

  it('a quote priced at the level cannot be bound once the caller is below it, and stays open', async () => {
    const { svc, store } = desk('full');
    const q = await svc.quote(at('full'), req);
    await expect(svc.accept(at('basic'), { quoteId: q.quoteId })).rejects.toMatchObject({ code: 'trade.otc_level_insufficient' });
    expect((await store.load(q.quoteId))?.lifecycle).toBe('open');
  });

  it('a caller at or above the level is priced', async () => {
    const { svc, store } = desk('full');
    expect((await svc.quote(at('full'), req)).baseAsset).toBe('BTC');
    expect((await svc.quote(at('institutional'), req)).baseAsset).toBe('BTC');
    expect(store.saved).toBe(2);
  });
});
