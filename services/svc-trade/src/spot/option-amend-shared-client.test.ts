import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { installOptionAmend } from './option-place.js';

/**
 * #8579: installOptionAmend used to swap `amend` on the service's one MatchingClient for the length of an option amend,
 * so two option amends in flight at once sent each other's fields, and a later plain amend kept the first one's.
 * The host below is the smallest one the wrapper reads: its own amendOrder (the qty-up amend's flag is set, so the
 * wrapper keeps it) awaits a gate, then sends the order's amend through `this.matching.amend` with the option fields
 * it was handed, as the native amend (`qty-up-amend.ts`) does.
 */
type Sent = { orderId: string; qty?: string; strike?: string | null };

function host() {
  const sent: Sent[] = [];
  // One gate per order, made by whichever side reaches it first, so the test decides the order the amends finish in.
  const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
  const gate = (id: string) => {
    let g = gates.get(id);
    if (!g) {
      let open: () => void = () => {};
      const opened = new Promise<void>((resolve) => (open = resolve));
      g = { opened, open };
      gates.set(id, g);
    }
    return g;
  };
  const original = async (_market: string, orderId: string, req: { qty?: string; strike?: string | null }) => {
    sent.push({ orderId, qty: req.qty, strike: req.strike });
    return { accepted: true };
  };
  class Host {
    matching = { amend: original, listOrders: async () => ({ orders: [] }) };
    async amendOrder(
      _principal: unknown,
      orderId: string,
      input: { qty?: bigint },
      option?: { strike: string | null } | null,
    ): Promise<unknown> {
      await gate(orderId).opened;
      return this.matching.amend('BTC-OPT', orderId, {
        ...(input.qty !== undefined ? { qty: formatAmount(input.qty as never) } : {}),
        ...option,
      });
    }
  }
  Reflect.set(Host.prototype, Symbol.for('intafaced.trade.nativeQtyUpAmend'), true);
  installOptionAmend(Host as never);
  const svc = new Host();
  const release = async (id: string) => gate(id).open();
  return { svc, sent, release, original };
}

const principal = { userId: 'u', scopes: ['trade:write'] };
const option = (qty: string, strike: string) => ({
  qty: parseAmount(qty),
  strike: parseAmount(strike),
  expiry: '2026-12-25T00:00:00.000Z',
});

describe('option amend on the shared matching client', () => {
  it('sends each order its own qty and strike, and leaves the client as it found it', async () => {
    const { svc, sent, release, original } = host();
    const a = svc.amendOrder(principal, 'order-a', option('1', '100') as never);
    const b = svc.amendOrder(principal, 'order-b', option('2', '200') as never);
    await release('order-a');
    await a;
    await release('order-b');
    await b;
    // A plain amend afterwards, of an order with no option fields.
    const c = svc.amendOrder(principal, 'order-c', {} as never);
    await release('order-c');
    await c;

    expect(sent).toEqual([
      { orderId: 'order-a', qty: '1', strike: '100' },
      { orderId: 'order-b', qty: '2', strike: '200' },
      { orderId: 'order-c', qty: undefined, strike: undefined },
    ]);
    expect(svc.matching.amend).toBe(original);
  });
});
