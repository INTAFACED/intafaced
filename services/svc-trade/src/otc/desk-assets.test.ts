/**
 * CB-otc-11 — the base assets the desk quotes, as the overview lists them.
 * The asset ids, provider and numbers below are TEST fixtures, not an owner desk law.
 */
import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { otcDeskLawStatusLine, parseOtcDeskLawJson, type OtcDeskLaw } from './desk-law.js';
import { OTC_DESK_LAW_RESIDUAL, OtcError } from './errors.js';
import { createObservedOtcMidSource } from './mid-source.js';
import { parseOtcMakerDirectoryJson } from './maker-directory.js';
import { parseOtcConvertBoundsJson } from './otc-convert-bounds.js';
import { MemoryOtcQuoteStore } from './quote-store.js';

const BASE = { published: true, spreadBps: 25, minStake: '1', counterparty: 'platform', quoteTtlMs: 15_000, maxMidAgeSeconds: 60 };
const parse = (extra: Record<string, unknown>) => parseOtcDeskLawJson(JSON.stringify({ ...BASE, ...extra }));

describe('desk asset list in the desk law (CB-otc-11)', () => {
  it('reads each asset upper-cased, in the order published', () => {
    const law = parse({ assets: [' btc', 'ETH'] });
    expect(law.published && law.assets).toEqual(['BTC', 'ETH']);
  });

  it('left out or null is blank, never a default list', () => {
    for (const law of [parse({}), parse({ assets: null })]) {
      expect(law.published && law.assets).toBeNull();
    }
  });

  it('a malformed list refuses at boot with trade.otc_desk_law_blank', () => {
    for (const bad of ['BTC', [], [''], ['BTC/USDT'], [1], ['BTC', 'btc'], [null], ['X'.repeat(33)]]) {
      try {
        parse({ assets: bad });
        expect.unreachable(`should refuse ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OtcError);
        expect((err as OtcError).code).toBe('trade.otc_desk_law_blank');
        expect((err as OtcError).residual).toBe(OTC_DESK_LAW_RESIDUAL);
      }
    }
  });

  it('the status line names the list, and "unset" when it is blank', () => {
    expect(/(?:^| )assets=(\S+)/.exec(otcDeskLawStatusLine(parse({ assets: ['BTC', 'ETH'] })))?.[1]).toBe('BTC,ETH');
    expect(/(?:^| )assets=(\S+)/.exec(otcDeskLawStatusLine(parse({})))?.[1]).toBe('unset');
  });
});

describe('a desk request is for an asset on the list (CB-otc-11)', () => {
  const now = () => new Date('2026-10-22T03:00:00.000Z');
  const principal = { userId: '00000000-0000-4000-8000-000000000001' } as Principal;
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
  const desk = (assets: readonly string[] | null | undefined) => {
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
        law: { ...LAW, assets },
        // ETH has a mid too, so an unlisted ETH request is refused by the list, not by a missing price.
        midSource: createObservedOtcMidSource('BTC/USDT:200,ETH/USDT:10', now),
        makerDirectory: parseOtcMakerDirectoryJson(
          JSON.stringify({ selectCap: 1, makers: [{ id: 'house', name: 'TEST house desk', route: 'platform' }] }),
        ),
        // TEST convert bounds, so a convert reaches the asset list.
        convertBounds: parseOtcConvertBoundsJson(JSON.stringify({ convert: { minQty: '0.1', maxQty: '10' } })),
        store,
        now,
      },
    );
    return { svc, store, counts };
  };
  const req = (baseAsset: string) => ({ side: 'buy' as const, baseAsset, quoteAsset: 'USDT', qty: '1', makerIds: ['house'] });

  it('deskStatus publishes the list, and null when it is blank', () => {
    expect(desk(['BTC', 'ETH']).svc.deskStatus().assets).toEqual(['BTC', 'ETH']);
    expect(desk(null).svc.deskStatus().assets).toBeNull();
    expect(desk(undefined).svc.deskStatus().assets).toBeNull();
  });

  it('with the list blank every desk request refuses trade.otc_assets_unset, before any stake read, and records nothing', async () => {
    for (const assets of [null, undefined, []]) {
      const { svc, store, counts } = desk(assets);
      for (const base of ['BTC', 'ETH']) {
        await expect(svc.quote(principal, req(base))).rejects.toMatchObject({ code: 'trade.otc_assets_unset' });
      }
      expect(counts.stakeReads).toBe(0);
      expect(store.saved).toBe(0);
    }
  });

  it('an asset not on the list refuses trade.otc_asset_unlisted naming the list, before any stake read, and records nothing', async () => {
    const { svc, store, counts } = desk(['BTC']);
    await expect(svc.quote(principal, req('eth'))).rejects.toMatchObject({
      code: 'trade.otc_asset_unlisted',
      message: "ETH is not on the desk's asset list (BTC)",
    });
    expect(counts.stakeReads).toBe(0);
    expect(store.saved).toBe(0);
    // The listed asset is priced, case-insensitively, against the same desk.
    const q = await svc.quote(principal, req('btc'));
    expect(q.baseAsset).toBe('BTC');
    expect(store.saved).toBe(1);
  });

  it('a convert is held to the same list: blank refuses trade.otc_assets_unset, an unlisted asset trade.otc_asset_unlisted', async () => {
    const convert = (baseAsset: string) => ({ flow: 'convert' as const, side: 'buy' as const, baseAsset, quoteAsset: 'USDT', qty: '1' });
    const blank = desk(null);
    await expect(blank.svc.convertQuote(principal, convert('BTC'))).rejects.toMatchObject({ code: 'trade.otc_assets_unset' });
    const listed = desk(['BTC']);
    await expect(listed.svc.convertQuote(principal, convert('ETH'))).rejects.toMatchObject({ code: 'trade.otc_asset_unlisted' });
    expect(blank.counts.stakeReads + listed.counts.stakeReads).toBe(0);
    expect(blank.store.saved + listed.store.saved).toBe(0);
    expect((await listed.svc.convertQuote(principal, convert('BTC'))).baseAsset).toBe('BTC');
  });

  it('an unusable asset id is refused as no usable pair, not as an unlisted asset', async () => {
    const { svc, store } = desk(['BTC']);
    await expect(svc.quote(principal, req('BTC/USDT'))).rejects.toMatchObject({ code: 'trade.otc_no_reference_price' });
    expect(store.saved).toBe(0);
  });

  it('a blank list names the desk law as its blocker, in deskStatus and on the refusal', async () => {
    const { svc } = desk(null);
    expect(svc.deskStatus().residuals.assets).toBe(OTC_DESK_LAW_RESIDUAL);
    expect(desk(['BTC']).svc.deskStatus().residuals.assets).toBeNull();
    await expect(svc.quote(principal, req('BTC'))).rejects.toMatchObject({ residual: OTC_DESK_LAW_RESIDUAL });
  });

  it('a long list is counted in the refusal, not spelled out', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `T${i}`);
    await expect(desk(many).svc.quote(principal, req('ETH'))).rejects.toMatchObject({
      message: "ETH is not on the desk's asset list (11 assets)",
    });
  });
});
