import { userAvailable } from '@intafaced/ledger-client';
import { createReplayLedgerClient } from './replay-ledger-client.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

const ref = userAvailable('11111111-1111-4111-8111-111111111111', 'USDT');

keyCases('svc-matching -> svc-ledger reads', 'svc-ledger', async (fetchImpl, s2s) => {
  await createReplayLedgerClient('http://ledger.test', SECRET, s2s, fetchImpl)
    .balance(ref)
    .catch(() => undefined);
});
