import { expect } from './journey.mjs';

// svc-ledger's own operator door, read as the stack's TEST founder with admin:treasury reads it, for a journey that shows
// what our ledger posted under one business key (`/operator/trace?businessKey=...`). J-derivatives-01-venue holds the
// same reading as its own copy.

let staffDoor;

/** One read of the ledger's operator door that must answer 200; its JSON body. */
export async function ledgerRead(path) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, token: await sessions.a.treasuryToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}
