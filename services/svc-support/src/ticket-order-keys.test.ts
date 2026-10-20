import { createTicketOrderClient } from './ticket-order.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

// The empty reply is not an order, so the read comes back unknown after the request went out; only the request is judged.
keyCases('svc-support -> svc-trade order read', 'svc-trade', async (fetchImpl, s2s) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await createTicketOrderClient('http://trade.test', SECRET, s2s).read('o-1');
  } finally {
    globalThis.fetch = real;
  }
});
