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
import { CHECKOUT_METHODS, checkoutButtonTextColor, checkoutMethodOfferSchema, type CheckoutMethodOffer } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { formatMoney } from '@intafaced/i18n';
import { PAYER_COPY_KEYS, payerTranslator, resolvePayerCopy } from './payer-copy.js';

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
  progress?: { received: string; missing: string; confirming?: string } | null;
  confirmationMessage?: string | null;
  confirmationUrl?: string | null;
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
  /**
   * The business's saved look (M-payments-core-08) for the link or session this token opens: a brand colour and an
   * optional logo, or null for the page's own colours. Optional, and a failure shows the page's own colours: the look
   * never stands between a payer and a checkout.
   */
  checkoutLook?(ref: { linkToken: string } | { sessionToken: string }): Promise<CheckoutPageLook | null>;
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
/** A business's look as the page receives it. The colour is checked again here before it reaches the style. */
export type CheckoutPageLook = { brandColor: string; logo: { contentType: string; dataBase64: string } | null };

export type CheckoutPaths = { readonly basePath: string };

const NO_PREFIX: CheckoutPaths = { basePath: '' };

export type CheckoutPageState =
  | { kind: 'ok'; link: CheckoutLinkView }
  | { kind: 'session'; session: CheckoutSessionPageView }
  | { kind: 'missing_token' }
  | { kind: 'not_found' }
  | { kind: 'inactive'; message: string }
  | { kind: 'expired' }
  | { kind: 'exhausted' }
  /** No rail on this deployment can honestly take a public payment. */
  | { kind: 'unavailable' }
  | { kind: 'busy' }
  | { kind: 'amount_required'; link: CheckoutLinkView; message: string }
  /**
   * M-adv-payments-core-11: more than one method the business offers can take this payment. The form comes back with
   * the payer's own answers and the methods in the business's order; a method with no rail is listed with its notice and
   * cannot be picked.
   */
  | { kind: 'choose_method'; link: CheckoutLinkView; offer: CheckoutMethodOffer; values: PayerAnswers; problem?: string }
  /** M-adv-payments-core-11: no method the business offers for this payment has a rail. Nothing was started. */
  | { kind: 'no_method'; offer: CheckoutMethodOffer }
  | { kind: 'error'; message?: string };

/** What the payer typed into the form, sent back into it when the page asks for one more answer. */
export type PayerAnswers = { amount?: string; assetId?: string; geoCountry?: string };

const METHOD_LABELS: Readonly<Record<(typeof CHECKOUT_METHODS)[number], string>> = {
  crypto: 'Crypto',
  card: 'Card',
  bank_debit: 'Bank debit',
  pay_later: 'Pay later',
};

/** The outside piece each notice names, as the app's service-off notice names it. */
const NOTICE_DEPENDENCY: Readonly<Record<string, string>> = {
  'rail.bank': 'a banking partner',
  'rail.card': 'a card issuer',
  'rail.crypto': 'a live network node or custody signer',
};

/** "Bank debit needs a banking partner. It is switched off here." with its code, as the app shows it. */
function methodNotice(method: (typeof CHECKOUT_METHODS)[number], notice: string): string {
  return `<p class="notice" data-not-connected="${escapeHtml(notice)}">${escapeHtml(METHOD_LABELS[method])} needs ${escapeHtml(
    NOTICE_DEPENDENCY[notice] ?? 'an outside connection',
  )}. It is switched off here. <span class="code">${escapeHtml(notice)}</span></p>`;
}

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

/**
 * An amount as a payer reads it, in the page's locale: the service's 18-place decimal without its trailing zeros, at
 * least two places (`25.000000000000000000` → `25.00`, `0.123400` → `0.1234`). Exact: up to 18 places are kept, so
 * nothing is rounded. Same formatter as receipts (`@intafaced/i18n`). Anything that is not a decimal is shown as it came.
 */
export function displayAmount(amount: string): string {
  try {
    return formatMoney(amount.trim(), 'XXX', payerTranslator().renderedLocale, {
      display: 'none',
      minFractionDigits: 2,
      maxFractionDigits: 18,
    });
  } catch {
    return amount;
  }
}

export function renderCheckoutPage(
  state: CheckoutPageState,
  paths: CheckoutPaths = NO_PREFIX,
  look: CheckoutPageLook | null = null,
): { status: number; html: string } {
  switch (state.kind) {
    case 'ok':
      return { status: 200, html: pageShell(linkBody(state.link, paths), state.link.label, undefined, look) };
    case 'session':
      return {
        status: 200,
        html: pageShell(sessionBody(state.session), state.session.label, state.session.status === 'open' ? 10 : undefined, look),
      };
    case 'missing_token':
      return {
        status: 400,
        html: pageShell(
          errorBody(resolvePayerCopy(PAYER_COPY_KEYS.required), resolvePayerCopy(PAYER_COPY_KEYS.required)),
          resolvePayerCopy(PAYER_COPY_KEYS.required),
        ),
      };
    case 'not_found':
      return {
        status: 404,
        html: pageShell(
          errorBody(resolvePayerCopy(PAYER_COPY_KEYS.notFound), resolvePayerCopy(PAYER_COPY_KEYS.notFound)),
          resolvePayerCopy(PAYER_COPY_KEYS.notFound),
        ),
      };
    case 'inactive':
      return {
        status: 404,
        html: pageShell(errorBody(state.message, state.message), state.message),
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
          errorBody(resolvePayerCopy(PAYER_COPY_KEYS.rateLimited), resolvePayerCopy(PAYER_COPY_KEYS.rateLimited)),
          resolvePayerCopy(PAYER_COPY_KEYS.rateLimited),
        ),
      };
    case 'amount_required':
      return { status: 400, html: pageShell(linkBody(state.link, paths, state.message), state.link.label, undefined, look) };
    case 'choose_method':
      return {
        status: state.problem ? 400 : 200,
        html: pageShell(
          linkBody(state.link, paths, state.problem, { offer: state.offer, values: state.values }),
          state.link.label,
          undefined,
          look,
        ),
      };
    case 'no_method':
      // The business offers methods for this payment, and none of them is connected: say which piece each one needs.
      // Nothing was charged and no payment was started, exactly as on the unavailable page.
      return {
        status: 503,
        html: pageShell(
          `
    <header class="head">
      <p class="eyebrow">Checkout</p>
      <h1>Payment unavailable</h1>
    </header>
    <section class="card">
      <p class="hint">This merchant cannot take this payment right now. Nothing has been charged and no payment was started.</p>
      ${state.offer.offered.map((o) => (o.connection.state === 'not_connected' ? methodNotice(o.method, o.connection.notice) : '')).join('')}
    </section>
  `,
          'Payment unavailable',
          undefined,
          look,
        ),
      };
    case 'error':
      return {
        status: 500,
        html: pageShell(
          errorBody(resolvePayerCopy(PAYER_COPY_KEYS.generic), state.message ?? resolvePayerCopy(PAYER_COPY_KEYS.generic)),
          resolvePayerCopy(PAYER_COPY_KEYS.generic),
        ),
      };
  }
}

function linkBody(
  link: CheckoutLinkView,
  paths: CheckoutPaths,
  problem?: string,
  choice?: { offer: CheckoutMethodOffer; values: PayerAnswers },
): string {
  const values = choice?.values ?? {};
  const valueAttr = (v: string | undefined) => (v ? ` value="${escapeHtml(v)}"` : '');
  const fixedAmount = link.amount !== null;

  const amountLine = fixedAmount
    ? `<p class="amount"><span class="num">${escapeHtml(displayAmount(link.amount!))}</span>${
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
        <span>${escapeHtml(resolvePayerCopy(PAYER_COPY_KEYS.amount))}${link.currency ? ` (${escapeHtml(link.currency)})` : ''}</span>
        <input name="amount" inputmode="decimal" autocomplete="off" required pattern="[0-9]+(\\.[0-9]{1,18})?" placeholder="0.00"${valueAttr(values.amount)} />
      </label>${
        link.currency
          ? ''
          : `
      <label class="field">
        <span>Currency</span>
        <input name="assetId" autocomplete="off" required maxlength="16" placeholder="USDT"${valueAttr(values.assetId)} />
      </label>`
      }`;

  const geoField = `
      <label class="field">
        <span>Country</span>
        <input name="geoCountry" autocomplete="country" required minlength="2" maxlength="8" placeholder="DE"${valueAttr(values.geoCountry)} />
      </label>`;

  // The methods in the business's order. Only a connected one can be picked; the first of those is picked already.
  let firstPayable = true;
  const methodField =
    choice && choice.offer.offered.length > 0
      ? `
      <fieldset class="methods">
        <legend>How to pay</legend>
        ${choice.offer.offered
          .map((o) => {
            if (o.connection.state === 'not_connected') {
              return `<label class="method off"><input type="radio" name="method" value="${escapeHtml(o.method)}" disabled /> ${escapeHtml(
                METHOD_LABELS[o.method],
              )}</label>${methodNotice(o.method, o.connection.notice)}`;
            }
            const checked = firstPayable ? ' checked' : '';
            firstPayable = false;
            return `<label class="method"><input type="radio" name="method" value="${escapeHtml(o.method)}" required${checked} /> ${escapeHtml(
              METHOD_LABELS[o.method],
            )}</label>`;
          })
          .join('')}
      </fieldset>`
      : '';

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
        ${tokenField}${amountField}${geoField}${methodField}
        <button type="submit">${escapeHtml(resolvePayerCopy(PAYER_COPY_KEYS.continue))}</button>
      </form>
      <p class="hint">Nothing is charged until you send the payment yourself. This page never asks for card details.</p>
    </section>
  `;
}

const BRAND_COLOR = /^#[0-9a-f]{6}$/;
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The business's look as markup: its colour as the page's accent (with dark or light button text, whichever reads on
 * it) and its logo above the title. Anything that is not a checked colour, an allowed image type or plain base64 is left
 * out, so nothing unchecked reaches an attribute. No look is the page's own colours and no logo.
 */
export function brandLook(look: CheckoutPageLook | null): { style: string; logo: string } {
  if (!look || !BRAND_COLOR.test(look.brandColor)) return { style: '', logo: '' };
  const style = ` style="--accent: ${look.brandColor}; --on-accent: ${checkoutButtonTextColor(look.brandColor)}"`;
  const logo =
    look.logo && LOGO_TYPES.has(look.logo.contentType) && BASE64.test(look.logo.dataBase64)
      ? `<img class="logo" src="data:${look.logo.contentType};base64,${look.logo.dataBase64}" alt="Merchant logo" />`
      : '';
  return { style, logo };
}

/**
 * Paid in part (J-merchant-04 step 5): what arrived, what is missing, and what to send to the same reference. An amount
 * already on its way (sent, not yet final) is not asked for again. Nothing reaches the business until it is all in.
 */
function partReceived(
  session: CheckoutSessionPageView,
  progress: NonNullable<CheckoutSessionPageView['progress']>,
  reference: string,
  amountLine: string,
  closed: boolean,
): string {
  const ccy = escapeHtml(session.currency);
  const money = (amount: string) => `${escapeHtml(displayAmount(amount))} ${ccy}`;
  const confirming = parseAmount(progress.confirming ?? '0');
  const toSend = parseAmount(progress.missing) - confirming;
  const onItsWay =
    confirming > 0n ? `<p class="hint">${money(formatAmount(confirming))} is on its way and waiting for confirmations.</p>` : '';
  const next =
    toSend > 0n
      ? `<p class="label">Send the missing ${money(formatAmount(toSend))} to the same reference</p>
      <p class="reference"><code>${escapeHtml(reference)}</code></p>`
      : `<p class="label">Nothing more to send</p>`;
  const closedNote = closed
    ? `<p class="hint">This checkout window has closed, but the payment has not: what you send to this reference still reaches the merchant.</p>`
    : '';
  return `
    <header class="head">
      <p class="eyebrow">Part received</p>
      <h1>${escapeHtml(session.label)}</h1>
    </header>
    <section class="card" aria-label="Payment instruction">
      ${amountLine}
      <p class="cta" role="status">${money(progress.received)} of ${money(session.amount)} received, ${money(progress.missing)} missing</p>
      ${onItsWay}
      ${next}
      ${closedNote}
      <p class="hint">The business is paid once the full amount has arrived and is confirmed.${closed ? '' : ' This page refreshes on its own.'}</p>
    </section>
  `;
}

function sessionBody(session: CheckoutSessionPageView): string {
  const amountLine = `<p class="amount"><span class="num">${escapeHtml(displayAmount(session.amount))}</span> <span class="ccy">${escapeHtml(
    session.currency,
  )}</span></p>`;

  if (session.status === 'completed') {
    const redirect = httpsRedirect(session.confirmationUrl);
    const message = session.confirmationMessage?.trim();
    const paid = message
      ? `<p class="cta done" role="status">${escapeHtml(message)}</p>`
      : `<p class="cta done" role="status">Payment received</p>`;
    const next = redirect
      ? `<p class="hint"><a href="${escapeHtml(redirect)}">Continue</a></p>`
      : `<p class="hint">The merchant has been notified.</p>`;
    return `
      <header class="head">
        <p class="eyebrow">Paid</p>
        <h1>${escapeHtml(session.label)}</h1>
      </header>
      <section class="card">
        ${amountLine}
        ${paid}
        ${next}
      </section>
    `;
  }

  if (session.status === 'expired' && session.progress && session.instruction) {
    // Closed over a payment paid in part: the payment does not close with the window, so the payer still reads what
    // arrived and where the rest goes. "Nothing has been charged" would be false here.
    return partReceived(session, session.progress, session.instruction.reference, amountLine, true);
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

  if (session.progress) return partReceived(session, session.progress, session.instruction.reference, amountLine, false);

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

function pageShell(body: string, title: string, refreshSeconds?: number, look: CheckoutPageLook | null = null): string {
  const brand = brandLook(look);
  const refresh = refreshSeconds ? `\n  <meta http-equiv="refresh" content="${refreshSeconds}" />` : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(payerTranslator().renderedLocale)}">
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
    button { width: 100%; padding: .85rem 1rem; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent, #fff); font: inherit; font-weight: 650; cursor: pointer; }
    .methods { margin: 0 0 .9rem; padding: 0; border: 0; }
    .methods legend { margin-bottom: .3rem; font-size: .85rem; color: var(--muted); }
    .method { display: block; padding: .55rem 0; }
    .method.off { color: var(--muted); }
    .notice { margin: 0 0 .6rem; font-size: .88rem; color: var(--warn); }
    .notice .code { font: .8rem ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
    .logo { display: block; max-width: 10rem; max-height: 3rem; margin: 0 0 .75rem; object-fit: contain; }
  </style>
</head>
<body>
  <main${brand.style}>
    ${brand.logo}${body}
  </main>
</body>
</html>`;
}

/** Read `PayError.code` (or any error with a string `code`) without importing the service. */
function httpsRedirect(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0 || !parsed.href.startsWith('https://')) return null;
  return parsed.href;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return '';
}

/** The routing dimensions a `pay.routing_input_missing` names; none when it names none. */
function missingDims(err: unknown): readonly string[] {
  const detail = err && typeof err === 'object' && 'detail' in err ? (err as { detail?: { missing?: unknown } }).detail : undefined;
  const missing = detail?.missing;
  return Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [];
}

/** The offer a method refusal carries, read back strictly; anything else is not shown. */
function offerOf(err: unknown): CheckoutMethodOffer | null {
  const detail = err && typeof err === 'object' && 'detail' in err ? (err as { detail?: { offer?: unknown } }).detail : undefined;
  const parsed = checkoutMethodOfferSchema.safeParse(detail?.offer);
  return parsed.success ? parsed.data : null;
}

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
    case 'pay.link_inactive': {
      const message = errorMessage(err).trim();
      if (!message || message === 'payment link not found') return { kind: 'not_found' };
      return { kind: 'inactive', message };
    }
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
    case 'pay.checkout_rails_unset':
    case 'pay.psp_unset':
    case 'pay.rail_not_live':
    case 'pay.sandbox_rail_refused':
    case 'pay.merchant_inactive':
    case 'pay.merchant_not_found':
    case 'pay.merchant_pricing_invalid':
    case 'pay.fee_bps_unset':
    case 'pay.routing_no_rail':
    // The owner has not declared a success fraction for any rail that could take this.
    case 'pay.routing_approval_rate_unset':
    case 'pay.rail_unknown':
    case 'pay.rail_capability':
    case 'pay.kyb_required':
    case 'pay.category_prohibited':
    case 'pay.reserve_terms_unset':
    case 'pay.category_rail_refused':
    case 'pay.guard_category_prohibited':
    case 'pay.guard_reserve_terms_unset':
    case 'pay.guard_category_rail_refused':
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

/** The business's look for this token, or the page's own colours when there is none or it cannot be read. */
async function lookOf(pay: CheckoutPay, ref: { linkToken: string } | { sessionToken: string }): Promise<CheckoutPageLook | null> {
  try {
    return (await pay.checkoutLook?.(ref)) ?? null;
  } catch {
    return null;
  }
}

async function registerRoutes(app: FastifyInstance, pay: CheckoutPay, paths: CheckoutPaths): Promise<void> {
  const showLink = async (token: string | null, reply: FastifyReply, problem?: string) => {
    if (!token) return send(reply, renderCheckoutPage({ kind: 'missing_token' }, paths));
    try {
      const link = await pay.resolvePaymentLink(token);
      const withToken = { ...link, token };
      const look = await lookOf(pay, { linkToken: token });
      return send(
        reply,
        problem
          ? renderCheckoutPage({ kind: 'amount_required', link: withToken, message: problem }, paths, look)
          : renderCheckoutPage({ kind: 'ok', link: withToken }, paths, look),
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
    if (amount === null) return showLink(token, reply, resolvePayerCopy(PAYER_COPY_KEYS.invalidAmount));
    const assetId = typeof body.assetId === 'string' && body.assetId.trim() ? body.assetId.trim().slice(0, 16) : undefined;
    const geoCountry = typeof body.geoCountry === 'string' && body.geoCountry.trim() ? body.geoCountry.trim().slice(0, 8) : undefined;
    // Only a catalogue method is passed on; anything else is as if none was picked, and the page asks again.
    const method = CHECKOUT_METHODS.find((m) => m === body.method);
    const answers: PayerAnswers = {
      ...(typeof body.amount === 'string' && amount !== undefined ? { amount: body.amount.trim().slice(0, 64) } : {}),
      ...(assetId ? { assetId } : {}),
      ...(geoCountry ? { geoCountry } : {}),
    };

    try {
      const { sessionToken } = await pay.openCheckoutSession({
        linkToken: token,
        amount,
        assetId,
        geoCountry,
        ...(method ? { method } : {}),
      });
      // 303, so a refresh of the resulting page does not re-POST and open a
      // second session — and a second payment — against the same link.
      return reply
        .code(303)
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .header('location', `${paths.basePath}/checkout/session/${encodeURIComponent(sessionToken)}`)
        .send();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'pay.checkout_method_required' || code === 'pay.checkout_method_not_offered' || code === 'pay.checkout_no_method') {
        const offer = offerOf(err);
        if (!offer) return send(reply, renderCheckoutPage({ kind: 'error' }, paths));
        const look = await lookOf(pay, { linkToken: token });
        // Something offered names the piece it needs: that is the business's gap, not the payer's. Nothing offered at all
        // means every method was left out by its rule, currency or country, so the payer gets the form back to change the
        // amount.
        if (code === 'pay.checkout_no_method' && offer.offered.length > 0) {
          return send(reply, renderCheckoutPage({ kind: 'no_method', offer }, paths, look));
        }
        try {
          const link = { ...(await pay.resolvePaymentLink(token)), token };
          const problem =
            code === 'pay.checkout_no_method'
              ? 'This business takes no payment like this one. Check the amount.'
              : code === 'pay.checkout_method_not_offered'
                ? 'Choose one of the ways to pay listed here.'
                : undefined;
          return send(
            reply,
            renderCheckoutPage({ kind: 'choose_method', link, offer, values: answers, ...(problem ? { problem } : {}) }, paths, look),
          );
        } catch (linkErr) {
          return send(reply, renderCheckoutPage(stateForError(linkErr), paths));
        }
      }
      if (errorCode(err) === 'pay.checkout_amount_required') {
        return showLink(token, reply, resolvePayerCopy(PAYER_COPY_KEYS.invalidAmount));
      }
      // Only the country is the payer's to give. A blank risk band or an
      // ambiguous method is the operator's gap: the payer cannot fix it.
      if (errorCode(err) === 'pay.routing_input_missing') {
        const missing = missingDims(err);
        if (missing.length > 0 && missing.every((dim) => dim === 'geo')) {
          return showLink(token, reply, resolvePayerCopy(PAYER_COPY_KEYS.required));
        }
        return send(reply, renderCheckoutPage({ kind: 'unavailable' }, paths));
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
      return send(reply, renderCheckoutPage({ kind: 'session', session }, paths, await lookOf(pay, { sessionToken: token })));
    } catch (err) {
      return send(reply, renderCheckoutPage(stateForError(err), paths));
    }
  });
}
