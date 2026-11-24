import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import type { MatchingOrderCommand } from './command.js';
import { postMatchingSubmit } from './matching-port.js';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';

/** A TEST market lifecycle admission proof for BTC/USDT: svc-fix has no real source of one (see `lifecycleProof`). */
const testProof = createMarketLifecycleAdmissionProof(
  {
    marketId: 'BTC/USDT',
    ruleVersion: 'TEST-rules-1',
    instrumentId: 'TEST-instrument',
    instrumentVersion: 'TEST-v1',
    state: 'OPEN',
    reasonCategory: 'NORMAL',
    reasonCode: 'trade.lifecycle.ready',
    effectiveAt: '2026-11-18T00:00:00.000Z',
    observedAt: '2026-11-18T00:00:00.000Z',
    lastGoodState: 'OPEN',
    allowedActions: ['PLACE'],
    transitionId: 'TEST-transition',
    evidenceRefs: ['TEST-evidence'],
  },
  'PLACE',
);

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
});

const cmd: MatchingOrderCommand = {
  kind: 'new_order_single',
  clOrdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  beginString: 'FIX.4.4',
  symbol: 'BTC/USDT',
  side: 'buy',
  ordType: 'limit',
  qty: '1',
  price: '100',
  tif: 'GTC',
  senderCompId: 'CLIENT',
  targetCompId: 'X',
} as MatchingOrderCommand;

it('2xx headers then a stalled body is reported as a timeout, not a definite rejection', async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"accepted":'); // headers sent, body never finishes
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const result = await postMatchingSubmit(cmd, {
    matchingBaseUrl: `http://127.0.0.1:${port}`,
    compIdAccountJson: '{"CLIENT":"acct-desk"}',
    internalServiceSecret: 'a'.repeat(32),
    lifecycleProof: () => testProof,
    timeoutMs: 300,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('matching_timeout');
}, 10000);
