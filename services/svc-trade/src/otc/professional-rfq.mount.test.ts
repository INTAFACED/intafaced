import { OtcDeskService } from '../controls/test-admission.js';
/**
 * Professional RFQ doors on svc-trade — signed tRPC mount, not createCaller-only.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';

import { FixedOtcStake } from './stake-source.js';
import type { OtcDeskLaw } from './desk-law.js';
import { createObservedOtcMidSource } from './mid-source.js';

const SECRET = 'a-trade-rfq-mount-test-edge-secret-long';
const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

const published: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-trade-rfq',
  });
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'SG' }, id: 'req-anon' });

function otcDesk() {
  const now = new Date('2026-08-26T12:00:00.000Z');
  return new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
    law: published,
    midSource: createObservedOtcMidSource('BTC/USDT:200', () => now),
    now: () => now,
  });
}

describe('svc-trade mount — professional RFQ doors', () => {
  it('refuses anonymous quote/accept/expire', async () => {
    const caller = createTradeRouter({} as TradeService, otcDesk()).createCaller(anonymous());
    await expect(caller.rfq.quote({ side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.rfq.accept({ quoteId: '55555555-5555-4555-8555-555555555555' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.rfq.expire({ quoteId: '55555555-5555-4555-8555-555555555555' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a caller-supplied midPrice rather than quoting off it', async () => {
    const caller = createTradeRouter({} as TradeService, otcDesk()).createCaller(signed());
    await expect(
      caller.rfq.quote({
        side: 'buy',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: '1',
        midPrice: '999',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('quotes, accepts, expires with decimal strings and refuses allocation/give-up', async () => {
    const otc = otcDesk();
    const caller = createTradeRouter({} as TradeService, otc).createCaller(signed());
    const quoted = await caller.rfq.quote({ side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1.00' });
    expect(quoted.bookFill).toBe(false);
    expect(quoted.midInvented).toBe(false);
    expect(quoted.qty).toBe('1');
    expect(quoted.quotedPrice).toBe('201');
    expect(quoted.lifecycle).toBe('open');

    const bound = await caller.rfq.accept({ quoteId: quoted.quoteId, assertedPrice: '201' });
    expect(bound.lifecycle).toBe('bound');
    expect(bound.fillPrice).toBe('201');
    expect(bound.bookFill).toBe(false);

    await expect(caller.rfq.allocate({ quoteId: quoted.quoteId, allocations: [{ account: 'fund-a', size: '1' }] })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/refuse-closed/),
    });
    await expect(caller.rfq.giveUp({ quoteId: quoted.quoteId, carryingAccount: 'clearing-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/refuse-closed/),
    });

    const open = await caller.rfq.quote({ side: 'sell', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '2' });
    const expired = await caller.rfq.expire({ quoteId: open.quoteId });
    expect(expired.lifecycle).toBe('expired');
    await expect(caller.rfq.accept({ quoteId: open.quoteId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('unwired RFQ doors refuse rather than invent a quote', async () => {
    const caller = createTradeRouter({} as TradeService).createCaller(signed());
    await expect(caller.rfq.quote({ side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('blank size on the wire refuses rather than inventing quantity', async () => {
    const caller = createTradeRouter({} as TradeService, otcDesk()).createCaller(signed());
    await expect(caller.rfq.quote({ side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
