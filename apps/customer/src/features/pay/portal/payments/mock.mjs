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
          amount,
          assetId: asset,
          method: n % 2 ? 'TEST-crypto-transfer' : 'TEST-card-sandbox',
          railAdapter: n % 2 ? 'crypto-native' : 'card-sandbox',
          railRef: status === 'created' ? null : `TEST-rail-${String(n).padStart(4, '0')}`,
          status,
          capturedAmount: taken ? amount : '0',
          refundedAmount: status === 'refunded' ? amount : '0',
          createdAt: iso(now - n * 3 * 3600_000),
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
          const rows = payments.filter((p) => !input.status || p.status === input.status).slice(0, input.limit ?? 25);
          return ok(route, { items: rows, nextCursor: null });
        }
        case 'payment.get': {
          const p = payments.find((x) => x.id === input.paymentId);
          return p ? ok(route, p) : refuse(route, 404, 'pay.payment_not_found');
        }
        case 'payment.history': {
          const p = payments.find((x) => x.id === input.paymentId);
          return p ? ok(route, historyOf(p)) : refuse(route, 404, 'pay.payment_not_found');
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
