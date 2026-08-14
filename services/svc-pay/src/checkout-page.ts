/**
 * THE HOSTED CHECKOUT PAGE.
 *
 * This is the only public, unauthenticated, value-bearing surface svc-pay
 * serves. It renders to somebody who is not logged in, who did not choose to
 * trust us, and who may be an attacker — so the rules it is written to are:
 *
 *   NO SECRETS AND NO ENUMERATION. Merchant ids, link ids, payment ids, profile
 *   configuration and rail adapter ids never reach the browser. What a payer
 *   gets is a label, an amount, and — once a session exists — one rail reference
 *   that belongs to them alone.
 *
 *   NO CLIENT-SIDE AMOUNT. On a fixed-amount link the amount is not in the form
 *   at all, not even as a hidden field: the server reads it off the link and
 *   ignores anything posted, so shipping a field would only advertise an attack
 *   that does not work. On a variable-amount link the payer states an amount
 *   once, at open, and the server freezes it into the session — every page after
 *   that renders the frozen number, never a submitted one.
 *
 *   NO SCRIPT. `script-src 'none'`, and the status poll is a `<meta refresh>`.
 *   A checkout page is the highest-value XSS target in the product, and the
 *   cheapest way to win that argument permanently is to have no script for an
 *   injection to land in.
 *
 *   NO FRAMING, NO CACHING, NO REFERRER. See `send()`.
 *
 * It does NOT collect card details, and it must not until a live acquiring rail
 * exists (see `rails/posture.ts`). A form that took a PAN against a mock
 * acquirer would be the single most dishonest thing in this repository.
 *
 * Browser front door is svc-edge: `/api/pay/checkout?token=…`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseAmount } from '@intafaced/ledger-client';

export type CheckoutLinkView = {
  id: string;
  merchantId: string;
  profileId: string | null;
  label: string;
  amount: string | null;
  currency: string | null;
  expiresAt?: string | null;
  remainingUses?: number | null;
  checkoutConfig: Record<string, unknown>;
  /**
   * The payer's own link token, threaded onto the view so the form can post it
   * back. It is not read from the database and never rendered anywhere except
   * the hidden field — it is already in this payer's address bar, so posting it
   * back grants nothing new.
   */
  token?: string;
};

export type CheckoutSessionPageView = {
  id: string;
  status: 'open' | 'completed' | 'expired' | 'cancelled';
  label: string;
  amount: string;
  currency: string;
  method: string;
  expiresAt: string;
  instruction: { reference: string; amount: string; currency: string } | null;
};

/** The slice of PayService the hosted page needs. Nothing else is reachable from here. */
export type CheckoutPay = {
  resolvePaymentLink(token: string): Promise<CheckoutLinkView>;
  openCheckoutSession(input: {
    linkToken: string;
    amount?: bigint;
    assetId?: string;
    geoCountry?: string;
    method?: string;
  }): Promise<{ sessionToken: string; session: CheckoutSessionPageView }>;
  getCheckoutSession(sessionToken: string): Promise<CheckoutSessionPageView>;
};

/**
 * The prefix the BROWSER sees this page under.
 *
 * svc-pay serves `/checkout`; svc-edge is the only public listener and routes
 * `/api/pay/*` here with the prefix STRIPPED (`services/svc-edge/src/routes.ts`).
 * So the paths this page emits — a form action, a redirect Location — must carry
 * the prefix back, or a form rendered at `/api/pay/checkout` posts to the edge's
 * root and 404s. Empty in unit tests, where the routes are mounted bare.
 */
export type CheckoutPaths = { readonly basePath: string };

const NO_PREFIX: CheckoutPaths = { basePath: '' };

export type CheckoutPageState =
  | { kind: 'ok'; link: CheckoutLinkView }
  | { kind: 'session'; session: CheckoutSessionPageView }
  | { kind: 'missing_token' }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'exhausted' }
  /** No rail on this deployment can honestly take a public payment. */
  | { kind: 'unavailable' }
  | { kind: 'busy' }
  | { kind: 'amount_required'; link: CheckoutLinkView; message: string }
  | { kind: 'error'; message?: string };

/** Escape for HTML text/attribute contexts. Labels are merchant-supplied. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Pull a payment-link token from query and/or path.
 * Accepts `/checkout?token=…`, `/checkout/:token`, `/pay/link/:token`.
 */
export function extractCheckoutToken(input: { queryToken?: string | string[]; pathToken?: string }): string | null {
  const raw = input.pathToken ?? (Array.isArray(input.queryToken) ? input.queryToken[0] : input.queryToken);
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (token.length < 8 || token.length > 200) return null;
  return token;
}

/**
 * Parse a payer-supplied amount from a form field.
 *
 * `undefined` for absent, `null` for present-but-not-a-decimal-string. The two
 * are different answers: absent on a fixed-amount link is correct and expected,
 * while garbage is a request to be refused rather than coerced. Money never
 * becomes a `number` on the way through here — `parseFloat` on this line is how
 * a payments book gets 0.1 + 0.2 in it.
 */
export function parsePayerAmount(raw: unknown): bigint | null | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(value)) return null;
  try {
    const amount = parseAmount(value);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

export function renderCheckoutPage(state: CheckoutPageState, paths: CheckoutPaths = NO_PREFIX): { status: number; html: string } {
  switch (state.kind) {
    case 'ok':
      return { status: 200, html: pageShell(linkBody(state.link, paths), state.link.label) };
    case 'session':
      return {
        status: 200,
        html: pageShell(sessionBody(state.session), state.session.label, state.session.status === 'open' ? 10 : undefined),
      };
    case 'missing_token':
      return {
        status: 400,
        html: pageShell(errorBody('Missing link', 'This checkout URL needs a payment link token.'), 'Missing link'),
      };
    case 'not_found':
      return {
        status: 404,
        html: pageShell(errorBody('Link not found', 'This payment link does not exist or is no longer active.'), 'Link not found'),
      };
    case 'expired':
      return {
        status: 410,
        html: pageShell(errorBody('Link expired', 'This payment link has expired. Ask the merchant for a new one.'), 'Link expired'),
      };
    case 'exhausted':
      return {
        status: 410,
        html: pageShell(
          errorBody('Link already used', 'This payment link has already been paid. Ask the merchant for a new one.'),
          'Link already used',
        ),
      };
    case 'unavailable':
      // WHAT THIS PAGE MUST NOT SAY. Not "try again" — retrying cannot fix it.
      // Not which rail, not what mode it is in, not that a sandbox exists at
      // all. The payer is told the truth at the only level of detail that is
      // theirs: this merchant cannot take payment right now, and nothing has
      // been charged.
      return {
        status: 503,
        html: pageShell(
          errorBody(
            'Payment unavailable',
            'This merchant cannot take payment right now. Nothing has been charged and no payment was started.',
          ),
          'Payment unavailable',
        ),
      };
    case 'busy':
      return {
        status: 429,
        html: pageShell(
          errorBody('Too many checkouts open', 'Too many people are paying this link at once. Try again in a few minutes.'),
          'Too many checkouts open',
        ),
      };
    case 'amount_required':
      return { status: 400, html: pageShell(linkBody(state.link, paths, state.message), state.link.label) };
    case 'error':
      return {
        status: 500,
        html: pageShell(
          errorBody('Something went wrong', state.message ?? 'The checkout page could not load this link.'),
          'Checkout error',
        ),
      };
  }
}

function linkBody(link: CheckoutLinkView, paths: CheckoutPaths, problem?: string): string {
  const fixedAmount = link.amount !== null;

  const amountLine = fixedAmount
    ? `<p class="amount"><span class="num">${escapeHtml(link.amount!)}</span>${
        link.currency ? ` <span class="ccy">${escapeHtml(link.currency)}</span>` : ''
      }</p>`
    : `<p class="amount muted">Choose an amount</p>`;

  // Merchant-safe subset of checkoutConfig only — never dump the whole bag
  // (profiles may later hold routing hints that should not hit the browser).
  const displayName = readSafeString(link.checkoutConfig, 'displayName');
  const merchantLine = displayName ? `<p class="merchant">Merchant: ${escapeHtml(displayName)}</p>` : '';
  const problemLine = problem ? `<p class="problem" role="alert">${escapeHtml(problem)}</p>` : '';

  // WHAT IS AND IS NOT IN THIS FORM.
  //
  // The link token is here because it IS the capability — the payer already
  // holds it, it is in their address bar, and there is no cookie and no ambient
  // authority on this surface at all, which is what makes CSRF a non-concept
  // here rather than a control somebody had to remember to add.
  //
  // The amount field exists ONLY on a variable-amount link. There is no rail
  // field on any link, ever. Country is a routing dim (D26-P1-P3), not a rail name.
  const amountField = fixedAmount
    ? ''
    : `
      <label class="field">
        <span>Amount${link.currency ? ` (${escapeHtml(link.currency)})` : ''}</span>
        <input name="amount" inputmode="decimal" autocomplete="off" required pattern="[0-9]+(\\.[0-9]{1,18})?" placeholder="0.00" />
      </label>${
        link.currency
          ? ''
          : `
      <label class="field">
        <span>Currency</span>
        <input name="assetId" autocomplete="off" required maxlength="16" placeholder="USDT" />
      </label>`
      }`;

  const geoField = `
      <label class="field">
        <span>Country</span>
        <input name="geoCountry" autocomplete="country" required minlength="2" maxlength="8" placeholder="DE" />
      </label>`;

  const tokenField = link.token ? `<input type="hidden" name="token" value="${escapeHtml(link.token)}" />` : '';

  return `
    <header class="head">
      <p class="eyebrow">Payment request</p>
      <h1>${escapeHtml(link.label)}</h1>
      ${merchantLine}
    </header>
    <section class="card" aria-label="Payment details">
      ${amountLine}
      ${problemLine}
      <form method="POST" action="${escapeHtml(paths.basePath)}/checkout/session" class="pay">
        ${tokenField}${amountField}${geoField}
        <button type="submit">Continue to payment</button>
      </form>
      <p class="hint">Nothing is charged until you send the payment yourself. This page never asks for card details.</p>
    </section>
  `;
}

function sessionBody(session: CheckoutSessionPageView): string {
  const amountLine = `<p class="amount"><span class="num">${escapeHtml(session.amount)}</span> <span class="ccy">${escapeHtml(
    session.currency,
  )}</span></p>`;

  if (session.status === 'completed') {
    return `
      <header class="head">
        <p class="eyebrow">Paid</p>
        <h1>${escapeHtml(session.label)}</h1>
      </header>
      <section class="card">
        ${amountLine}
        <p class="cta done" role="status">Payment received</p>
        <p class="hint">The merchant has been notified.</p>
      </section>
    `;
  }

  if (session.status === 'expired' || session.status === 'cancelled') {
    // THE SENTENCE THAT TOOK THE MOST CARE TO WRITE. A checkout window closing
    // is NOT the payment being cancelled: funds sent to the reference still
    // land at an address derived from the payment id, are still matched to that
    // payment by the rail's webhook, and are still credited to the merchant.
    // Telling a payer their payment was cancelled while their money is in
    // flight is how a support ticket becomes a chargeback.
    return `
      <header class="head">
        <p class="eyebrow">Checkout closed</p>
        <h1>${escapeHtml(session.label)}</h1>
      </header>
      <section class="card">
        ${amountLine}
        <p class="cta">This checkout window has closed</p>
        <p class="hint">Nothing has been charged. If you already sent a payment to the reference shown earlier it will still reach the merchant — payments are not cancelled when this page times out. Otherwise, open the payment link again to start a new checkout.</p>
      </section>
    `;
  }

  if (!session.instruction) {
    return `
      <header class="head">
        <p class="eyebrow">Preparing payment</p>
        <h1>${escapeHtml(session.label)}</h1>
      </header>
      <section class="card">
        ${amountLine}
        <p class="cta" role="status">Waiting for a payment reference…</p>
        <p class="hint">This page refreshes on its own.</p>
      </section>
    `;
  }

  return `
    <header class="head">
      <p class="eyebrow">Send payment</p>
      <h1>${escapeHtml(session.label)}</h1>
    </header>
    <section class="card" aria-label="Payment instruction">
      ${amountLine}
      <p class="label">Send exactly this amount to</p>
      <p class="reference"><code>${escapeHtml(session.instruction.reference)}</code></p>
      <p class="cta" role="status">Waiting for your payment…</p>
      <p class="hint">This page refreshes on its own and updates when the payment is confirmed. The reference above belongs to this payment only.</p>
    </section>
  `;
}

function errorBody(title: string, detail: string): string {
  return `
    <header class="head">
      <p class="eyebrow">Checkout</p>
      <h1>${escapeHtml(title)}</h1>
    </header>
    <section class="card">
      <p class="hint">${escapeHtml(detail)}</p>
    </section>
  `;
}

function readSafeString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 120) return null;
  return t;
}

function pageShell(body: string, title: string, refreshSeconds?: number): string {
  const refresh = refreshSeconds ? `\n  <meta http-equiv="refresh" content="${refreshSeconds}" />` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />${refresh}
  <title>${escapeHtml(title)} · Checkout</title>
  <style>
    :root { color-scheme: light dark; --bg: #0b0f14; --fg: #e8eef6; --muted: #8b98a8; --card: #141b24; --line: #243041; --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; }
    @media (prefers-color-scheme: light) {
      :root { --bg: #f4f6f8; --fg: #101820; --muted: #5b6b7c; --card: #fff; --line: #d7dee7; --accent: #1a5fd0; --ok: #15803d; --warn: #b45309; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--fg); display: grid; place-items: center; padding: 1.5rem; }
    main { width: min(28rem, 100%); }
    .eyebrow { margin: 0 0 .35rem; text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; color: var(--muted); }
    h1 { margin: 0 0 .75rem; font-size: 1.45rem; font-weight: 650; line-height: 1.25; word-break: break-word; }
    .merchant { margin: 0 0 1rem; color: var(--muted); font-size: .95rem; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem 1.35rem; }
    .amount { margin: 0 0 .9rem; font-size: 1.75rem; font-weight: 650; letter-spacing: -0.02em; }
    .amount .ccy { font-size: 1rem; font-weight: 600; color: var(--muted); }
    .amount.muted { font-size: 1rem; font-weight: 500; color: var(--muted); }
    .label { margin: 0 0 .3rem; font-size: .82rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .reference { margin: 0 0 1rem; }
    .reference code { display: block; padding: .7rem .8rem; border: 1px solid var(--line); border-radius: 8px; font: .92rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .hint { margin: 1rem 0 0; color: var(--muted); font-size: .92rem; }
    .problem { margin: 0 0 .9rem; color: var(--warn); font-size: .92rem; }
    .cta { margin: 0; padding: .85rem 1rem; text-align: center; border-radius: 8px; border: 1px dashed var(--line); color: var(--accent); font-weight: 600; }
    .cta.done { color: var(--ok); border-style: solid; }
    .field { display: block; margin: 0 0 .8rem; }
    .field span { display: block; margin-bottom: .3rem; font-size: .85rem; color: var(--muted); }
    .field input { width: 100%; padding: .65rem .75rem; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
    button { width: 100%; padding: .85rem 1rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

/** Read `PayError.code` (or any error with a string `code`) without importing the service. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

/**
 * Map a service error onto a page, and REFUSE TO GUESS.
 *
 * Every code that reaches here has a page written for it. Anything unrecognised
 * falls to a 500 rather than to a friendlier-looking state, because on this
 * surface the friendly-looking states are the ones that imply money moved.
 */
export function stateForError(err: unknown): CheckoutPageState {
  switch (errorCode(err)) {
    case 'pay.link_not_found':
    case 'pay.checkout_session_not_found':
      return { kind: 'not_found' };
    case 'pay.link_expired':
      return { kind: 'expired' };
    case 'pay.link_exhausted':
      return { kind: 'exhausted' };
    case 'pay.checkout_busy':
      return { kind: 'busy' };
    // Live acquiring refuses that still reached this switch as a 500. Each
    // means "this merchant cannot take payment right now". Same page as #1808:
    // nothing charged, no try-again, no estate leak. Operator stubs
    // (`pay.kyb_operator_required`) and per-payment rail declines stay unmapped
    // — those are not "merchant cannot take live payment", and the unavailable
    // copy says no payment was started.
    case 'pay.checkout_rail_not_live':
    case 'pay.rail_not_live':
    case 'pay.sandbox_rail_refused':
    case 'pay.merchant_inactive':
    case 'pay.merchant_not_found':
    case 'pay.merchant_pricing_invalid':
    case 'pay.routing_no_rail':
    case 'pay.rail_unknown':
    case 'pay.rail_capability':
    case 'pay.kyb_required':
      return { kind: 'unavailable' };
    default:
      return { kind: 'error' };
  }
}

/**
 * Security headers for every checkout response.
 *
 * `script-src` is absent from the policy and `default-src 'none'` covers it,
 * which is why the page polls with `<meta refresh>` rather than `fetch`. A
 * checkout page is the highest-value XSS target in the product; the cheapest way
 * to win that argument permanently is to have no script for an injection to land
 * in.
 *
 * `frame-ancestors 'none'` stops a checkout showing an amount inside somebody
 * else's page. `no-store` stops a payer's own rail reference surviving in a
 * shared browser or a proxy. `no-referrer` stops the link token — which is a
 * bearer capability — leaking in a Referer header to wherever the payer clicks
 * next.
 */
function send(reply: FastifyReply, page: { status: number; html: string }): FastifyReply {
  return reply
    .code(page.status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store, no-cache, must-revalidate, private')
    .header('pragma', 'no-cache')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    )
    .send(page.html) as unknown as FastifyReply;
}

/**
 * Public HTML routes for payment links and hosted checkout.
 *
 * Anonymous by design — the token is the capability (same as `resolveLink`).
 * No principal header required, and no cookie is ever set.
 */
export async function registerCheckoutRoutes(app: FastifyInstance, pay: CheckoutPay, paths: CheckoutPaths = NO_PREFIX): Promise<void> {
  /**
   * ENCAPSULATED, for the same reason the webhook scope is (`index.ts`).
   *
   * An HTML form posts `application/x-www-form-urlencoded`, which Fastify does
   * not parse out of the box. Registering that parser on the ROOT instance would
   * put it in front of every other route on this port, including tRPC — and a
   * body parser registered globally to serve one route is exactly the class of
   * change that produces "zod says the payload is malformed" on a completely
   * unrelated procedure. Fastify content-type parsers are per-encapsulation
   * context, so this one stays here.
   */
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      const out: Record<string, string> = {};
      try {
        // FIRST value wins for a repeated key. `?amount=1&amount=999` is HTTP
        // parameter pollution, and "last wins" versus "first wins" versus "array"
        // is precisely the ambiguity an attacker looks for when two layers
        // disagree about which one they read. One rule, stated here.
        for (const [key, value] of new URLSearchParams(typeof body === 'string' ? body : '')) {
          if (!(key in out)) out[key] = value;
        }
      } catch {
        // Never throw: this endpoint is reachable by anyone on the internet, and
        // a parser that throws on garbage is a denial-of-service surface.
      }
      done(null, out);
    });

    await registerRoutes(scope, pay, paths);
  });
}

async function registerRoutes(app: FastifyInstance, pay: CheckoutPay, paths: CheckoutPaths): Promise<void> {
  const showLink = async (token: string | null, reply: FastifyReply, problem?: string) => {
    if (!token) return send(reply, renderCheckoutPage({ kind: 'missing_token' }, paths));
    try {
      const link = await pay.resolvePaymentLink(token);
      const withToken = { ...link, token };
      return send(
        reply,
        problem
          ? renderCheckoutPage({ kind: 'amount_required', link: withToken, message: problem }, paths)
          : renderCheckoutPage({ kind: 'ok', link: withToken }, paths),
      );
    } catch (err) {
      return send(reply, renderCheckoutPage(stateForError(err), paths));
    }
  };

  app.get<{ Querystring: { token?: string } }>('/checkout', async (request, reply) =>
    showLink(extractCheckoutToken({ queryToken: request.query.token }), reply),
  );

  app.get<{ Params: { token: string } }>('/checkout/:token', async (request, reply) =>
    showLink(extractCheckoutToken({ pathToken: request.params.token }), reply),
  );

  app.get<{ Params: { token: string } }>('/pay/link/:token', async (request, reply) =>
    showLink(extractCheckoutToken({ pathToken: request.params.token }), reply),
  );

  /**
   * Open a checkout session. The one state-changing route on this surface.
   *
   * It creates a payment row and asks a rail for an acceptance reference. It
   * moves NO value, and it names NO rail — the rail is chosen server-side, and a
   * deployment with none that can honestly take a public payment refuses inside
   * `openCheckoutSession` before anything is written.
   */
  app.post<{ Body: Record<string, unknown> }>('/checkout/session', { bodyLimit: 8_192 }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = extractCheckoutToken({ queryToken: typeof body.token === 'string' ? body.token : undefined });
    if (!token) return send(reply, renderCheckoutPage({ kind: 'missing_token' }, paths));

    const amount = parsePayerAmount(body.amount);
    if (amount === null) return showLink(token, reply, 'Enter an amount as a plain number, for example 19.99.');
    const assetId = typeof body.assetId === 'string' && body.assetId.trim() ? body.assetId.trim().slice(0, 16) : undefined;
    const geoCountry = typeof body.geoCountry === 'string' && body.geoCountry.trim() ? body.geoCountry.trim().slice(0, 8) : undefined;

    try {
      const { sessionToken } = await pay.openCheckoutSession({ linkToken: token, amount, assetId, geoCountry });
      // 303, so a refresh of the resulting page does not re-POST and open a
      // second session — and a second payment — against the same link.
      return reply
        .code(303)
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .header('location', `${paths.basePath}/checkout/session/${encodeURIComponent(sessionToken)}`)
        .send();
    } catch (err) {
      if (errorCode(err) === 'pay.checkout_amount_required') {
        return showLink(token, reply, 'This payment link needs you to enter an amount.');
      }
      if (errorCode(err) === 'pay.routing_input_missing') {
        return showLink(token, reply, 'This checkout needs your country. We do not invent one.');
      }
      return send(reply, renderCheckoutPage(stateForError(err), paths));
    }
  });

  /** Poll a session. Its OWN token, so one payer cannot read another's checkout. */
  app.get<{ Params: { sessionToken: string } }>('/checkout/session/:sessionToken', async (request, reply) => {
    const token = extractCheckoutToken({ pathToken: request.params.sessionToken });
    if (!token) return send(reply, renderCheckoutPage({ kind: 'missing_token' }, paths));
    try {
      const session = await pay.getCheckoutSession(token);
      return send(reply, renderCheckoutPage({ kind: 'session', session }, paths));
    } catch (err) {
      return send(reply, renderCheckoutPage(stateForError(err), paths));
    }
  });
}
