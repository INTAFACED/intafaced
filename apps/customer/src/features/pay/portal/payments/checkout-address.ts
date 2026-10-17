/**
 * The path the hosted checkout is served at. The service builds every `checkoutUrl` from it (`PAY_PUBLIC_BASE_PATH`, default
 * `/api/pay`, in services/svc-pay/src/env.ts), so a token-built address uses the same one. A `checkoutUrl` the service sends
 * always wins over this.
 */
export const PAY_CHECKOUT_PATH = '/api/pay/checkout';

/** The checkout address for a token the service sent without a `checkoutUrl`. */
export const checkoutAddressFor = (origin: string, token: string) => `${origin}${PAY_CHECKOUT_PATH}?token=${encodeURIComponent(token)}`;
