/**
 * The order number of a replacement.
 *
 * `desk:replace:<first 8 of the order id>:<digest of the order id, new price and amount>`. The same replacement of the same order is the same
 * intent, so a retry after an unknown result sends the same number and the service returns what it already did. A
 * changed price or amount is a different replacement and gets a different number. Once an order is replaced it is a
 * new order with a new id, so replacing the replacement never reuses this number. 13 + 8 + 1 + 14 = 36
 * characters: the service refuses a replacement number over 56 (`replaceOrder`), tighter than the 64 a create allows.
 */

/** cyrb53: a 53-bit string hash of the whole intent, order id included. */
function digestOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}

export function replaceKey(orderId: string, price: string, amount: string): string {
  return `desk:replace:${orderId.slice(0, 8)}:${digestOf(`${orderId}|${price}|${amount}`)}`;
}
