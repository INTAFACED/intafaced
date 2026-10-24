// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
//
// The writes a page can make that no other part answers, plus the reads that arrived with them: refund a payment,
// make and switch off a payment link, set up and run a subscription, and the signed-in person's own sessions. Each one
// changes the one fixture world (mock/world.mjs), so the change shows up on every other page straight away.
// `mock-contract.test.ts` fails when a page calls a procedure that no part of the stand-in answers.
import { DAY, MERCHANT_ID, NOT_MINE, USER_ID, hex, iso, ok, refuse } from './shared.mjs';
import { fromU, toU } from './world.mjs';

const uuid = (prefix, n) => hex(prefix, n);
/** A TEST logo rule (100 KB), as the local stack publishes it; not an owner value. */
const TEST_LOGO_RULES = { logoMaxBytes: 100_000, logoTypes: ['image/png', 'image/jpeg', 'image/webp'] };
const decimalPlaces = (value) => (String(value).split('.')[1] ?? '').length;
const OWNER_ONLY = new Set([
  'payment.refund',
  'merchant.createLink',
  'merchant.deactivateLink',
  'subscription.create',
  'subscription.pause',
  'subscription.resume',
  'subscription.cancel',
  'mandate.create',
  'mandate.cancel',
  'merchant.profile',
]);

const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An https address with a host, as svc-pay's parseLinkConfirmation takes it. */
function httpsPage(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.href.startsWith('https://');
  } catch {
    return false;
  }
}

export function createWritesMock(ctx) {
  const { now, state, scenario, world } = ctx;
  const replays = new Map();
  // The real list carries only an id and when each sign-in began, so that is all this one carries: no device name, address,
  // last-seen time or "this one" flag, which the service does not return.
  const sessions = (state.sessions ??= [
    { id: uuid('51', 1), createdAt: iso(now - 2 * 3600_000), revoked: false },
    { id: uuid('51', 2), createdAt: iso(now - 6 * DAY), revoked: false },
  ]);
  const paymentView = ({ n: _n, linkId: _l, fee: _f, settlementId: _s, disputeId: _d, refundId: _r, ...row }) => row;

  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      if (OWNER_ONLY.has(procedure) && ctx.role !== 'owner') return refuse(route, 403, 'pay.merchant_forbidden');
      switch (procedure) {
        case 'payment.refund': {
          const p = world.paymentById(input.paymentId);
          if (!p) return refuse(route, 404, 'pay.payment_not_found');
          const replay = replays.get(`refund:${input.refundId}`);
          if (replay) return ok(route, paymentView(p));
          if (!['captured', 'settled', 'refunded'].includes(p.status)) return refuse(route, 412, 'pay.payment_not_refundable');
          const left = toU(p.capturedAmount) - toU(p.refundedAmount);
          if (toU(input.amount) <= 0n || toU(input.amount) > left || (p.assetId === 'USD' && decimalPlaces(input.amount) > 2))
            return refuse(route, 400, 'pay.refund_amount_invalid');
          const refundedAmount = fromU(toU(p.refundedAmount) + toU(input.amount));
          const createdAt = Date.now();
          // Money comes out of the pot it is in: still being settled until the payment is in a settlement, then the merchant's
          // settled money. The refund form and the ledger both say the same, because both read this.
          const fromSettled = p.settlementId !== null;
          p.refundedAmount = refundedAmount;
          if (toU(refundedAmount) === toU(p.capturedAmount)) p.status = 'refunded';
          p.refundId = input.refundId;
          // The network confirms a refund as it is posted, so the payment already says refunded (or part refunded). Every refund,
          // a part refund too, is one row here; the payment history reads these rows (payments/mock.mjs).
          world.refunds.unshift({
            id: uuid('c3', world.refunds.length + 1),
            refundId: input.refundId,
            paymentId: p.id,
            merchantId: MERCHANT_ID,
            amount: fromU(toU(input.amount)),
            assetId: p.assetId,
            reason: null,
            actor: USER_ID,
            status: 'settled',
            createdAt: iso(createdAt),
            settledAt: iso(createdAt),
            source: fromSettled ? 'settled' : 'clearing',
            ledgerEffect: {
              recorded: true,
              pot: fromSettled ? 'merchantProceeds' : 'clearing',
              ledgerTxId: uuid('c4', world.refunds.length + 1),
              direction: 'credit',
            },
            payment: { paymentId: p.id, status: p.status },
          });
          replays.set(`refund:${input.refundId}`, true);
          return ok(route, paymentView(p));
        }
        case 'merchant.createLink': {
          if (input.amount && !input.currency) return refuse(route, 400, 'pay.payment_link_currency_required');
          // As the service: a blank message and a page that is not https are refused before anything is made.
          const after = input.confirmation;
          const afterUrl = typeof after?.url === 'string' ? after.url.trim() : '';
          const afterMessage = typeof after?.message === 'string' ? after.message.trim() : '';
          if (after?.kind === 'redirect' && !afterUrl) return refuse(route, 400, 'pay.link_confirmation_unset');
          if (after?.kind === 'redirect' && !httpsPage(afterUrl)) return refuse(route, 400, 'pay.link_redirect_not_https');
          if (after?.kind === 'message' && (!afterMessage || afterMessage.length > 500))
            return refuse(route, 400, 'pay.link_confirmation_unset');
          // The same request sent twice (a lost reply, then "check and finish") makes one link, and answers the same way.
          const seenLink = input.idempotencyKey ? replays.get(`link:${input.idempotencyKey}`) : undefined;
          if (seenLink) return ok(route, seenLink);
          const n = world.links.length + 1;
          const prefix = `TESTl${n}`;
          // 30 days from the moment the link is made, not from when the stand-in started.
          const expiresAt = input.expiresAt ?? iso(Date.now() + 30 * DAY);
          const link = {
            id: uuid('1c', n),
            prefix,
            label: input.label,
            amount: input.amount ?? null,
            currency: input.currency ?? null,
            active: true,
            expiresAt,
            maxUses: input.maxUses ?? null,
            uses: 0,
            createdAt: iso(Date.now()),
            checkoutUrl: `/pay/checkout?token=TEST-token-${prefix}`,
            priceId: input.priceId ?? null,
            inactiveMessage: null,
            confirmationMessage: after?.kind === 'message' ? afterMessage : null,
            confirmationUrl: after?.kind === 'redirect' ? afterUrl : null,
            // As the service's paymentLinkEmbedSnippet: the label as the button's text, attributes and text escaped.
            embedSnippet: input.amount
              ? `<a href="/pay/checkout?token=TEST-token-${prefix}" data-amount="${escapeHtml(input.amount)}" data-asset="${escapeHtml(input.currency)}">${escapeHtml(input.label)}</a>`
              : null,
          };
          world.links.unshift(link);
          const made = {
            id: link.id,
            token: `TEST-token-${prefix}`,
            prefix,
            label: link.label,
            expiresAt,
            maxUses: link.maxUses,
            // the address a payer opens, built by the service, so a page never has to build one from its own address
            checkoutUrl: link.checkoutUrl,
          };
          if (input.idempotencyKey) replays.set(`link:${input.idempotencyKey}`, made);
          return ok(route, made);
        }
        case 'merchant.deactivateLink': {
          const link = world.links.find((l) => l.id === input.linkId);
          if (!link) return refuse(route, 404, 'pay.payment_link_not_found');
          // Turning a link off is one-way, and its message is the one sent with the first deactivate.
          if (!link.active) return ok(route, { deactivated: false });
          link.active = false;
          link.inactiveMessage = input.message?.trim() || null;
          return ok(route, { deactivated: true });
        }
        case 'merchant.checkoutSettings.get': {
          if (scenario === 'quiet') return ok(route, { status: 'not_configured' });
          const full = ctx.role === 'owner' || ctx.role === 'admin' || ctx.role === 'finance';
          return ok(route, {
            status: 'configured',
            profileId: uuid('ab', 9),
            checkoutConfig: {
              displayName: 'TEST Shop',
              statementDescriptor: 'TEST SHOP',
              locale: 'en',
              methods: ['crypto', 'card'],
            },
            feeRouting: full ? { payer: 'merchant', feeBps: 150, flatFee: '0.30' } : null,
            domains: ['checkout.shop.example.test'],
            createdAt: iso(now - 80 * DAY),
          });
        }
        case 'merchantCheckout.branding.get':
          return ok(route, { rules: TEST_LOGO_RULES, look: state.checkoutLook ?? { status: 'default' } });
        case 'merchantCheckout.branding.save': {
          if (ctx.role !== 'owner' && ctx.role !== 'admin') return refuse(route, 403, 'pay.team_role_forbidden');
          const version = state.checkoutLook?.version ?? 0;
          if (input.expectedVersion !== version) return refuse(route, 409, 'pay.checkout_branding_stale');
          let logo = state.checkoutLook?.logo ?? null;
          if (input.logo === null) logo = null;
          else if (input.logo) {
            const bytes = Buffer.from(input.logo.dataBase64, 'base64');
            if (bytes.length > TEST_LOGO_RULES.logoMaxBytes) return refuse(route, 400, 'pay.checkout_logo_too_large');
            if (!TEST_LOGO_RULES.logoTypes.includes(input.logo.contentType)) return refuse(route, 400, 'pay.checkout_logo_type_refused');
            logo = {
              contentType: input.logo.contentType,
              byteSize: bytes.length,
              sha256: '0'.repeat(64),
              dataBase64: input.logo.dataBase64,
            };
          }
          state.checkoutLook = {
            status: 'saved',
            brandColor: String(input.brandColor).toLowerCase(),
            logo,
            version: version + 1,
            updatedAt: iso(now),
          };
          return ok(route, { branding: { rules: TEST_LOGO_RULES, look: state.checkoutLook }, replayed: false });
        }
        case 'merchant.profile': {
          // Saves the checkout domains (a new checkout profile). The read above keeps answering from its fixed record.
          if (!Array.isArray(input.domains) || input.domains.length === 0) return refuse(route, 400, 'pay.invalid_input');
          return ok(route, { id: uuid('ab', 10), merchantId: MERCHANT_ID });
        }
        case 'mandate.create': {
          const row = {
            id: uuid('1d', world.mandates.length + 1),
            merchantId: MERCHANT_ID,
            customerId: input.customerId,
            assetId: input.assetId,
            amount: input.amount,
            ceiling: input.ceiling ?? null,
            cadence: input.cadence,
            startsAt: input.startsAt,
            endsAt: input.endsAt ?? null,
            railAdapter: input.railAdapter ?? null,
            railMandateRef: input.railMandateRef ?? null,
            status: 'active',
            cancelledAt: null,
            createdAt: iso(Date.now()),
          };
          world.mandates.unshift(row);
          return ok(route, row);
        }
        case 'mandate.cancel': {
          const m = world.mandates.find((x) => x.id === input.mandateId);
          if (!m) return refuse(route, 404, 'pay.mandate_not_found');
          Object.assign(m, { status: 'cancelled', cancelledAt: iso(Date.now()) });
          return ok(route, m);
        }
        case 'subscription.create': {
          const m = world.mandates.find((x) => x.id === input.mandateId);
          if (!m) return refuse(route, 404, 'pay.mandate_not_found');
          if (input.path !== 'crypto_invoice') return refuse(route, 412, 'pay.mandate_rail_absent');
          const seen = replays.get(`sub:${input.idempotencyKey}`);
          if (input.idempotencyKey && seen) return ok(route, seen);
          if (m.status !== 'active') return refuse(route, 409, 'pay.mandate_not_active');
          if (world.subscriptions.some((x) => x.mandateId === m.id && (x.status === 'active' || x.status === 'paused')))
            return refuse(route, 409, 'pay.subscription_already_open');
          const row = {
            id: uuid('1e', world.subscriptions.length + 1),
            mandateId: m.id,
            merchantId: MERCHANT_ID,
            customerId: m.customerId,
            nextRunAt: iso(Date.parse(m.startsAt) > Date.now() ? Date.parse(m.startsAt) : Date.now() + DAY),
            status: 'active',
            cancelledAt: null,
            path: input.path,
            createdAt: iso(Date.now()),
            anchorAt: iso(Date.now()),
            anchorOccurrence: 1,
            pausedAt: null,
            resumedAt: null,
            stalledAt: null,
            stallReason: null,
            priceId: input.priceId ?? null,
          };
          world.subscriptions.unshift(row);
          if (input.idempotencyKey) replays.set(`sub:${input.idempotencyKey}`, row);
          return ok(route, row);
        }
        case 'subscription.pause':
        case 'subscription.resume':
        case 'subscription.cancel': {
          const sub = world.subscriptions.find((x) => x.id === input.subscriptionId);
          if (!sub) return refuse(route, 404, 'pay.subscription_not_found');
          const at = iso(Date.now());
          if (procedure === 'subscription.pause') {
            if (sub.status !== 'active') return refuse(route, 409, 'pay.subscription_not_active');
            Object.assign(sub, { status: 'paused', pausedAt: at });
            return ok(route, sub);
          }
          if (procedure === 'subscription.resume') {
            if (sub.status !== 'paused') return refuse(route, 409, 'pay.subscription_not_paused');
            Object.assign(sub, { status: 'active', resumedAt: at, stalledAt: null, stallReason: null });
            return ok(route, { subscription: sub, projectedEnd: null });
          }
          if (sub.status !== 'active' && sub.status !== 'paused') return refuse(route, 409, 'pay.subscription_closed');
          Object.assign(sub, { status: 'cancelled', cancelledAt: at });
          return ok(route, sub);
        }
        case 'listSessions':
          return ok(route, { userId: input.userId ?? USER_ID, sessions: sessions.filter((s) => !s.revoked) });
        case 'revokeSession': {
          const seat = sessions.find((s) => s.id === input.sessionId);
          if (!seat) return refuse(route, 404, 'auth.session_not_found');
          seat.revoked = true;
          return ok(route, { userId: input.userId ?? USER_ID, sessionId: seat.id, revoked: true });
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
