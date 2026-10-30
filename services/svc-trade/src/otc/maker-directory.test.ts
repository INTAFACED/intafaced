/**
 * CB-otc-01 — liquidity-provider directory and multi-select.
 * Provider ids, names and the cap below are TEST fixtures, not an owner directory.
 */
import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { OtcError, type OtcErrorCode } from './errors.js';
import { FixedOtcStake } from './stake-source.js';
import { createObservedOtcMidSource } from './mid-source.js';
import {
  listOtcMakers,
  loadOtcMakerDirectory,
  OTC_MAKERS_UNSET_RESIDUAL,
  parseOtcMakerDirectoryJson,
  selectOtcMakers,
  UNPUBLISHED_OTC_MAKER_DIRECTORY,
} from './maker-directory.js';
import { OTC_MAKER_ROUTING_RESIDUAL } from './maker-routing.js';
import { MemoryOtcQuoteStore } from './quote-store.js';

const TEST_DIRECTORY_JSON = JSON.stringify({
  selectCap: 3,
  makers: [
    { id: 'test-lp-a', name: 'TEST LP A', route: 'platform' },
    { id: 'test-lp-b', name: 'TEST LP B', route: 'platform' },
    { id: 'test-lp-c', name: 'TEST LP C', route: 'platform' },
    { id: 'test-lp-d', name: 'TEST LP D', route: 'platform' },
    { id: 'test-lp-out', name: 'TEST outside LP', route: 'outside' },
  ],
});

function codeOf(fn: () => unknown): OtcErrorCode {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OtcError);
    return (err as OtcError).code;
  }
  throw new Error('expected a refusal');
}

describe('parseOtcMakerDirectoryJson', () => {
  it('blank is the unpublished empty state, not a refusal at boot', () => {
    expect(parseOtcMakerDirectoryJson('')).toEqual({ published: false });
    expect(parseOtcMakerDirectoryJson('   ')).toEqual({ published: false });
    expect(parseOtcMakerDirectoryJson(undefined)).toEqual({ published: false });
  });

  it('parses a published directory', () => {
    const dir = parseOtcMakerDirectoryJson(TEST_DIRECTORY_JSON);
    expect(dir.published).toBe(true);
    if (dir.published) {
      expect(dir.selectCap).toBe(3);
      expect(dir.makers.map((m) => m.id)).toEqual(['test-lp-a', 'test-lp-b', 'test-lp-c', 'test-lp-d', 'test-lp-out']);
    }
  });

  it.each([
    ['not json', '{'],
    ['array', '[]'],
    ['missing cap', JSON.stringify({ makers: [{ id: 'a', name: 'A', route: 'platform' }] })],
    ['zero cap', JSON.stringify({ selectCap: 0, makers: [{ id: 'a', name: 'A', route: 'platform' }] })],
    ['fractional cap', JSON.stringify({ selectCap: 1.5, makers: [{ id: 'a', name: 'A', route: 'platform' }] })],
    ['string cap', JSON.stringify({ selectCap: '3', makers: [{ id: 'a', name: 'A', route: 'platform' }] })],
    ['empty makers', JSON.stringify({ selectCap: 3, makers: [] })],
    ['unknown top-level field', JSON.stringify({ selectCap: 3, makers: [{ id: 'a', name: 'A', route: 'platform' }], spread: 5 })],
    ['unknown provider field', JSON.stringify({ selectCap: 3, makers: [{ id: 'a', name: 'A', route: 'platform', price: '1' }] })],
    ['blank id', JSON.stringify({ selectCap: 3, makers: [{ id: ' ', name: 'A', route: 'platform' }] })],
    ['blank name', JSON.stringify({ selectCap: 3, makers: [{ id: 'a', name: '', route: 'platform' }] })],
    ['bad route', JSON.stringify({ selectCap: 3, makers: [{ id: 'a', name: 'A', route: 'venue' }] })],
    [
      'duplicate id',
      JSON.stringify({
        selectCap: 3,
        makers: [
          { id: 'a', name: 'A', route: 'platform' },
          { id: 'a', name: 'B', route: 'platform' },
        ],
      }),
    ],
  ])('refuses %s with trade.otc_makers_unset', (_label, raw) => {
    expect(codeOf(() => parseOtcMakerDirectoryJson(raw))).toBe('trade.otc_makers_unset');
  });
});

describe('listOtcMakers', () => {
  it('blank list shows "No providers set" and no providers', () => {
    expect(listOtcMakers(UNPUBLISHED_OTC_MAKER_DIRECTORY)).toEqual({
      published: false,
      makers: [],
      selectCap: null,
      emptyLabel: OTC_MAKERS_UNSET_RESIDUAL,
    });
    expect(OTC_MAKERS_UNSET_RESIDUAL).toBe('No providers set');
  });

  it('published list returns the owner providers and cap', () => {
    const out = listOtcMakers(parseOtcMakerDirectoryJson(TEST_DIRECTORY_JSON));
    expect(out.published).toBe(true);
    expect(out.selectCap).toBe(3);
    expect(out.emptyLabel).toBeNull();
    expect(out.makers).toHaveLength(5);
  });
});

describe('selectOtcMakers', () => {
  const dir = parseOtcMakerDirectoryJson(TEST_DIRECTORY_JSON);

  it('blank provider list refuses the request', () => {
    expect(codeOf(() => selectOtcMakers(UNPUBLISHED_OTC_MAKER_DIRECTORY, ['test-lp-a']))).toBe('trade.otc_makers_unset');
  });

  it('accepts up to the cap', () => {
    expect(selectOtcMakers(dir, ['test-lp-a', 'test-lp-b', 'test-lp-c']).map((m) => m.id)).toEqual(['test-lp-a', 'test-lp-b', 'test-lp-c']);
  });

  it('4 providers with a cap of 3 refuses trade.otc_provider_cap', () => {
    expect(codeOf(() => selectOtcMakers(dir, ['test-lp-a', 'test-lp-b', 'test-lp-c', 'test-lp-d']))).toBe('trade.otc_provider_cap');
  });

  it('an empty or blank pick refuses', () => {
    expect(codeOf(() => selectOtcMakers(dir, []))).toBe('trade.otc_provider_required');
    expect(codeOf(() => selectOtcMakers(dir, ['  ']))).toBe('trade.otc_provider_required');
  });

  it('a duplicate pick refuses', () => {
    expect(codeOf(() => selectOtcMakers(dir, ['test-lp-a', 'test-lp-a']))).toBe('trade.otc_provider_required');
  });

  it('an unknown provider refuses', () => {
    expect(codeOf(() => selectOtcMakers(dir, ['not-listed']))).toBe('trade.otc_provider_unknown');
  });

  it('an outside provider refuses by name through maker routing', () => {
    try {
      selectOtcMakers(dir, ['test-lp-a', 'test-lp-out']);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(OtcError);
      expect((err as OtcError).code).toBe('feed.market');
      expect((err as OtcError).message).toContain('socket.otc-maker-routing');
      expect((err as OtcError).residual).toBe(OTC_MAKER_ROUTING_RESIDUAL);
    }
  });
});

describe('OtcDeskService provider directory', () => {
  it('defaults to the empty state and refuses a pick', () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')));
    expect(svc.listMakers().emptyLabel).toBe('No providers set');
    expect(codeOf(() => svc.selectMakers(['test-lp-a']))).toBe('trade.otc_makers_unset');
  });

  it('uses the injected owner directory', () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')), {
      makerDirectory: parseOtcMakerDirectoryJson(TEST_DIRECTORY_JSON),
    });
    expect(svc.listMakers().makers).toHaveLength(5);
    expect(svc.selectMakers(['test-lp-b'])).toEqual({
      makers: [{ id: 'test-lp-b', name: 'TEST LP B', route: 'platform' }],
      selectCap: 3,
    });
    expect(codeOf(() => svc.selectMakers(['test-lp-a', 'test-lp-b', 'test-lp-c', 'test-lp-d']))).toBe('trade.otc_provider_cap');
  });
});

describe('loadOtcMakerDirectory', () => {
  it('a malformed directory is logged and leaves the refusing empty state instead of stopping boot', () => {
    const logged: string[] = [];
    const dir = loadOtcMakerDirectory('{', (m) => logged.push(m));
    expect(dir).toEqual({ published: false });
    expect(logged).toHaveLength(1);
    expect(codeOf(() => selectOtcMakers(dir, ['test-lp-a']))).toBe('trade.otc_makers_unset');
  });

  it('a valid directory loads without logging', () => {
    const logged: string[] = [];
    expect(loadOtcMakerDirectory(TEST_DIRECTORY_JSON, (m) => logged.push(m)).published).toBe(true);
    expect(logged).toEqual([]);
  });
});

describe('OtcDeskService.quote in maker mode (CB-otc-01 request path)', () => {
  const now = () => new Date('2026-10-22T03:00:00.000Z');
  const TEST_MAKER_LAW = {
    published: true as const,
    spreadBps: 50,
    minStake: parseAmount('500'),
    counterparty: 'maker' as const,
    quoteTtlMs: 60_000,
    maxMidAgeSeconds: 60,
    // A zero desk minimum is an owner value: these quotes are not held by the CB-otc-07 minimum.
    minNotional: { USDT: 0n },
    assets: ['BTC'],
    minTier: 'basic' as const,
  };
  const principal = { userId: '00000000-0000-4000-8000-000000000001', tier: 'basic' } as import('@intafaced/auth').Principal;
  const req = (makerId: string) => ({ side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerId });
  const svc = (directoryJson: string) =>
    new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('9999')), {
      law: TEST_MAKER_LAW,
      midSource: createObservedOtcMidSource('BTC/USDT:200', now),
      makerDirectory: parseOtcMakerDirectoryJson(directoryJson),
      now,
    });

  it('a blank provider list refuses the request', async () => {
    await expect(svc('').quote(principal, req('test-lp-a'))).rejects.toMatchObject({ code: 'trade.otc_makers_unset' });
  });

  it('a blank makerId with a blank provider list refuses otc_makers_unset', async () => {
    await expect(svc('').quote(principal, req(''))).rejects.toMatchObject({ code: 'trade.otc_makers_unset' });
    await expect(svc('').quote(principal, req('   '))).rejects.toMatchObject({ code: 'trade.otc_makers_unset' });
  });

  it('a blank makerId with a published list refuses otc_provider_required', async () => {
    await expect(svc(TEST_DIRECTORY_JSON).quote(principal, req(''))).rejects.toMatchObject({ code: 'trade.otc_provider_required' });
  });

  it('a free-text maker not on the list refuses', async () => {
    await expect(svc(TEST_DIRECTORY_JSON).quote(principal, req('anyone'))).rejects.toMatchObject({ code: 'trade.otc_provider_unknown' });
  });

  it('an outside provider refuses by name', async () => {
    await expect(svc(TEST_DIRECTORY_JSON).quote(principal, req('test-lp-out'))).rejects.toMatchObject({ code: 'feed.market' });
  });

  it('a desk request in maker mode is quoted by the one provider picked, and a makerId outside the pick refuses', async () => {
    const svcM = svc(TEST_DIRECTORY_JSON);
    const asked = { side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' };
    expect((await svcM.quote(principal, { ...asked, makerIds: ['test-lp-c'] })).counterpartyId).toBe('test-lp-c');
    await expect(svcM.quote(principal, { ...asked, makerIds: ['test-lp-a'], makerId: 'anyone' })).rejects.toMatchObject({
      code: 'trade.otc_provider_unknown',
    });
    await expect(svcM.quote(principal, { ...asked, makerIds: ['test-lp-a'], makerId: 'test-lp-b' })).rejects.toMatchObject({
      code: 'trade.otc_provider_unknown',
    });
  });

  it('two providers asked with none named to quote refuses naming the limit of one, before any stake read', async () => {
    let stakeReads = 0;
    const counted = new OtcDeskService(
      new MemoryLedger(),
      {
        stakeOf: async () => {
          stakeReads += 1;
          return parseAmount('9999');
        },
      },
      {
        law: TEST_MAKER_LAW,
        midSource: createObservedOtcMidSource('BTC/USDT:200', now),
        makerDirectory: parseOtcMakerDirectoryJson(TEST_DIRECTORY_JSON),
        now,
      },
    );
    const asked = { side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerIds: ['test-lp-b', 'test-lp-c'] };
    await expect(counted.quote(principal, asked)).rejects.toMatchObject({
      code: 'trade.otc_provider_cap',
      message: 'At most 1 provider can quote one request on this desk (got 2)',
    });
    await expect(counted.quote(principal, { ...asked, makerId: 'test-lp-a' })).rejects.toMatchObject({
      code: 'trade.otc_provider_unknown',
    });
    expect(stakeReads).toBe(0);
    expect((await counted.quote(principal, { ...asked, makerId: 'test-lp-c' })).counterpartyId).toBe('test-lp-c');
    expect(stakeReads).toBe(1);
  });

  it('a listed platform-routed provider is quoted as the counterparty', async () => {
    const q = await svc(TEST_DIRECTORY_JSON).quote(principal, req('test-lp-b'));
    expect(q.counterparty).toBe('maker');
    expect(q.counterpartyId).toBe('test-lp-b');
  });
});

describe('a desk request names its providers (CB-otc-01, platform counterparty)', () => {
  const now = () => new Date('2026-10-22T03:00:00.000Z');
  const TEST_PLATFORM_LAW = {
    published: true as const,
    spreadBps: 50,
    minStake: parseAmount('500'),
    counterparty: 'platform' as const,
    quoteTtlMs: 60_000,
    maxMidAgeSeconds: 60,
    // A zero desk minimum is an owner value: these quotes are not held by the CB-otc-07 minimum.
    minNotional: { USDT: 0n },
    assets: ['BTC'],
    minTier: 'basic' as const,
  };
  const principal = { userId: '00000000-0000-4000-8000-000000000001', tier: 'basic' } as import('@intafaced/auth').Principal;
  const req = (makerIds?: string[]) => ({ side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerIds });
  class CountingStore extends MemoryOtcQuoteStore {
    saved = 0;
    override async saveOpen(...args: Parameters<MemoryOtcQuoteStore['saveOpen']>) {
      this.saved += 1;
      return super.saveOpen(...args);
    }
  }
  const desk = (directoryJson: string) => {
    const store = new CountingStore();
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('9999')), {
      law: TEST_PLATFORM_LAW,
      midSource: createObservedOtcMidSource('BTC/USDT:200', now),
      makerDirectory: parseOtcMakerDirectoryJson(directoryJson),
      store,
      now,
    });
    return { svc, store };
  };

  it('with no provider list set, every request refuses "No providers set" and records nothing', async () => {
    const { svc, store } = desk('');
    for (const pick of [undefined, [], ['test-lp-a']]) {
      await expect(svc.quote(principal, req(pick))).rejects.toMatchObject({
        code: 'trade.otc_makers_unset',
        residual: OTC_MAKERS_UNSET_RESIDUAL,
      });
    }
    expect(store.saved).toBe(0);
  });

  it('four providers when the owner allows three refuses, naming the cap, and records nothing', async () => {
    const { svc, store } = desk(TEST_DIRECTORY_JSON);
    await expect(svc.quote(principal, req(['test-lp-a', 'test-lp-b', 'test-lp-c', 'test-lp-d']))).rejects.toMatchObject({
      code: 'trade.otc_provider_cap',
      message: 'At most 3 providers can be picked for one request (got 4)',
    });
    expect(store.saved).toBe(0);
  });

  it('a request with no pick, an unknown or an outside provider refuses by its own code', async () => {
    const { svc, store } = desk(TEST_DIRECTORY_JSON);
    await expect(svc.quote(principal, req())).rejects.toMatchObject({ code: 'trade.otc_provider_required' });
    await expect(svc.quote(principal, req(['anyone']))).rejects.toMatchObject({ code: 'trade.otc_provider_unknown' });
    await expect(svc.quote(principal, req(['test-lp-out']))).rejects.toMatchObject({ code: 'feed.market' });
    expect(store.saved).toBe(0);
  });

  it('up to the cap of listed platform providers is priced by the desk', async () => {
    const { svc, store } = desk(TEST_DIRECTORY_JSON);
    const q = await svc.quote(principal, req(['test-lp-a', 'test-lp-b', 'test-lp-c']));
    expect(q.counterparty).toBe('platform');
    expect(store.saved).toBe(1);
  });
});
