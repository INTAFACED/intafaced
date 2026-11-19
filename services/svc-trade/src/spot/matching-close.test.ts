import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchingUnavailableError } from './matching-client.js';
import { createMatchingClient, postClosePosition } from './matching-close.js';
import { createLifecycleAdmissionProof } from '../lifecycle-proof.js';
import { decideMarketAction } from '../market-lifecycle.js';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';

const SECRET = 'matching-close-test-secret-at-least-32-chars';
const MARKET = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.unstubAllGlobals();
});

function proof() {
  const observedAt = '2026-08-24T16:00:00.000Z';
  const snapshot: MarketStateSnapshot = {
    marketId: MARKET,
    ruleVersion: 'test.rules.v1',
    instrumentId: MARKET,
    instrumentVersion: 'test.instrument.v1',
    state: 'OPEN',
    reasonCategory: 'NORMAL',
    reasonCode: 'trade.lifecycle.ready',
    effectiveAt: observedAt,
    observedAt,
    lastGoodState: 'OPEN',
    allowedActions: ['PLACE'],
    transitionId: 'test.transition',
    evidenceRefs: ['test.evidence'],
  };
  const decision = decideMarketAction(snapshot, 'PLACE');
  if (decision.decision !== 'ELIGIBLE') throw new Error('fixture must admit PLACE');
  return createLifecycleAdmissionProof(snapshot, decision, 'PLACE');
}

describe('matching close HTTP', () => {
  it('POSTs /markets/:id/positions/close and does not invent a mark', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(
          JSON.stringify({
            accepted: false,
            sequence: null,
            fills: [],
            resting: null,
            rejected: { code: 'position_flat', message: 'account is flat on this book' },
            cancellations: [],
            triggered: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const client = createMatchingClient('http://matching:4005', SECRET);
    const result = await client.closePosition(MARKET, {
      orderId: '55555555-5555-4555-8555-555555555555',
      accountId: 'desk',
      lifecycleProof: proof(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://matching:4005/markets/${MARKET}/positions/close`);
    expect(calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).not.toHaveProperty('qty');
    expect(body).not.toHaveProperty('price');
    expect(body).not.toHaveProperty('side');
    expect(result.rejected?.code).toBe('position_flat');
  });

  it('postClosePosition is the same door', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ accepted: true, sequence: 1, fills: [], resting: null, rejected: null, cancellations: [], triggered: [] }),
            { status: 200 },
          ),
      ),
    );
    const result = await postClosePosition('http://matching:4005', SECRET, MARKET, {
      orderId: '55555555-5555-4555-8555-555555555555',
      accountId: 'desk',
      lifecycleProof: proof(),
    });
    expect(result.accepted).toBe(true);
  });

  it('GETs the signed net position the close is sized from, and reads a short as negative', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ marketId: MARKET, accountId: 'desk', qty: '-1.5' }), { status: 200 });
      }),
    );
    const net = await createMatchingClient('http://matching:4005', SECRET).netPosition(MARKET, 'desk');
    expect(calls[0]?.url).toBe(`http://matching:4005/markets/${MARKET}/positions/desk`);
    expect(calls[0]?.init.method).toBe('GET');
    expect(net).toBe(-1_500_000_000_000_000_000n);
  });

  it.each([
    ['a 5xx', () => new Response('boom', { status: 503 })],
    ['a body with no qty', () => new Response(JSON.stringify({ marketId: MARKET }), { status: 200 })],
    ['a qty that is not a decimal', () => new Response(JSON.stringify({ qty: 'lots' }), { status: 200 })],
  ])('%s is matching unavailable, never a flat position', async (_name, reply) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply()),
    );
    await expect(createMatchingClient('http://matching:4005', SECRET).netPosition(MARKET, 'desk')).rejects.toBeInstanceOf(
      MatchingUnavailableError,
    );
  });
});
