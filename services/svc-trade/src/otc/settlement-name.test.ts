/**
 * CB-otc-08's name match (J-copy-bots-otc-24 #3): a settlement name a desk request gives must be the verified name.
 * The names, tiers, asset, provider and numbers below are TEST fixtures, not an owner desk law.
 */
import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { IDENTITY_HOLDER_NAME_CHECK_PATH, SERVICE_HEADER } from '@intafaced/contracts';
import type { OtcDeskLaw } from './desk-law.js';
import { createObservedOtcMidSource } from './mid-source.js';
import { parseOtcMakerDirectoryJson } from './maker-directory.js';
import { MemoryOtcQuoteStore } from './quote-store.js';
import { createIdentitySettlementNameCheck, settlementNameOf, type OtcSettlementNameCheck } from './settlement-name.js';

const ADA = '00000000-0000-4000-8000-000000000001';
const VERIFIED = 'TEST Ada Lovelace';

describe('the identity client for the settlement name (CB-otc-08)', () => {
  const answering = (status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  const client = (fetchFn: typeof fetch) => createIdentitySettlementNameCheck('http://identity.test/', 's'.repeat(32), undefined, fetchFn);

  it("asks identity's own-name door as svc-trade, signed, with no redirect, and a match resolves", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    await expect(client(answering(200, { userId: ADA, outcome: 'match' }, seen)).assertOwnName(ADA, VERIFIED)).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`http://identity.test${IDENTITY_HOLDER_NAME_CHECK_PATH}`);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ userId: ADA, name: VERIFIED });
    expect((seen[0]!.init.headers as Record<string, string>)[SERVICE_HEADER]).toBe('svc-trade');
  });

  it('a mismatch refuses trade.otc_name_mismatch, and the message never carries the name given', async () => {
    const refused = client(answering(200, { userId: ADA, outcome: 'mismatch' })).assertOwnName(ADA, 'TEST Someone Else');
    await expect(refused).rejects.toMatchObject({ code: 'trade.otc_name_mismatch' });
    await refused.catch((err: Error) => expect(err.message).not.toContain('Someone Else'));
  });

  it('no verified name refuses trade.otc_name_unverified, never read as a match', async () => {
    await expect(client(answering(200, { userId: ADA, outcome: 'unverified' })).assertOwnName(ADA, VERIFIED)).rejects.toMatchObject({
      code: 'trade.otc_name_unverified',
    });
  });

  it('every answer that is not a clear match or mismatch refuses trade.otc_name_unverifiable', async () => {
    const cases: Array<typeof fetch> = [
      answering(200, { userId: ADA, outcome: 'inactive' }),
      answering(200, { userId: ADA, outcome: 'unconfigured' }),
      answering(403, { code: 'identity.forbidden' }),
      answering(503, { code: 'identity.holder_name_unavailable' }),
      answering(404, { code: 'identity.account_not_found' }),
      answering(200, { userId: ADA, outcome: 'yes' }),
      answering(200, { outcome: 'match' }),
      // An answer about another account is not an answer about this one.
      answering(200, { userId: '00000000-0000-4000-8000-000000000002', outcome: 'match' }),
      (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    ];
    for (const fetchFn of cases) {
      await expect(client(fetchFn).assertOwnName(ADA, VERIFIED)).rejects.toMatchObject({ code: 'trade.otc_name_unverifiable' });
    }
  });

  it('a blank name is no name; one over 200 characters refuses trade.otc_name_invalid', () => {
    expect(settlementNameOf(undefined)).toBeNull();
    expect(settlementNameOf('   ')).toBeNull();
    expect(settlementNameOf(`  ${VERIFIED} `)).toBe(VERIFIED);
    expect(() => settlementNameOf('x'.repeat(201))).toThrow(expect.objectContaining({ code: 'trade.otc_name_invalid' }));
  });
});

describe('a desk request naming a settlement account in another name prices nothing (CB-otc-08)', () => {
  const now = () => new Date('2026-10-22T03:00:00.000Z');
  const trader = { userId: ADA, tier: 'full' } as Principal;
  const LAW: Extract<OtcDeskLaw, { published: true }> = {
    published: true,
    spreadBps: 50,
    minStake: parseAmount('500'),
    counterparty: 'platform',
    quoteTtlMs: 60_000,
    maxMidAgeSeconds: 60,
    minNotional: { USDT: 0n },
    assets: ['BTC'],
    minTier: 'full',
  };
  class CountingStore extends MemoryOtcQuoteStore {
    saved = 0;
    override async saveOpenRequest(...args: Parameters<MemoryOtcQuoteStore['saveOpenRequest']>) {
      this.saved += 1;
      return super.saveOpenRequest(...args);
    }
  }
  /** A TEST stand-in for identity's answer: the verified name is VERIFIED; every check asked is recorded. */
  const identity = (asked: string[]): OtcSettlementNameCheck =>
    createIdentitySettlementNameCheck('http://identity.test', 's'.repeat(32), undefined, (async (_url: unknown, init?: RequestInit) => {
      const { userId, name } = JSON.parse(String(init?.body)) as { userId: string; name: string };
      asked.push(name);
      return new Response(JSON.stringify({ userId, outcome: name === VERIFIED ? 'match' : 'mismatch' }), { status: 200 });
    }) as typeof fetch);
  const desk = (settlementNames?: OtcSettlementNameCheck) => {
    const store = new CountingStore();
    const counts = { stakeReads: 0, midReads: 0 };
    const mids = createObservedOtcMidSource('BTC/USDT:200', now);
    const svc = new OtcDeskService(
      new MemoryLedger(),
      {
        stakeOf: async () => {
          counts.stakeReads += 1;
          return parseAmount('9999');
        },
      },
      {
        law: LAW,
        midSource: async (pair) => {
          counts.midReads += 1;
          return mids(pair);
        },
        makerDirectory: parseOtcMakerDirectoryJson(
          JSON.stringify({ selectCap: 1, makers: [{ id: 'house', name: 'TEST house desk', route: 'platform' }] }),
        ),
        store,
        now,
        ...(settlementNames ? { settlementNames } : {}),
      },
    );
    return { svc, store, counts };
  };
  const req = { side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerIds: ['house'] };

  it('deskStatus says whether the name check is wired', () => {
    expect(desk(identity([])).svc.deskStatus().settlementNameMatch).toBe(true);
    expect(desk().svc.deskStatus().settlementNameMatch).toBe(false);
  });

  it('a name other than the verified one refuses trade.otc_name_mismatch before any stake read or price, and records nothing', async () => {
    const asked: string[] = [];
    const { svc, store, counts } = desk(identity(asked));
    await expect(svc.rfqQuote(trader, { ...req, settlementName: 'TEST Someone Else' })).rejects.toMatchObject({
      code: 'trade.otc_name_mismatch',
    });
    expect(asked).toEqual(['TEST Someone Else']);
    expect(counts).toEqual({ stakeReads: 0, midReads: 0 });
    expect(store.saved).toBe(0);
  });

  it('the verified name, or no name, is priced as before', async () => {
    const asked: string[] = [];
    const { svc, store } = desk(identity(asked));
    const named = await svc.rfqQuote(trader, { ...req, settlementName: ` ${VERIFIED} ` });
    expect(named.quoteId).toBeTruthy();
    const plain = await svc.rfqQuote(trader, req);
    expect(plain.quoteId).toBeTruthy();
    // Only the request that named an account asked identity, trimmed.
    expect(asked).toEqual([VERIFIED]);
    expect(store.saved).toBe(2);
  });

  it('the level still refuses first: a caller below it never has a name checked', async () => {
    const asked: string[] = [];
    const { svc } = desk(identity(asked));
    await expect(
      svc.rfqQuote({ ...trader, tier: 'basic' } as Principal, { ...req, settlementName: 'TEST Someone Else' }),
    ).rejects.toMatchObject({
      code: 'trade.otc_level_insufficient',
    });
    expect(asked).toEqual([]);
  });

  it('with no identity wired, a request naming an account refuses trade.otc_name_unverifiable and records nothing', async () => {
    const { svc, store, counts } = desk();
    await expect(svc.rfqQuote(trader, { ...req, settlementName: VERIFIED })).rejects.toMatchObject({
      code: 'trade.otc_name_unverifiable',
    });
    expect(counts.stakeReads).toBe(0);
    expect(store.saved).toBe(0);
    // A request that names no account is not refused by the missing wire.
    expect((await svc.rfqQuote(trader, req)).quoteId).toBeTruthy();
  });
});
