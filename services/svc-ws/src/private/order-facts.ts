/**
 * Private-stream order/fill facts (M05 / PX-S04).
 *
 * `orderUpdated.status` is not a fact name. A client that treats any orders
 * frame as success would treat reject as ack. `fact` is the discriminator;
 * unknown status is `unknown`, never ack/fill.
 *
 * `type` on the same frame is already limit/market — do not reuse it.
 */

export const PRIVATE_ORDER_FACTS = ['ack', 'reject', 'fill', 'cancel', 'expire', 'unknown'] as const;
export type PrivateOrderFact = (typeof PRIVATE_ORDER_FACTS)[number];

const FROM_STATUS = {
  pending: 'ack',
  open: 'ack',
  rejected: 'reject',
  filled: 'fill',
  cancelled: 'cancel',
  expired: 'expire',
} as const satisfies Record<string, PrivateOrderFact>;

export function factFromOrderStatus(status: string): PrivateOrderFact {
  if (Object.hasOwn(FROM_STATUS, status)) return FROM_STATUS[status as keyof typeof FROM_STATUS];
  return 'unknown';
}

export function encodePrivateOrderFrame(update: { readonly status: string }): string {
  return JSON.stringify({
    channel: 'orders',
    ...update,
    fact: factFromOrderStatus(update.status),
  });
}

export function encodePrivateFillFrame(update: object): string {
  return JSON.stringify({
    channel: 'fills',
    ...update,
    fact: 'fill' satisfies PrivateOrderFact,
  });
}
