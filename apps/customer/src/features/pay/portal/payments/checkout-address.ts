/**
 * The path the hosted checkout is served at. The service builds every `checkoutUrl` from it (`PAY_PUBLIC_BASE_PATH`, default
 * `/api/pay`, in services/svc-pay/src/env.ts), so a token-built address uses the same one. A `checkoutUrl` the service sends
 * always wins over this.
 */
export const PAY_CHECKOUT_PATH = '/api/pay/checkout';

/** The checkout address for a token the service sent without a `checkoutUrl`. */
export const checkoutAddressFor = (origin: string, token: string) => `${origin}${PAY_CHECKOUT_PATH}?token=${encodeURIComponent(token)}`;

const isWebAddress = (value: string) => /^https?:\/\//i.test(value);

/**
 * The address a link can be copied, opened and scanned from: the checkout address the service stored for it, else one built
 * from a token the service sent. Null when the service sent neither, or the address is not an ordinary web address. Only an
 * active link that has not expired shows it (see the call site).
 */
export function addressOf(link: { checkoutUrl?: string | null; token?: string | null }): string | null {
  if (link.checkoutUrl && isWebAddress(link.checkoutUrl)) return link.checkoutUrl;
  // The service sends a path from its public base; the browser's own origin completes it.
  if (link.checkoutUrl && link.checkoutUrl.startsWith('/')) return `${globalThis.location?.origin ?? ''}${link.checkoutUrl}`;
  if (link.token) return checkoutAddressFor(globalThis.location?.origin ?? '', link.token);
  return null;
}
