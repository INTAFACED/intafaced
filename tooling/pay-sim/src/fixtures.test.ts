import { expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { assertPersistableDestination } from '../../../services/svc-pay/src/merchant-payout-destination.js';
import { CryptoNativeAdapter } from '../../../services/svc-pay/src/rails/crypto-native.js';
import { MemoryChain } from '../../../services/svc-pay/src/rails/chain-port.js';
import { syntheticPayoutAddress } from './fixtures.js';

it('uses synthetic merchant addresses accepted by the real payout destination validator', () => {
  const merchantId = '11111111-1111-4111-8111-111111111111';
  expect(() => assertPersistableDestination('crypto-native', { kind: 'crypto', ref: `TEST-DATA-merchant-${merchantId}` })).toThrow();
  const ref = syntheticPayoutAddress(merchantId);
  expect(assertPersistableDestination('crypto-native', { kind: 'crypto', ref })).toEqual({ kind: 'crypto', ref });
  expect(ref).toBe('0x0000000011111111111141118111111111111111');
  expect(syntheticPayoutAddress('22222222-2222-4222-8222-222222222222')).not.toBe(ref);
});

it('real crypto adapter reports an unknown rail outcome during outage and retries exactly once', async () => {
  const chain = new MemoryChain();
  const crypto = new CryptoNativeAdapter({
    chain,
    secret: 'TEST-DATA-fixture-webhook-secret-no-real-keys',
    minConfirmations: 6,
    toleranceSeconds: 300,
  });
  const request = {
    settlementId: 'TEST-DATA-settlement',
    merchantId: '11111111-1111-4111-8111-111111111111',
    window: 'TEST-DATA-window',
    assetId: 'USDT',
    amount: parseAmount('1'),
    destination: { kind: 'crypto', ref: syntheticPayoutAddress('11111111-1111-4111-8111-111111111111') },
  };
  chain.failNextBroadcast(new Error('TEST DATA — injected rail down'));
  await expect(crypto.payout(request)).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
  expect(chain.outboundTransfers()).toHaveLength(0);
  const first = await crypto.payout(request);
  const retry = await crypto.payout(request);
  expect(first.ok).toBe(true);
  expect(retry.railRef).toBe(first.railRef);
  expect(chain.outboundTransfers()).toHaveLength(1);
});
