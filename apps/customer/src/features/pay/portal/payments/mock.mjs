// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, hex, iso, ok, page, refuse } from '../mock/shared.mjs';

/** Payments, disputes and customers. */
export function createPaymentsMock(ctx) {
  const { now, state, activity } = ctx;
  Object.assign(state, {
    disputes: [
      {
        disputeId: 'd0000001-0000-4000-8000-000000000001',
        paymentId: 'p0000001-0000-4000-8000-000000000001',
        amount: '49.99',
        assetId: 'USDT',
        reasonCode: 'fraudulent',
        status: 'open',
        openedAt: iso(now - 3 * DAY),
        contestedAt: null,
        closedAt: null,
        responseDueAt: null,
        ledgerWire: 'refused',
        ledgerRefuseCode: 'pay.chargeback_wire_absent',
      },
      {
        disputeId: 'd0000002-0000-4000-8000-000000000002',
        paymentId: 'p0000002-0000-4000-8000-000000000002',
        amount: '120',
        assetId: 'USDT',
        reasonCode: 'product_not_received',
        status: 'contested',
        openedAt: iso(now - 9 * DAY),
        contestedAt: iso(now - 7 * DAY),
        closedAt: null,
        responseDueAt: null,
        ledgerWire: 'refused',
        ledgerRefuseCode: 'pay.chargeback_wire_absent',
      },
      {
        disputeId: 'd0000003-0000-4000-8000-000000000003',
        paymentId: 'p0000003-0000-4000-8000-000000000003',
        amount: '15.5',
        assetId: 'USDT',
        reasonCode: null,
        status: 'won',
        openedAt: iso(now - 30 * DAY),
        contestedAt: iso(now - 28 * DAY),
        closedAt: iso(now - 20 * DAY),
        responseDueAt: null,
        ledgerWire: 'refused',
        ledgerRefuseCode: 'pay.chargeback_wire_absent',
      },
    ],
    evidence: {
      'd0000002-0000-4000-8000-000000000002': [
        {
          evidenceId: 'e1',
          kind: 'shipping_proof',
          fileName: 'TEST-tracking.pdf',
          contentType: 'application/pdf',
          sizeBytes: '48213',
          sha256: 'ab'.repeat(32),
          note: 'TEST tracking page',
          addedBy: USER_ID,
          createdAt: iso(now - 8 * DAY),
        },
      ],
    },
    responses: {
      'd0000002-0000-4000-8000-000000000002': [
        {
          responseId: 'r1',
          action: 'contest',
          note: null,
          resultingStatus: 'contested',
          evidenceCount: 1,
          respondedBy: USER_ID,
          createdAt: iso(now - 7 * DAY),
        },
      ],
    },
    customers: Array.from({ length: 30 }, (_, i) => ({
      customerRef: `TEST-cust-${String(30 - i).padStart(3, '0')}`,
      paymentCount: 1 + (i % 5),
      subscriptionCount: i % 7 === 0 ? 1 : 0,
      mandateCount: 0,
      firstSeenAt: iso(now - (60 - i) * DAY),
      lastSeenAt: iso(now - i * DAY),
      totals: [
        { assetId: 'USDT', capturedAmount: `${100 + i * 12}.5`, refundedAmount: i % 6 === 0 ? '10' : '0', paymentCount: 1 + (i % 5) },
      ],
    })),
  });

  // ---- links, subscriptions, mandates (TEST data; real-shaped ids; lists come back as pages, as on main) ----
  state.links = activity
    ? Array.from({ length: 8 }, (_, i) => ({
        id: hex('1c', i + 1),
        prefix: `TESTl${i + 1}`,
        label: `TEST link ${i + 1}`,
        amount: i % 2 ? '25.00' : null,
        currency: i % 2 ? 'USDT' : null,
        active: i !== 3,
        expiresAt: iso(now + (i === 5 ? -2 : 20) * DAY),
        maxUses: i % 3 === 0 ? 10 : null,
        uses: i,
        createdAt: iso(now - (i + 1) * DAY),
      }))
    : [];
  state.mandates = activity
    ? Array.from({ length: 4 }, (_, i) => ({
        id: hex('1d', i + 1),
        merchantId: MERCHANT_ID,
        customerId: `TEST-cust-${String(i + 1).padStart(3, '0')}`,
        assetId: 'USDT',
        amount: '19.00',
        ceiling: i % 2 ? '25.00' : null,
        cadence: 'monthly',
        startsAt: iso(now - 40 * DAY),
        endsAt: null,
        railAdapter: 'crypto-native',
        railMandateRef: null,
        status: i === 3 ? 'cancelled' : 'active',
        cancelledAt: i === 3 ? iso(now - DAY) : null,
        createdAt: iso(now - 40 * DAY),
      }))
    : [];
  state.subscriptions = activity
    ? state.mandates.map((m, i) => ({
        id: hex('1e', i + 1),
        mandateId: m.id,
        merchantId: MERCHANT_ID,
        customerId: m.customerId,
        nextRunAt: iso(now + (i + 1) * DAY),
        status: ['active', 'active', 'paused', 'cancelled'][i],
        cancelledAt: i === 3 ? iso(now - DAY) : null,
        path: 'crypto_invoice',
        createdAt: iso(now - 40 * DAY),
        anchorAt: iso(now - 40 * DAY),
        anchorOccurrence: 1,
        pausedAt: i === 2 ? iso(now - 2 * DAY) : null,
        resumedAt: null,
        stalledAt: i === 2 ? iso(now - 2 * DAY) : null,
        stallReason: i === 2 ? 'arrears' : null,
      }))
    : [];

  // ---- invoices (TEST data): every status, so the list, the filters and each action can be shown ----
  const invoiceRow = (n, status, extra = {}) => ({
    id: hex('1a', n),
    status,
    assetId: 'USDT',
    amount: '120.00',
    customerRef: `TEST-cust-${String(n).padStart(3, '0')}`,
    description: `TEST invoice ${n}`,
    paymentLinkId: status === 'sent' || status === 'paid' ? hex('1b', n) : null,
    paymentId: null,
    sentAt: status === 'sent' || status === 'paid' ? iso(now - (n + 1) * DAY) : null,
    voidedAt: status === 'void' ? iso(now - n * DAY) : null,
    paidAt: null,
    createdAt: iso(now - (n + 2) * DAY),
    updatedAt: iso(now - n * DAY),
    ...extra,
  });
  state.invoices = activity
    ? [
        invoiceRow(1, 'draft', { amount: '250.5', customerRef: null }),
        invoiceRow(2, 'sent', { amount: '47.13', customerRef: 'TEST-cust-001' }),
        invoiceRow(3, 'paid', { amount: '54.26', paymentId: hex('aa', 2), paidAt: iso(now - DAY) }),
        invoiceRow(4, 'void'),
        invoiceRow(5, 'sent', { amount: '1999.999999' }),
        ...Array.from({ length: 24 }, (_, i) => invoiceRow(6 + i, ['draft', 'sent', 'paid', 'void'][i % 4], { amount: `${100 + i}.00` })),
      ]
    : [];
  const invoiceActions = new Map();
  const mintLink = (invoice) => ({
    id: invoice.paymentLinkId,
    prefix: 'TESTlink',
    expiresAt: iso(now + 30 * DAY),
    maxUses: 1,
    token: `TEST-token-${invoice.id.slice(0, 8)}`,
    alreadyIssued: false,
  });
  const STATUSES = ['captured', 'settled', 'captured', 'refunded', 'failed', 'settled', 'authorized', 'captured', 'disputed', 'created'];
  const payments = activity
    ? Array.from({ length: 60 }, (_, i) => {
        // newest first, as the service returns them
        const n = i + 1;
        const status = STATUSES[n % STATUSES.length];
        const asset = n % 7 === 0 ? 'USD' : 'USDT';
        const amount = `${40 + n * 7}.${String((n * 13) % 100).padStart(2, '0')}`;
        const taken = ['captured', 'settled', 'refunded', 'disputed'].includes(status);
        return {
          id: n === 3 ? 'aa000003-0000-4000-8000-000000000003' : hex('aa', n),
          merchantId: MERCHANT_ID,
          profileId: null,
          customerRef: `TEST-cust-${String(((n - 1) % 12) + 1).padStart(3, '0')}`,
          description: `TEST order ${1000 + n}`,
          amount,
          assetId: asset,
          method: n % 2 ? 'TEST-crypto-transfer' : 'TEST-card-sandbox',
          railAdapter: n % 2 ? 'crypto-native' : 'card-sandbox',
          railRef: status === 'created' ? null : `TEST-rail-${String(n).padStart(4, '0')}`,
          status,
          capturedAmount: taken ? amount : '0',
          refundedAmount: status === 'refunded' ? amount : '0',
          createdAt: iso(now - n * 3 * 3600_000),
          pricingSnapshot:
            n % 5 === 0
              ? null
              : {
                  fee: '1.20',
                  assetCode: asset,
                  appliedLayer: 'tier',
                  ruleId: hex('ab', 1),
                  feeBps: 150,
                  flatFee: '0.30',
                  spreadBps: null,
                  roundingBeneficiary: 'platform',
                  roundingMode: 'ceil',
                  bookedFee: null,
                  reserveAmount: null,
                  recordedAt: iso(now - n * 3 * 3600_000),
                },
          failure: status === 'failed' ? { code: 'card_declined', message: 'The card was declined.' } : null,
        };
      })
    : [];
  const historyOf = (p) => {
    const t0 = Date.parse(p.createdAt);
    const ev = (event, payload, k) => ({
      id: hex('ee', Math.floor(Math.random() * 1e6)),
      event,
      payload,
      railEventId: null,
      ts: iso(t0 + k * 60_000),
    });
    const out = [
      ev(
        'created',
        {
          amount: p.amount,
          assetId: p.assetId,
          customerRef: 'TEST-cust-001',
          instrument: { kind: 'token', token: 'tok_TEST_must_never_show' },
        },
        0,
      ),
      ev('rail.authorize', { raw: 'rail internals' }, 1),
    ];
    if (p.status !== 'created' && p.status !== 'failed') out.push(ev('authorized', { amount: p.amount, railRef: p.railRef }, 2));
    if (['captured', 'settled', 'refunded', 'disputed'].includes(p.status))
      out.push(ev('captured', { amount: p.amount, railRef: p.railRef, ledgerTxId: 'TEST-ledger-tx-0001' }, 5));
    if (p.status === 'settled')
      out.push(ev('settled', { settlementId: 'bb000002-0000-4000-8000-000000000002', window: 'TEST-2026-W40', assetId: p.assetId }, 600));
    if (p.status === 'refunded') {
      out.push(
        ev('refund.posted', { refundId: 'TEST-refund-1', amount: p.amount, source: 'balance', ledgerTxId: 'TEST-ledger-tx-0002' }, 900),
      );
      out.push(ev('refunded', { refundId: 'TEST-refund-1', amount: p.amount, source: 'balance', railRef: 'TEST-rail-refund' }, 901));
    }
    if (p.status === 'disputed')
      out.push(
        ev('disputed', { disputeId: 'd0000001-0000-4000-8000-000000000001', reasonCode: 'fraudulent', ledgerWire: 'refused' }, 1200),
      );
    if (p.status === 'failed') out.push(ev('failed', { failureCode: 'rail.TEST_internal_code' }, 3));
    return out;
  };
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'payment.list': {
          const rows = payments.filter(
            (p) =>
              (!input.status || p.status === input.status) &&
              (!input.assetId || p.assetId === input.assetId) &&
              (!input.from || p.createdAt >= input.from) &&
              (!input.to || p.createdAt < input.to) &&
              (!input.search || p.customerRef === input.search || p.id === input.search.toLowerCase()),
          );
          return ok(route, page(rows, input));
        }
        case 'payment.refunds.list': {
          const p = payments.find((x) => x.id === input.paymentId);
          if (!p || p.status !== 'refunded') return ok(route, { items: [], nextCursor: null });
          return ok(route, {
            items: [
              {
                id: hex('rf', 1),
                refundId: 'TEST-refund-1',
                paymentId: p.id,
                merchantId: MERCHANT_ID,
                amount: p.amount,
                assetId: p.assetId,
                reason: null,
                actor: null,
                status: 'posted',
                createdAt: iso(Date.parse(p.createdAt) + 900_000),
                settledAt: null,
                source: 'clearing',
                ledgerEffect: { recorded: true, pot: 'clearing', ledgerTxId: null, direction: 'credit' },
                payment: { paymentId: p.id, status: p.status },
              },
            ],
            nextCursor: null,
          });
        }
        case 'merchantOps.activity.list': {
          const items = input.search
            ? ['created', 'captured'].map((action, k) => ({
                id: `act-${k}`,
                occurredAt: iso(now - (k + 1) * 3600_000),
                actorId: 'system',
                action: `payment_${action}`,
                objectType: 'payment',
                objectId: input.search,
                detail: { status: action },
              }))
            : [];
          return ok(route, { items, nextCursor: null });
        }
        case 'payment.get': {
          const p = payments.find((x) => x.id === input.paymentId);
          return p ? ok(route, p) : refuse(route, 404, 'pay.payment_not_found');
        }
        case 'payment.history': {
          const p = payments.find((x) => x.id === input.paymentId);
          return p ? ok(route, historyOf(p)) : refuse(route, 404, 'pay.payment_not_found');
        }
        case 'merchantControl.tiers.list':
          return ok(route, {
            status: 'configured',
            ownTierId: 'standard',
            tiers: [{ id: 'standard', name: 'Standard (TEST)', archetype: 'standard', caps: [], reserve: null, version: 'v1' }],
          });
        case 'merchantOps.invoices.list': {
          const inRange = (i) => (!input.from || i.createdAt >= input.from) && (!input.to || i.createdAt < input.to);
          const rows = state.invoices.filter(
            (i) =>
              (!input.status || i.status === input.status) &&
              (!input.assetId || i.assetId === input.assetId) &&
              inRange(i) &&
              (!input.search || i.customerRef === input.search || i.id === input.search.toLowerCase()),
          );
          return ok(route, page(rows, input));
        }
        case 'merchantOps.invoices.get': {
          const i = state.invoices.find((x) => x.id === input.invoiceId);
          return i ? ok(route, i) : refuse(route, 404, 'pay.invoice_not_found');
        }
        case 'merchantOps.invoices.create': {
          const seen = invoiceActions.get(input.requestId);
          if (seen) return ok(route, seen);
          if (!/^\d+(\.\d+)?$/.test(input.amount) || !/[1-9]/.test(input.amount)) return refuse(route, 400, 'pay.invoice_amount_invalid');
          const row = invoiceRow(state.invoices.length + 40, 'draft', {
            amount: input.amount,
            assetId: input.assetId,
            customerRef: input.customerRef ?? null,
            description: input.description ?? null,
            createdAt: iso(Date.now()),
            updatedAt: iso(Date.now()),
          });
          state.invoices.unshift(row);
          invoiceActions.set(input.requestId, row);
          return ok(route, row);
        }
        case 'merchantOps.invoices.send':
        case 'merchantOps.invoices.reissueLink': {
          const i = state.invoices.find((x) => x.id === input.invoiceId);
          if (!i) return refuse(route, 404, 'pay.invoice_not_found');
          const sending = procedure.endsWith('send');
          if (sending && i.status !== 'draft')
            return refuse(route, 409, i.status === 'sent' ? 'pay.invoice_already_sent' : 'pay.invoice_not_draft');
          if (!sending && i.status !== 'sent') return refuse(route, 409, 'pay.invoice_not_draft');
          const seen = invoiceActions.get(input.requestId);
          if (seen) return ok(route, { invoice: i, paymentLink: { ...seen, token: null, alreadyIssued: true } });
          if (sending) {
            i.status = 'sent';
            i.sentAt = iso(Date.now());
          }
          i.paymentLinkId = hex('1c', Math.floor(Math.random() * 1e6));
          i.updatedAt = iso(Date.now());
          const link = mintLink(i);
          invoiceActions.set(input.requestId, link);
          return ok(route, { invoice: i, paymentLink: link });
        }
        case 'merchantOps.invoices.void': {
          const i = state.invoices.find((x) => x.id === input.invoiceId);
          if (!i) return refuse(route, 404, 'pay.invoice_not_found');
          if (i.status === 'paid') return refuse(route, 409, 'pay.invoice_paid');
          if (i.status === 'void') return refuse(route, 409, 'pay.invoice_void');
          i.status = 'void';
          i.voidedAt = iso(Date.now());
          i.updatedAt = iso(Date.now());
          return ok(route, i);
        }
        case 'merchantOps.invoices.markPaidByPayment': {
          const i = state.invoices.find((x) => x.id === input.invoiceId);
          if (!i) return refuse(route, 404, 'pay.invoice_not_found');
          if (i.status !== 'draft' && i.status !== 'sent')
            return refuse(route, 409, i.status === 'paid' ? 'pay.invoice_paid' : 'pay.invoice_void');
          const p = payments.find((x) => x.id === input.paymentId);
          if (!p) return refuse(route, 404, 'pay.invoice_payment_not_found');
          if (!['captured', 'settled'].includes(p.status)) return refuse(route, 412, 'pay.invoice_payment_not_paid');
          if (p.assetId !== i.assetId || Number(p.amount) !== Number(i.amount)) return refuse(route, 412, 'pay.invoice_payment_mismatch');
          i.status = 'paid';
          i.paymentId = p.id;
          i.paidAt = iso(Date.now());
          i.updatedAt = iso(Date.now());
          return ok(route, i);
        }
        case 'merchant.listLinks':
          return ok(route, page(state.links, input));
        case 'subscription.list':
          return ok(route, page(state.subscriptions, input));
        case 'mandate.list':
          return ok(route, page(state.mandates, input));
        case 'subscription.get': {
          const x = state.subscriptions.find((y) => y.id === input.subscriptionId);
          return x ? ok(route, x) : refuse(route, 404, 'pay.subscription_not_found');
        }
        case 'mandate.get': {
          const x = state.mandates.find((y) => y.id === input.mandateId);
          return x ? ok(route, x) : refuse(route, 404, 'pay.mandate_not_found');
        }
        case 'subscription.listExecutions':
          return ok(
            route,
            [1, 2].map((n) => ({
              id: hex('1f', n),
              subscriptionId: input.subscriptionId,
              occurrence: n,
              amount: '19.00',
              status: n === 1 ? 'settled' : 'rejected',
              paymentId: n === 1 ? hex('aa', 1) : null,
              rejectionCode: n === 1 ? null : 'pay.insufficient_funds',
              attemptedAt: iso(now - (3 - n) * 10 * DAY),
              settledAt: n === 1 ? iso(now - 29 * DAY) : null,
              createdAt: iso(now - (3 - n) * 10 * DAY),
              notifyStatus: null,
              notifyCode: null,
            })),
          );
        case 'subscription.cycles':
          return ok(route, { subscriptionId: input.subscriptionId, cycles: [] });
        case 'subscription.productReady':
          return ok(route, {
            paths: [{ path: 'crypto_invoice', charge: 'open_crypto_invoice', opensMoney: true, posture: 'TEST posture' }],
            preChargeNotify: { status: 'unwired', notified: false, merchantReadable: 'TEST notices are not connected' },
            card: { status: 'refuse_closed', code: 'pay.mandate_rail_absent' },
          });
        case 'merchantOps.disputes.uploadEvidence': {
          const row = {
            evidenceId: `e${Date.now()}`,
            kind: input.kind,
            fileName: input.fileName,
            contentType: input.contentType,
            sizeBytes: String(Math.floor((input.contentBase64.length * 3) / 4)),
            sha256: input.sha256 ?? 'cd'.repeat(32),
            note: input.note ?? null,
            addedBy: USER_ID,
            createdAt: iso(Date.now()),
            hasContent: true,
          };
          (state.evidence[input.disputeId] ??= []).push({ ...row, content: input.contentBase64 });
          return ok(route, row);
        }
        case 'merchantOps.disputes.getEvidence': {
          const all = Object.values(state.evidence).flat();
          const e = all.find((x) => x.evidenceId === input.evidenceId);
          if (!e) return refuse(route, 404, 'pay.dispute_evidence_not_found');
          if (!e.content) return refuse(route, 409, 'pay.dispute_evidence_content_absent');
          return ok(route, e);
        }
        case 'merchantOps.disputes.summary': {
          const by = { open: 0, contested: 0, accepted: 0, won: 0, lost: 0 };
          for (const d of state.disputes) by[d.status] += 1;
          return ok(route, { total: state.disputes.length, byStatus: by, amountAtRisk: [{ assetId: 'USDT', amount: '169.99' }] });
        }
        case 'merchantOps.disputes.list':
          return ok(route, page(input.status ? state.disputes.filter((d) => d.status === input.status) : state.disputes, input));
        case 'merchantOps.disputes.get': {
          const d = state.disputes.find((x) => x.disputeId === input.disputeId);
          if (!d) return refuse(route, 404, 'pay.dispute_not_found');
          return ok(route, {
            ...d,
            canRespond: d.status === 'open' || d.status === 'contested',
            evidence: state.evidence[d.disputeId] ?? [],
            responses: state.responses[d.disputeId] ?? [],
            payment: { paymentId: d.paymentId, status: 'disputed', assetId: d.assetId, amount: d.amount, createdAt: iso(now - 12 * DAY) },
          });
        }
        case 'merchantOps.disputes.addEvidence': {
          const row = {
            evidenceId: `e${Date.now()}`,
            kind: input.kind,
            fileName: input.fileName,
            contentType: input.contentType,
            sizeBytes: String(input.sizeBytes),
            sha256: input.sha256,
            note: input.note ?? null,
            addedBy: USER_ID,
            createdAt: iso(Date.now()),
          };
          (state.evidence[input.disputeId] ??= []).push(row);
          return ok(route, row);
        }
        case 'merchantOps.disputes.respond': {
          const d = state.disputes.find((x) => x.disputeId === input.disputeId);
          if (input.action === 'contest' && !(state.evidence[input.disputeId] ?? []).length)
            return refuse(route, 412, 'pay.dispute_evidence_required');
          d.status = input.action === 'contest' ? 'contested' : 'accepted';
          (state.responses[input.disputeId] ??= []).push({
            responseId: `r${Date.now()}`,
            action: input.action,
            note: input.note ?? null,
            resultingStatus: d.status,
            evidenceCount: (state.evidence[input.disputeId] ?? []).length,
            respondedBy: USER_ID,
            createdAt: iso(Date.now()),
          });
          return ok(route, {
            ...d,
            canRespond: d.status === 'contested',
            evidence: state.evidence[input.disputeId] ?? [],
            responses: state.responses[input.disputeId],
            payment: null,
          });
        }
        case 'merchantOps.customers.summary':
          return ok(route, {
            customerCount: state.customers.length,
            activeSinceCount: 18,
            repeatCustomerCount: 22,
            activeSince: input.activeSince,
          });
        case 'merchantOps.customers.list': {
          const rows = input.search
            ? state.customers.filter((c) => c.customerRef.toLowerCase().startsWith(input.search.toLowerCase()))
            : state.customers;
          return ok(route, page(rows, input));
        }
        case 'merchantOps.customers.get': {
          const c = state.customers.find((x) => x.customerRef === input.customerRef);
          if (!c) return refuse(route, 404, 'pay.customer_not_found');
          return ok(route, {
            ...c,
            recentPayments: Array.from({ length: 5 }, (_, i) => ({
              paymentId: `${i}0000000-aaaa-4bbb-8ccc-dddddddddddd`,
              status: i === 1 ? 'refunded' : 'captured',
              assetId: 'USDT',
              amount: `${40 + i * 15}.25`,
              createdAt: iso(now - (i + 1) * 3 * DAY),
            })),
          });
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
