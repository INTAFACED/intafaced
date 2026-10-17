// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, hex, iso, ok, page, refuse } from '../mock/shared.mjs';
import { fromU, isTaken, toU } from '../mock/world.mjs';

/** Payments, disputes and customers. */
export function createPaymentsMock(ctx) {
  const { now, state, activity } = ctx;
  const world = ctx.world;
  Object.assign(state, {
    disputes: world.disputes,
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
    customers: world.customers,
  });

  // ---- links, subscriptions, mandates (TEST data; real-shaped ids; lists come back as pages, as on main) ----
  state.links = world.links;
  state.mandates = world.mandates;
  state.subscriptions = world.subscriptions;

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
        invoiceRow(3, 'paid', {
          amount: '54.26',
          customerRef: world.payments[1].customerRef,
          paymentId: world.payments[1].id,
          paidAt: world.payments[1].createdAt,
        }),
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
  const payments = world.payments;
  /** A payment as the service sends it: the world's bookkeeping fields (link, fee, ids of what it belongs to) stay behind. */
  const asPayment = ({ n: _n, linkId: _l, fee: _f, settlementId: _s, disputeId: _d, refundId: _r, ...row }) => row;
  const historyOf = (p) => {
    const t0 = Date.parse(p.createdAt);
    let seq = 0;
    // `ts` is the moment the thing happened, in ms: events are then put in time order, so a history always reads as it happened
    const ev = (event, payload, ts) => ({
      id: hex('ee', p.n * 100 + ++seq),
      event,
      payload,
      railEventId: null,
      ts: iso(ts),
    });
    const minutes = (k) => t0 + k * 60_000;
    const out = [
      ev(
        'created',
        {
          amount: p.amount,
          assetId: p.assetId,
          customerRef: p.customerRef,
          instrument: { kind: 'token', token: 'tok_TEST_must_never_show' },
        },
        t0,
      ),
      ev('rail.authorize', { raw: 'rail internals' }, minutes(1)),
    ];
    if (p.status !== 'created' && p.status !== 'failed') out.push(ev('authorized', { amount: p.amount, railRef: p.railRef }, minutes(2)));
    if (['captured', 'settled', 'refunded', 'disputed'].includes(p.status) || toU(p.refundedAmount) > 0n)
      out.push(ev('captured', { amount: p.amount, railRef: p.railRef, ledgerTxId: 'TEST-ledger-tx-0001' }, minutes(5)));
    const settlement = p.settlementId ? world.settlementById(p.settlementId) : null;
    if (settlement)
      out.push(
        ev(
          'settled',
          { settlementId: settlement.id, window: settlement.window, assetId: p.assetId },
          Math.max(Date.parse(settlement.createdAt), minutes(6)),
        ),
      );
    // Every refund on the payment, a part refund included, is posted to the ledger and then confirmed by the network. The
    // service puts the same refund id on both events, which is how a page proves that a refund it sent went through.
    for (const refund of world.refundsOf(p.id)) {
      const at = Date.parse(refund.createdAt);
      out.push(
        ev('refund.posted', { refundId: refund.refundId, amount: refund.amount, source: 'balance', ledgerTxId: 'TEST-ledger-tx-0002' }, at),
      );
      if (refund.status === 'settled')
        out.push(
          ev(
            'refunded',
            { refundId: refund.refundId, amount: refund.amount, source: 'balance', railRef: `${p.railRef}-refund` },
            Date.parse(refund.settledAt),
          ),
        );
      if (refund.status === 'reversed')
        out.push(ev('refund.reversed', { refundId: refund.refundId, amount: refund.amount, source: 'balance' }, at + 2 * 3600_000));
    }
    const dispute = p.disputeId ? world.disputes.find((d) => d.disputeId === p.disputeId) : null;
    if (dispute)
      out.push(
        ev(
          'disputed',
          { disputeId: dispute.disputeId, reasonCode: dispute.reasonCode ?? 'other', ledgerWire: 'refused' },
          Date.parse(dispute.openedAt),
        ),
      );
    if (p.status === 'failed') out.push(ev('failed', { failureCode: 'rail.TEST_internal_code' }, minutes(3)));
    return out.sort((x, y) => x.ts.localeCompare(y.ts));
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
              (!input.linkId || p.linkId === input.linkId) &&
              (!input.search || p.customerRef === input.search || p.id === input.search.toLowerCase()),
          );
          const paged = page(rows, input);
          return ok(route, { ...paged, items: paged.items.map(asPayment) });
        }
        case 'payment.get': {
          const p = payments.find((x) => x.id === input.paymentId);
          return p ? ok(route, asPayment(p)) : refuse(route, 404, 'pay.payment_not_found');
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
        case 'merchant.listLinks': {
          const rows = state.links.filter(
            (l) =>
              (input.active === undefined || l.active === input.active) &&
              (!input.assetId || l.currency === input.assetId) &&
              (!input.search || l.label.toLowerCase().includes(input.search.toLowerCase()) || l.prefix === input.search),
          );
          return ok(route, page(rows, input));
        }
        case 'subscription.list': {
          const rows = state.subscriptions.filter(
            (x) =>
              (!input.status || x.status === input.status) &&
              (input.active === undefined || (x.status === 'active' || x.status === 'paused') === input.active) &&
              (!input.mandateId || x.mandateId === input.mandateId) &&
              (!input.customerId || x.customerId === input.customerId),
          );
          return ok(route, page(rows, input));
        }
        case 'mandate.list': {
          const rows = state.mandates.filter(
            (x) => (!input.status || x.status === input.status) && (!input.customerId || x.customerId === input.customerId),
          );
          return ok(route, page(rows, input));
        }
        case 'subscription.get': {
          const x = state.subscriptions.find((y) => y.id === input.subscriptionId);
          return x ? ok(route, x) : refuse(route, 404, 'pay.subscription_not_found');
        }
        case 'mandate.get': {
          const x = state.mandates.find((y) => y.id === input.mandateId);
          return x ? ok(route, x) : refuse(route, 404, 'pay.mandate_not_found');
        }
        case 'subscription.listExecutions':
          return ok(route, world.executionsOf(input.subscriptionId));
        case 'subscription.cycles':
          return ok(route, { subscriptionId: input.subscriptionId, cycles: world.cyclesOf(input.subscriptionId) });
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
          const atRisk = new Map();
          for (const d of state.disputes.filter((x) => x.status === 'open' || x.status === 'contested'))
            atRisk.set(d.assetId, (atRisk.get(d.assetId) ?? 0n) + toU(d.amount));
          return ok(route, {
            total: state.disputes.length,
            byStatus: by,
            amountAtRisk: [...atRisk].map(([assetId, amount]) => ({ assetId, amount: fromU(amount) })),
          });
        }
        case 'merchantOps.disputes.list':
          return ok(
            route,
            page(
              state.disputes.filter(
                (d) =>
                  (!input.status || d.status === input.status) &&
                  (!input.assetId || d.assetId === input.assetId) &&
                  (!input.from || d.openedAt >= input.from) &&
                  (!input.to || d.openedAt < input.to),
              ),
              input,
            ),
          );
        case 'merchantOps.disputes.get': {
          const d = state.disputes.find((x) => x.disputeId === input.disputeId);
          if (!d) return refuse(route, 404, 'pay.dispute_not_found');
          return ok(route, {
            ...d,
            canRespond: d.status === 'open' || d.status === 'contested',
            evidence: state.evidence[d.disputeId] ?? [],
            responses: state.responses[d.disputeId] ?? [],
            payment: (() => {
              const p = world.paymentById(d.paymentId);
              return { paymentId: p.id, status: p.status, assetId: p.assetId, amount: p.amount, createdAt: p.createdAt };
            })(),
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
            activeSinceCount: state.customers.filter((c) => !input.activeSince || c.lastSeenAt >= input.activeSince).length,
            repeatCustomerCount: state.customers.filter((c) => c.paymentCount > 1).length,
            activeSince: input.activeSince,
          });
        case 'merchantOps.customers.list': {
          const rows = input.search
            ? state.customers.filter((c) => c.customerRef.toLowerCase().startsWith(input.search.toLowerCase()))
            : state.customers;
          return ok(route, page(rows, input));
        }
        case 'merchantOps.customers.series': {
          // the customer's own payments, one row per day and asset, newest first
          const from = Date.parse(input.from);
          const to = Date.parse(input.to);
          const rows = new Map();
          for (const p of payments.filter((x) => x.customerRef === input.customerRef && isTaken(x.status))) {
            const at = Date.parse(p.createdAt);
            if (at < from || at >= to + DAY) continue;
            const key = `${world.day(at)}|${p.assetId}`;
            const row = rows.get(key) ?? { period: world.day(at), assetCode: p.assetId, count: 0, volume: 0n };
            row.count += 1;
            row.volume += toU(p.capturedAmount);
            rows.set(key, row);
          }
          return ok(route, {
            customerRef: input.customerRef,
            bucket: 'day',
            from: input.from.slice(0, 10),
            to: input.to.slice(0, 10),
            items: [...rows.values()]
              .sort((x, y) => y.period.localeCompare(x.period))
              .map((r) => ({ period: r.period, assetCode: r.assetCode, count: r.count, volume: fromU(r.volume) })),
            nextCursor: null,
          });
        }
        case 'merchantOps.customers.get': {
          const c = state.customers.find((x) => x.customerRef === input.customerRef);
          if (!c) return refuse(route, 404, 'pay.customer_not_found');
          return ok(route, {
            ...c,
            recentPayments: payments
              .filter((p) => p.customerRef === c.customerRef)
              .slice(0, 5)
              .map((p) => ({ paymentId: p.id, status: p.status, assetId: p.assetId, amount: p.amount, createdAt: p.createdAt })),
          });
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
