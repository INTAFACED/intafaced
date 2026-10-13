import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  DEPTH_ENGINE_UNAVAILABLE,
  DEPTH_L3_UNAVAILABLE,
  DEPTH_BINARY_UNAVAILABLE,
  DEPTH_SBE_UNAVAILABLE,
  DEPTH_ENTITLEMENT_UNAUTHORIZED,
  DEPTH_PUSH_UNAVAILABLE,
  DEPTH_TRANSPORT_POLL,
  TRADES_TRANSPORT_PUSH,
  COD_LEASE_RANGE_UNCONFIGURED,
  DROP_COPY_COMMON_UPSTREAM_FAILURE,
  DROP_COPY_GAP,
  DROP_COPY_RECOVERY_REQUIRED,
  GATEWAY_COD_REFUSE_CODES,
  GATEWAY_DEPTH_REFUSE_CODES,
  GATEWAY_DROP_COPY_REFUSE_CODES,
  GATEWAY_PRIVATE_REFUSE_CODES,
  ORDERS_ENGINE_UNAVAILABLE,
  allowsConnectDepthSnapshot,
  describeGatewayPolicy,
  isPublicSbeL2Ask,
  marketDataFeedRefuse,
  writeMarketDataFeedRefuse,
  sbeL2EntitlementRefuse,
  wouldInventInitialEmptyLadder,
  wouldInventQuietMarketFromEngineDown,
  wouldInventTradableWhileMatchingClosed,
  DEPTH_MARKET_HALTED,
} from './gateway-policy.js';

const MARKET = 'BTC-USDT';

function emptySnapshot(marketId = MARKET) {
  return { type: 'snapshot' as const, marketId, sequence: 0, bids: [] as const, asks: [] as const };
}

function liveSnapshot(sequence: number, marketId = MARKET) {
  return {
    type: 'snapshot' as const,
    marketId,
    sequence,
    bids: [['100', '1']] as const,
    asks: [['101', '1']] as const,
  };
}

describe('describeGatewayPolicy', () => {
  it('states fan-out honesty without promising fake liquidity', () => {
    const p = describeGatewayPolicy();
    expect(p.emptyBookStaysEmpty).toBe(true);
    expect(p.emptyNotZeroOnWire).toBe(true);
    expect(p.noFakeDepth).toBe(true);
    expect(p.noSynthesizeL3FromL2).toBe(true);
    expect(p.noPretendJsonIsBinary).toBe(true);
    expect(p.l3FeedPublished).toBe(true);
    expect(p.binaryFeedPublished).toBe(true);
    expect(p.l2SbeFeedPublished).toBe(true);
    expect(p.depthTransport).toBe(DEPTH_TRANSPORT_POLL);
    expect(p.l3Transport).toBe(DEPTH_TRANSPORT_POLL);
    expect(p.tradesTransport).toBe(TRADES_TRANSPORT_PUSH);
    expect(p.privateTransport).toBe(TRADES_TRANSPORT_PUSH);
    expect(p.dropCopyTransport).toBe(TRADES_TRANSPORT_PUSH);
    expect(p.depthPush).toBe(false);
    expect(p.l3Push).toBe(false);
    expect(p.noInventMid).toBe(true);
    expect(p.noSeedFillsAsLiveTape).toBe(true);
    expect(p.engineDownNamesUnavailable).toBe(true);
    expect(p.matchingNotTradableNamed).toBe(true);
    expect(p.holeNotSyntheticEmptyBook).toBe(true);
    expect(p.refuseCodes).toEqual([...GATEWAY_DEPTH_REFUSE_CODES]);
    expect(p.refuseCodes).toContain(DEPTH_ENGINE_UNAVAILABLE);
    expect(p.refuseCodes).toContain(DEPTH_L3_UNAVAILABLE);
    expect(p.refuseCodes).toContain(DEPTH_BINARY_UNAVAILABLE);
    expect(p.refuseCodes).toContain(DEPTH_SBE_UNAVAILABLE);
    expect(p.refuseCodes).toContain(DEPTH_ENTITLEMENT_UNAUTHORIZED);
    expect(p.refuseCodes).toContain(DEPTH_PUSH_UNAVAILABLE);
    expect(p.refuseCodes).toContain(DEPTH_MARKET_HALTED);
    expect(p.privateRefuseCodes).toEqual([...GATEWAY_PRIVATE_REFUSE_CODES]);
    expect(p.privateRefuseCodes).toContain(ORDERS_ENGINE_UNAVAILABLE);
    expect(p.dropCopyIndependentOfTradingSession).toBe(true);
    expect(p.dropCopyReadOnly).toBe(true);
    expect(p.dropCopyReplayDurable).toBe(false);
    expect(p.dropCopyRefuseCodes).toEqual([...GATEWAY_DROP_COPY_REFUSE_CODES]);
    expect(p.dropCopyRefuseCodes).toEqual([DROP_COPY_RECOVERY_REQUIRED, DROP_COPY_COMMON_UPSTREAM_FAILURE, DROP_COPY_GAP]);
    expect(p.cancelOnDisconnectLease).toBe(true);
    expect(p.codClientClockIgnored).toBe(true);
    expect(p.codInventedMassSuccess).toBe(false);
    expect(p.codRefuseCodes).toEqual([...GATEWAY_COD_REFUSE_CODES]);
    expect(p.codRefuseCodes).toContain(COD_LEASE_RANGE_UNCONFIGURED);
    expect(p.inventsQuietMarket).toBe(false);
    expect(p.inventsFuturesPositions).toBe(false);
  });
});

describe('gateway policy enforcement', () => {
  it('allows connect snapshot only when resting depth exists or a prior book is being repaired', () => {
    expect(allowsConnectDepthSnapshot(true, false)).toBe(true);
    expect(allowsConnectDepthSnapshot(false, true)).toBe(true);
    expect(allowsConnectDepthSnapshot(false, false)).toBe(false);
  });

  it('detects initial priced empty ladders — empty book stays absent, not zero', () => {
    expect(wouldInventInitialEmptyLadder(emptySnapshot(), false)).toBe(true);
    expect(wouldInventInitialEmptyLadder(liveSnapshot(1), false)).toBe(false);
    expect(wouldInventInitialEmptyLadder(emptySnapshot(), true)).toBe(false);
  });

  it('detects engine-down masquerading as a quiet empty market', () => {
    expect(wouldInventQuietMarketFromEngineDown(true, false)).toBe(true);
    expect(wouldInventQuietMarketFromEngineDown(true, true)).toBe(false);
    expect(wouldInventQuietMarketFromEngineDown(false, false)).toBe(false);
  });

  it('detects a resting book on the wire while matching is not taking submits', () => {
    expect(wouldInventTradableWhileMatchingClosed(true, true)).toBe(true);
    expect(wouldInventTradableWhileMatchingClosed(true, false)).toBe(false);
    expect(wouldInventTradableWhileMatchingClosed(false, true)).toBe(false);
    expect(GATEWAY_DEPTH_REFUSE_CODES).toContain(DEPTH_MARKET_HALTED);
  });
});

describe('marketDataFeedRefuse', () => {
  function q(search: string): URLSearchParams {
    return new URLSearchParams(search);
  }

  it('leaves L2 depth and public trades alone', () => {
    expect(marketDataFeedRefuse(q(''))).toBeNull();
    expect(marketDataFeedRefuse(q('channel=depth'))).toBeNull();
    expect(marketDataFeedRefuse(q('channel=trades'))).toBeNull();
    expect(marketDataFeedRefuse(q('level=5'))).toBeNull();
    expect(marketDataFeedRefuse(q('level=20'))).toBeNull();
    expect(marketDataFeedRefuse(q('channel=orders'))).toBeNull();
  });

  it('names L3 / order-by-order / queue-position — never an L2 stand-in', () => {
    expect(marketDataFeedRefuse(q('channel=l3'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=order-by-order'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=queue-position'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=queue-probability'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('level=3'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('book=mbo'))).toBe(DEPTH_L3_UNAVAILABLE);
  });

  it('allows public native L3 JSON when the depth door opts in — still refuses probability and SBE L3', () => {
    expect(marketDataFeedRefuse(q('channel=l3'), { allowNativeL3: true })).toBeNull();
    expect(marketDataFeedRefuse(q('channel=order-by-order'), { allowNativeL3: true })).toBeNull();
    expect(marketDataFeedRefuse(q('channel=queue-position'), { allowNativeL3: true })).toBeNull();
    expect(marketDataFeedRefuse(q('level=3'), { allowNativeL3: true })).toBeNull();
    expect(marketDataFeedRefuse(q('book=mbo'), { allowNativeL3: true })).toBeNull();
    expect(marketDataFeedRefuse(q('channel=queue-probability'), { allowNativeL3: true })).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=l3&format=sbe'), { allowNativeL3: true, allowPublicSbeL2: true })).toBe(
      DEPTH_BINARY_UNAVAILABLE,
    );
  });

  it('names binary/SBE on private/default — never JSON-as-binary', () => {
    expect(marketDataFeedRefuse(q('format=sbe'))).toBe(DEPTH_BINARY_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('encoding=binary'))).toBe(DEPTH_BINARY_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=sbe'))).toBe(DEPTH_BINARY_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=depth&format=binary'))).toBe(DEPTH_BINARY_UNAVAILABLE);
  });

  it('allows public L2 SBE when the depth door opts in', () => {
    expect(marketDataFeedRefuse(q('format=sbe'), { allowPublicSbeL2: true })).toBeNull();
    expect(marketDataFeedRefuse(q('encoding=binary'), { allowPublicSbeL2: true })).toBeNull();
    expect(marketDataFeedRefuse(q('channel=depth&format=sbe'), { allowPublicSbeL2: true })).toBeNull();
    expect(isPublicSbeL2Ask(q('format=sbe'))).toBe(true);
    expect(isPublicSbeL2Ask(q('channel=trades&format=sbe'))).toBe(false);
    expect(marketDataFeedRefuse(q('channel=trades&format=sbe'), { allowPublicSbeL2: true })).toBe(DEPTH_BINARY_UNAVAILABLE);
  });

  it('does not treat L3+SBE as L2 SBE — private still names L3 missing', () => {
    expect(marketDataFeedRefuse(q('channel=l3&format=sbe'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=l3&format=sbe'), { allowPublicSbeL2: true })).toBe(DEPTH_L3_UNAVAILABLE);
    expect(isPublicSbeL2Ask(q('channel=l3&format=sbe'))).toBe(false);
  });

  it('refuses L4 / public maker identity on the L2 SBE tape', () => {
    expect(sbeL2EntitlementRefuse(q('format=sbe&level=4'))).toBe(DEPTH_ENTITLEMENT_UNAUTHORIZED);
    expect(sbeL2EntitlementRefuse(q('format=sbe&maker=1'))).toBe(DEPTH_ENTITLEMENT_UNAUTHORIZED);
    expect(sbeL2EntitlementRefuse(q('format=sbe'))).toBeNull();
  });

  it('names push asks on depth/L3 — poll is not push; trades stay push', () => {
    expect(marketDataFeedRefuse(q('transport=push'))).toBe(DEPTH_PUSH_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('mode=push'))).toBe(DEPTH_PUSH_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=push'))).toBe(DEPTH_PUSH_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('push=1'))).toBe(DEPTH_PUSH_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=l3&transport=push'), { allowNativeL3: true })).toBe(DEPTH_PUSH_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('format=sbe&transport=push'), { allowPublicSbeL2: true })).toBe(DEPTH_PUSH_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('channel=trades&transport=push'))).toBeNull();
    expect(marketDataFeedRefuse(q('channel=trades&transport=push'), { allowPublicSbeL2: true, allowNativeL3: true })).toBeNull();
    expect(marketDataFeedRefuse(q(''))).toBeNull();
  });

  it('sees a later alias and a repeated key as the binary, L3, push, or L4 ask', () => {
    expect(marketDataFeedRefuse(q('format=json&encoding=sbe'))).toBe(DEPTH_BINARY_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('level=2&book=mbo'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('level=1&level=3'))).toBe(DEPTH_L3_UNAVAILABLE);
    expect(marketDataFeedRefuse(q('transport=poll&mode=push'))).toBe(DEPTH_PUSH_UNAVAILABLE);
    expect(sbeL2EntitlementRefuse(q('level=20&data_level=4'))).toBe(DEPTH_ENTITLEMENT_UNAUTHORIZED);
    expect(marketDataFeedRefuse(q('format=json&level=2&transport=poll'))).toBeNull();
    expect(sbeL2EntitlementRefuse(q('format=json&level=2'))).toBeNull();
  });

  it('delivers the named 409 refuse when the write is still buffered', async () => {
    const received = await readBufferedRefuse(DEPTH_L3_UNAVAILABLE);
    expect(received).toBe(
      'HTTP/1.1 409 Conflict\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        'Content-Length: 113\r\n' +
        'Connection: close\r\n' +
        '\r\n' +
        '{"type":"status","code":"depth.l3_unavailable","message":"matching native L3 is unavailable; L2 depth is not L3"}',
    );
  });
});

/**
 * Cork holds the response in the writable buffer. Node drops that buffer on
 * destroy, so the peer reads bytes only when the refuse is flushed first.
 */
function readBufferedRefuse(code: Parameters<typeof writeMarketDataFeedRefuse>[1]): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client: net.Socket | undefined;
    const server = net.createServer((socket) => {
      socket.cork();
      try {
        writeMarketDataFeedRefuse(socket, code);
      } finally {
        socket.uncork();
      }
    });
    const finish = (body: string) => {
      if (settled) return;
      settled = true;
      client?.destroy();
      server.close(() => resolve(body));
    };
    server.once('error', (err) => {
      if (settled) return;
      settled = true;
      client?.destroy();
      server.close(() => reject(err));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        finish('');
        return;
      }
      const chunks: Buffer[] = [];
      client = net.connect(address.port, '127.0.0.1');
      client.setTimeout(1000, () => finish(Buffer.concat(chunks).toString('utf8')));
      client.on('data', (chunk: Buffer) => chunks.push(chunk));
      client.on('error', () => undefined);
      client.on('close', () => finish(Buffer.concat(chunks).toString('utf8')));
    });
  });
}
