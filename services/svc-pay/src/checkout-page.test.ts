import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  escapeHtml,
  extractCheckoutToken,
  parsePayerAmount,
  registerCheckoutRoutes,
  renderCheckoutPage,
  stateForError,
  type CheckoutLinkView,
  type CheckoutPay,
  type CheckoutSessionPageView,
} from './checkout-page.js';

/**
 * THE PUBLIC CHECKOUT SURFACE.
 *
 * No database and no ledger here — the service is a stub, because what this file
 * is about is what an ANONYMOUS BROWSER can see, send, and be told. Every test
 * is one of the four ways a hosted checkout goes wrong:
 *
 *   1. It renders something it should not — merchant internals, a rail id, an
 *      unescaped merchant label.
 *   2. It accepts something it should not — a client-supplied amount on a
 *      fixed-amount link, a rail name, a repeated field it reads differently
 *      from the layer behind it.
 *   3. It says something untrue — a payment "cancelled" when the money is in
 *      flight, or "try again" when retrying can never work.
 *   4. It can be framed, cached, or scripted into.
 */

function payErr(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const stubLink: CheckoutLinkView = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  merchantId: '11111111-1111-4111-8111-111111111111',
  profileId: null,
  label: 'Invoice #42 — café & co',
  amount: '19.99',
  currency: 'USD',
  expiresAt: '2026-08-30T00:00:00.000Z',
  remainingUses: null,
  checkoutConfig: { displayName: 'Acme Widgets' },
  token: 'pl_stubbed_token_value',
};

const stubSession: CheckoutSessionPageView = {
  id: 'cccccccc-dddd-4eee-8fff-000000000000',
  status: 'open',
  label: 'Invoice #42',
  amount: '19.99',
  currency: 'USDT',
  method: 'crypto',
  expiresAt: '2026-07-30T12:15:00.000Z',
  instruction: { reference: '0xacceptance000000000001', amount: '19.99', currency: 'USDT' },
};

const noSessions = {
  openCheckoutSession: async () => {
    throw new Error('openCheckoutSession is not part of this test');
  },
  getCheckoutSession: async () => {
    throw new Error('getCheckoutSession is not part of this test');
  },
};

describe('checkout page rendering', () => {
  it('includes the link label and amount, and offers a way to pay', () => {
    const { status, html } = renderCheckoutPage({ kind: 'ok', link: stubLink });

    expect(status).toBe(200);
    expect(html).toContain('Invoice #42 — café &amp; co');
    expect(html).toContain('19.99');
    expect(html).toContain('USD');
    expect(html).toContain('Acme Widgets');
    expect(html).toContain('Continue to payment');
    expect(html).toMatch(/name="geoCountry"/);
    // Still no card capture. There is no live acquiring rail, and a form that
    // took a PAN against a mock acquirer would be the most dishonest thing here.
    expect(html.toLowerCase()).not.toContain('card number');
  });

  /**
   * THE TAMPERING TEST, AT THE RENDER LAYER.
   *
   * On a fixed-amount link there is no amount input and no hidden amount field.
   * The server ignores a posted amount anyway — but shipping a field the client
   * could edit only advertises an attack that does not work.
   */
  it('ships NO amount field on a fixed-amount link', () => {
    const { html } = renderCheckoutPage({ kind: 'ok', link: stubLink });
    expect(html).not.toMatch(/name="amount"/);
    expect(html).not.toMatch(/name="assetId"/);
  });

  it('asks for an amount only when the link does not fix one', () => {
    const { html } = renderCheckoutPage({ kind: 'ok', link: { ...stubLink, amount: null } });
    expect(html).toMatch(/name="amount"/);
    // Currency is fixed by the link, so it is not asked for either.
    expect(html).not.toMatch(/name="assetId"/);

    const open = renderCheckoutPage({ kind: 'ok', link: { ...stubLink, amount: null, currency: null } });
    expect(open.html).toMatch(/name="assetId"/);
  });

  /** No rail field. Not now, not hidden, not ever. */
  it('never lets the payer name a rail', () => {
    for (const link of [stubLink, { ...stubLink, amount: null }]) {
      const { html } = renderCheckoutPage({ kind: 'ok', link });
      expect(html).not.toMatch(/name="rail/i);
      expect(html).not.toMatch(/name="method"/i);
      expect(html).not.toContain('crypto-native');
      expect(html).not.toContain('card-sandbox');
    }
  });

  it('leaks no merchant internals to the browser', () => {
    const { html } = renderCheckoutPage({ kind: 'ok', link: stubLink });
    expect(html).not.toContain(stubLink.merchantId);
    expect(html).not.toContain(stubLink.id);
  });

  it('renders the payment instruction once a session exists', () => {
    const { status, html } = renderCheckoutPage({ kind: 'session', session: stubSession });
    expect(status).toBe(200);
    expect(html).toContain('0xacceptance000000000001');
    expect(html).toContain('19.99');
    // Open sessions poll without script.
    expect(html).toContain('http-equiv="refresh"');
  });

  it('says paid only when the session says completed', () => {
    const done = renderCheckoutPage({ kind: 'session', session: { ...stubSession, status: 'completed' } });
    expect(done.html).toContain('Payment received');
    // A completed page has nothing left to poll for.
    expect(done.html).not.toContain('http-equiv="refresh"');

    const open = renderCheckoutPage({ kind: 'session', session: stubSession });
    expect(open.html).not.toContain('Payment received');
  });

  /**
   * THE SENTENCE THAT MATTERS MOST ON THIS SURFACE.
   *
   * A checkout window closing is NOT the payment being cancelled. Funds sent to
   * the reference still land, are still matched to the payment by the rail's
   * webhook, and are still credited. Telling a payer their payment was cancelled
   * while their money is in flight is how a support ticket becomes a chargeback.
   */
  it('does not tell a payer their money is gone when a session lapses', () => {
    const { html } = renderCheckoutPage({ kind: 'session', session: { ...stubSession, status: 'expired' } });
    expect(html).toContain('will still reach the merchant');
    expect(html).toContain('Nothing has been charged');
    expect(html.toLowerCase()).not.toContain('payment cancelled');
    expect(html.toLowerCase()).not.toContain('payment failed');
  });

  /**
   * WHAT THE UNAVAILABLE PAGE MUST NOT SAY. Not "try again" — retrying cannot
   * fix it. Not which rail, not what mode it is in, not that a sandbox exists.
   */
  it('refuses honestly when no rail can take a public payment', () => {
    const { status, html } = renderCheckoutPage({ kind: 'unavailable' });
    expect(status).toBe(503);
    expect(html).toContain('Nothing has been charged');
    expect(html.toLowerCase()).not.toContain('sandbox');
    expect(html.toLowerCase()).not.toContain('crypto-native');
    expect(html.toLowerCase()).not.toContain('rail');
  });

  it('renders honest empty and error states', () => {
    expect(renderCheckoutPage({ kind: 'missing_token' }).status).toBe(400);
    expect(renderCheckoutPage({ kind: 'not_found' }).html).toContain('Link not found');
    expect(renderCheckoutPage({ kind: 'expired' }).status).toBe(410);
    expect(renderCheckoutPage({ kind: 'expired' }).html).toContain('expired');
    expect(renderCheckoutPage({ kind: 'exhausted' }).status).toBe(410);
    expect(renderCheckoutPage({ kind: 'busy' }).status).toBe(429);
  });

  it('escapes merchant-supplied label HTML', () => {
    expect(escapeHtml(`<script>alert(1)</script>`)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    const { html } = renderCheckoutPage({
      kind: 'ok',
      link: { ...stubLink, label: `<img src=x onerror=alert(1)>` },
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });

  /** The rail reference comes from an adapter, and it is still escaped. */
  it('escapes a rail reference before rendering it', () => {
    const { html } = renderCheckoutPage({
      kind: 'session',
      session: { ...stubSession, instruction: { reference: `"><script>x</script>`, amount: '1', currency: 'USDT' } },
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('carries no inline script anywhere', () => {
    const states = [
      { kind: 'ok', link: stubLink } as const,
      { kind: 'session', session: stubSession } as const,
      { kind: 'unavailable' } as const,
    ];
    for (const state of states) {
      expect(renderCheckoutPage(state).html).not.toMatch(/<script/i);
      expect(renderCheckoutPage(state).html).not.toMatch(/on(click|load|error)=/i);
    }
  });
});

describe('extractCheckoutToken', () => {
  it('reads query and path tokens', () => {
    expect(extractCheckoutToken({ queryToken: 'pl_abcdefghijklmnop' })).toBe('pl_abcdefghijklmnop');
    expect(extractCheckoutToken({ pathToken: 'pl_path_token_here' })).toBe('pl_path_token_here');
    expect(extractCheckoutToken({ queryToken: 'short' })).toBeNull();
    expect(extractCheckoutToken({})).toBeNull();
  });
});

describe('parsePayerAmount', () => {
  it('separates absent from malformed, and never coerces', () => {
    expect(parsePayerAmount(undefined)).toBeUndefined();
    expect(parsePayerAmount('')).toBeUndefined();
    expect(parsePayerAmount('19.99')).toBe(19_990_000_000_000_000_000n);

    // Every one of these is a request to refuse, not a number to guess at. A
    // `parseFloat` on this path is how 0.1 + 0.2 gets into a payments book.
    for (const bad of ['-1', '0', 'abc', '1e3', '1,99', '0x10', ' 1 . 5', '1.0000000000000000001', 19.99, {}, []]) {
      expect(parsePayerAmount(bad)).toBeNull();
    }
  });
});

describe('stateForError', () => {
  it('maps only codes it has a page for, and falls to error otherwise', () => {
    expect(stateForError(payErr('pay.link_not_found', '')).kind).toBe('not_found');
    expect(stateForError(payErr('pay.link_expired', '')).kind).toBe('expired');
    expect(stateForError(payErr('pay.link_exhausted', '')).kind).toBe('exhausted');
    expect(stateForError(payErr('pay.checkout_busy', '')).kind).toBe('busy');
    // A posture refusal and a suspended merchant land on the same page: telling
    // an anonymous payer which one it is discloses our rail estate.
    expect(stateForError(payErr('pay.checkout_rail_not_live', '')).kind).toBe('unavailable');
    expect(stateForError(payErr('pay.routing_no_rail', '')).kind).toBe('unavailable');
    expect(stateForError(payErr('pay.merchant_inactive', '')).kind).toBe('unavailable');
    // Layer B money-door refuse — hosted HTML must not 500 a live KYB gap.
    expect(stateForError(payErr('pay.kyb_required', '')).kind).toBe('unavailable');
    // Remaining live-acquiring refuses that still 500'd after #1808.
    expect(stateForError(payErr('pay.merchant_pricing_invalid', '')).kind).toBe('unavailable');
    expect(stateForError(payErr('pay.merchant_not_found', '')).kind).toBe('unavailable');
    expect(stateForError(payErr('pay.rail_unknown', '')).kind).toBe('unavailable');
    expect(stateForError(payErr('pay.rail_capability', '')).kind).toBe('unavailable');
    expect(stateForError(payErr('pay.sandbox_rail_refused', '')).kind).toBe('unavailable');
    expect(stateForError(payErr('pay.rail_not_live', '')).kind).toBe('unavailable');
    // Operator stub decide is not a checkout money door — do not over-map.
    expect(stateForError(payErr('pay.kyb_operator_required', '')).kind).toBe('error');
    expect(stateForError(payErr('pay.kyb_invalid', '')).kind).toBe('error');
    expect(stateForError(payErr('pay.psp_mode_required', '')).kind).toBe('error');
    // Per-payment rail decline is not "merchant cannot take payment" — a
    // payment was started; unavailable copy would lie.
    expect(stateForError(payErr('pay.rail_declined', '')).kind).toBe('error');
    // Anything unrecognised is a 500, never a friendlier-looking state — the
    // friendly-looking states are the ones that imply money moved.
    expect(stateForError(payErr('pay.something_new', '')).kind).toBe('error');
    expect(stateForError(new Error('boom')).kind).toBe('error');
  });
});

describe('checkout routes', () => {
  async function build(pay: Partial<CheckoutPay>) {
    const app = Fastify();
    await registerCheckoutRoutes(app, {
      resolvePaymentLink: async () => stubLink,
      ...noSessions,
      ...pay,
    } as unknown as CheckoutPay);
    await app.ready();
    return app;
  }

  it('returns HTML that contains the stubbed link label', async () => {
    const app = await build({});
    const res = await app.inject({ method: 'GET', url: '/checkout?token=pl_stubbed_token_value' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Invoice #42 — café &amp; co');
    expect(res.body).toContain('19.99');
    await app.close();
  });

  /**
   * A checkout page shows an amount somebody is about to pay and a rail
   * reference belonging to one payer. Framing it is clickjacking; caching it
   * leaves it in a shared browser; a Referer header leaks the link token, which
   * IS the capability.
   */
  it('sets the headers a public payment page has to set', async () => {
    const app = await build({});
    const res = await app.inject({ method: 'GET', url: '/checkout?token=pl_stubbed_token_value' });

    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    await app.close();
  });

  it('resolves path tokens the same way', async () => {
    const app = await build({
      resolvePaymentLink: async (token) => {
        expect(token).toBe('pl_path_style_token_xx');
        return stubLink;
      },
    });

    const res = await app.inject({ method: 'GET', url: '/pay/link/pl_path_style_token_xx' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Invoice #42');
    await app.close();
  });

  it('maps not_found and expired honestly', async () => {
    const notFound = await build({
      resolvePaymentLink: async () => {
        throw payErr('pay.link_not_found', 'payment link not found');
      },
    });
    const r1 = await notFound.inject({ method: 'GET', url: '/checkout?token=pl_missing_token_xx' });
    expect(r1.statusCode).toBe(404);
    expect(r1.body).toContain('Link not found');
    await notFound.close();

    const expired = await build({
      resolvePaymentLink: async () => {
        throw payErr('pay.link_expired', 'payment link expired');
      },
    });
    const r2 = await expired.inject({ method: 'GET', url: '/checkout?token=pl_expired_token_xx' });
    expect(r2.statusCode).toBe(410);
    expect(r2.body).toContain('expired');
    await expired.close();
  });

  /**
   * THE POST. A form body, and a 303 so that refreshing the resulting page
   * cannot re-submit and open a second session — and a second payment — against
   * the same link.
   */
  it('opens a session from a form post and redirects to the session page', async () => {
    let received: unknown;
    const app = await build({
      openCheckoutSession: async (input) => {
        received = input;
        return { sessionToken: 'cs_session_token_here', session: stubSession };
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=pl_stubbed_token_value&geoCountry=DE',
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/checkout/session/cs_session_token_here');
    expect(received).toEqual({
      linkToken: 'pl_stubbed_token_value',
      amount: undefined,
      assetId: undefined,
      geoCountry: 'DE',
    });
    await app.close();
  });

  /**
   * HTTP PARAMETER POLLUTION. `amount=1&amount=999` is the oldest trick for
   * making two layers disagree about which value they read. One rule, stated in
   * the parser: first wins.
   */
  it('takes the first value for a repeated field', async () => {
    let received: { amount?: bigint } | undefined;
    const app = await build({
      resolvePaymentLink: async () => ({ ...stubLink, amount: null }),
      openCheckoutSession: async (input) => {
        received = input;
        return { sessionToken: 'cs_session_token_here', session: stubSession };
      },
    });

    await app.inject({
      method: 'POST',
      url: '/checkout/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=pl_stubbed_token_value&amount=1&amount=999',
    });

    expect(received?.amount).toBe(1_000_000_000_000_000_000n);
    await app.close();
  });

  it('re-renders the link with a message rather than passing garbage to the service', async () => {
    let called = false;
    const app = await build({
      resolvePaymentLink: async () => ({ ...stubLink, amount: null }),
      openCheckoutSession: async () => {
        called = true;
        throw new Error('should not be reached');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=pl_stubbed_token_value&amount=nineteen',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('plain number');
    expect(called).toBe(false);
    await app.close();
  });

  it('shows the unavailable page when the service refuses on posture, and never a receipt', async () => {
    const app = await build({
      openCheckoutSession: async () => {
        throw payErr('pay.checkout_rail_not_live', 'no live rail');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=pl_stubbed_token_value',
    });

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Nothing has been charged');
    await app.close();
  });

  /**
   * D26-P1-P10 Layer B is already on the money door (`assertMerchantActive`).
   * The hosted page used to fall through to 500 "Something went wrong" — a lie
   * to an anonymous payer. Same unavailable page as posture / inactive; never
   * leak KYB status or invite a retry that cannot fix it.
   */
  it('shows the unavailable page when live KYB is not approved — not a 500, not a receipt', async () => {
    const app = await build({
      openCheckoutSession: async () => {
        throw payErr('pay.kyb_required', 'Merchant x KYB is none; live acquiring requires approved KYB');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=pl_stubbed_token_value&geoCountry=DE',
    });

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Nothing has been charged');
    expect(res.body.toLowerCase()).not.toContain('try again');
    expect(res.body.toLowerCase()).not.toContain('kyb');
    expect(res.body.toLowerCase()).not.toContain('something went wrong');
    await app.close();
  });

  it('shows the unavailable page when live pricing is unpublished — not a 500, not a receipt', async () => {
    const app = await build({
      openCheckoutSession: async () => {
        throw payErr('pay.merchant_pricing_invalid', 'Merchant x has no fee rate and no default is configured');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=pl_stubbed_token_value&geoCountry=DE',
    });

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Nothing has been charged');
    expect(res.body.toLowerCase()).not.toContain('try again');
    expect(res.body.toLowerCase()).not.toContain('pricing');
    expect(res.body.toLowerCase()).not.toContain('fee');
    expect(res.body.toLowerCase()).not.toContain('something went wrong');
    await app.close();
  });

  it('polls a session by its own token', async () => {
    const app = await build({
      getCheckoutSession: async (token) => {
        expect(token).toBe('cs_session_token_here');
        return { ...stubSession, status: 'completed' as const };
      },
    });

    const res = await app.inject({ method: 'GET', url: '/checkout/session/cs_session_token_here' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Payment received');
    await app.close();
  });

  /**
   * THE MOUNT PREFIX. svc-pay serves `/checkout`; the edge routes `/api/pay/*`
   * here with the prefix stripped. A form action of `/checkout/session` rendered
   * to a browser sitting at `/api/pay/checkout` posts to the edge's ROOT and
   * 404s — with the payer watching. Every path the page emits carries it back.
   */
  it('emits paths under the prefix the browser actually sees', async () => {
    const app = Fastify();
    await registerCheckoutRoutes(
      app,
      {
        resolvePaymentLink: async () => stubLink,
        ...noSessions,
        openCheckoutSession: async () => ({ sessionToken: 'cs_session_token_here', session: stubSession }),
      } as unknown as CheckoutPay,
      { basePath: '/api/pay' },
    );
    await app.ready();

    const page = await app.inject({ method: 'GET', url: '/checkout?token=pl_stubbed_token_value' });
    expect(page.body).toContain('action="/api/pay/checkout/session"');

    const posted = await app.inject({
      method: 'POST',
      url: '/checkout/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=pl_stubbed_token_value',
    });
    expect(posted.headers.location).toBe('/api/pay/checkout/session/cs_session_token_here');
    await app.close();
  });

  it('reports an unknown session as not found', async () => {
    const app = await build({
      getCheckoutSession: async () => {
        throw payErr('pay.checkout_session_not_found', 'nope');
      },
    });

    const res = await app.inject({ method: 'GET', url: '/checkout/session/cs_unknown_token_xx' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('does not register its form parser on the rest of the instance', async () => {
    const app = Fastify();
    await registerCheckoutRoutes(app, {
      resolvePaymentLink: async () => stubLink,
      ...noSessions,
    } as unknown as CheckoutPay);
    // Registering a body parser globally to serve one route is how an unrelated
    // route starts reporting malformed input. The parser lives in its own scope.
    app.post('/elsewhere', async (request) => request.body);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/elsewhere',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });
});
