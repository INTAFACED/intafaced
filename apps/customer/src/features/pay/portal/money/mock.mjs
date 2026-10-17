// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, hex, iso, ok, page, refuse } from '../mock/shared.mjs';

/** Settlements, approvals, pricing and limits. */
export function createMoneyMock(ctx) {
  const { now, activity, state } = ctx;
  const settlements = activity
    ? [
        ['bb000006', 'TEST-2026-W41', 'USDT', '2200.50', '33.01', '2167.49', 'posted', null, null],
        ['bb000005', 'TEST-2026-W40b', 'USD', '310', '4.65', '305.35', 'failed', null, null],
        ['bb000004', 'TEST-2026-W41b', 'USDT', '120', '1.8', '118.2', 'pending', null, null],
        ['bb000003', 'TEST-2026-W40a', 'USDT', '980.25', '14.7', '965.55', 'posted', null, null],
        ['bb000002', 'TEST-2026-W40', 'USDT', '4100.75', '61.51', '4039.24', 'paid_out', 'crypto-native', 'TEST-tx-0xabc123'],
        ['bb000001', 'TEST-2026-W39', 'USDT', '3900', '58.5', '3841.5', 'paid_out', 'crypto-native', 'TEST-tx-0xdef456'],
      ].map(([short, window, assetId, gross, fees, net, status, payoutMethod, payoutRef], i) => ({
        id: `${short}-0000-4000-8000-00000000000${6 - i}`,
        merchantId: MERCHANT_ID,
        window,
        assetId,
        gross,
        fees,
        net,
        payoutMethod,
        payoutRef,
        status,
        createdAt: iso(now - (i + 1) * 3 * DAY),
        sentAt: status === 'paid_out' ? iso(now - (i + 1) * 3 * DAY + 3600_000) : null,
        settledAt: status === 'paid_out' ? iso(now - (i + 1) * 3 * DAY + 7200_000) : null,
        failedAt: status === 'failed' ? iso(now - (i + 1) * 3 * DAY + 3600_000) : null,
        failure: status === 'failed' ? { code: 'pay.rail_declined', message: 'The payment network declined this payout.' } : null,
        pricingSnapshot:
          i === 0
            ? {
                fee: fees,
                assetCode: assetId,
                appliedLayer: 'tier',
                ruleId: 'dd000001-0000-4000-8000-000000000001',
                feeBps: 150,
                flatFee: null,
                spreadBps: null,
                roundingBeneficiary: 'platform',
                roundingMode: 'ceil',
                bookedFee: fees,
                reserveAmount: null,
                recordedAt: iso(now - 3 * DAY),
              }
            : null,
      }))
    : [];
  const HASH = (c) => `sha256:${c.repeat(64)}`;
  const DEST = { railId: 'crypto-native', destinationKind: 'crypto', destinationMasked: '0x7a3f…4421' };
  const approvals = activity
    ? [
        {
          approvalId: 'cc000001-0000-4000-8000-000000000001',
          merchantId: MERCHANT_ID,
          settlementId: 'bb000003-0000-4000-8000-000000000003',
          amount: '965.55',
          assetCode: 'USDT',
          payloadHash: HASH('a'),
          status: 'pending',
          makerUserId: 'TEST-user-finance',
          checkerUserId: null,
          createdAt: iso(now - 5 * 3600_000),
          decidedAt: null,
          expiresAt: iso(now + 43 * 3600_000),
          ...DEST,
        },
        {
          approvalId: 'cc000002-0000-4000-8000-000000000002',
          merchantId: MERCHANT_ID,
          settlementId: 'bb000006-0000-4000-8000-000000000006',
          amount: '2167.49',
          assetCode: 'USDT',
          payloadHash: HASH('b'),
          status: 'pending',
          makerUserId: USER_ID,
          checkerUserId: null,
          createdAt: iso(now - 90 * 60_000),
          decidedAt: null,
          expiresAt: iso(now + 22 * 3600_000),
          ...DEST,
        },
        {
          approvalId: 'cc000003-0000-4000-8000-000000000003',
          merchantId: MERCHANT_ID,
          settlementId: 'bb000002-0000-4000-8000-000000000002',
          amount: '4039.24',
          assetCode: 'USDT',
          payloadHash: HASH('c'),
          status: 'consumed',
          makerUserId: 'TEST-user-finance',
          checkerUserId: USER_ID,
          createdAt: iso(now - 9 * DAY),
          decidedAt: iso(now - 9 * DAY + 3600_000),
          expiresAt: iso(now - 7 * DAY),
          ...DEST,
        },
        {
          approvalId: 'cc000004-0000-4000-8000-000000000004',
          merchantId: MERCHANT_ID,
          settlementId: 'bb000005-0000-4000-8000-000000000005',
          amount: '305.35',
          assetCode: 'USD',
          payloadHash: HASH('d'),
          status: 'voided',
          makerUserId: USER_ID,
          checkerUserId: null,
          createdAt: iso(now - 3 * DAY),
          decidedAt: iso(now - 3 * DAY + 600_000),
          expiresAt: iso(now - 1 * DAY),
          ...DEST,
        },
        {
          approvalId: 'cc000005-0000-4000-8000-000000000005',
          merchantId: MERCHANT_ID,
          settlementId: 'bb000001-0000-4000-8000-000000000001',
          amount: '3841.5',
          assetCode: 'USDT',
          payloadHash: HASH('e'),
          status: 'rejected',
          makerUserId: USER_ID,
          checkerUserId: 'TEST-user-finance',
          createdAt: iso(now - 16 * DAY),
          decidedAt: iso(now - 16 * DAY + 7200_000),
          expiresAt: iso(now - 14 * DAY),
          ...DEST,
        },
      ]
    : [];
  const configured = activity;
  const control = {
    merchantId: MERCHANT_ID,
    tierId: configured ? 'test-tier-a' : null,
    archetypeId: configured ? 'standard' : null,
    caps: configured
      ? [
          { kind: 'per_payment', assetCode: 'USDT', limit: '5000' },
          { kind: 'daily_intake', assetCode: 'USDT', limit: '20000' },
          { kind: 'monthly_intake', assetCode: 'USDT', limit: '250000' },
          { kind: 'daily_payout', assetCode: 'USDT', limit: '10000' },
          { kind: 'beneficiaries_per_day', limit: 5 },
        ]
      : null,
    pricing: configured
      ? [
          {
            layer: 'tier',
            scopeId: 'test-tier-a',
            assetCode: 'USDT',
            bands: [
              { fromAmount: '0', feeBps: 150, flatFee: null },
              { fromAmount: '10000', feeBps: 120, flatFee: '0.25' },
            ],
            spreadBps: 40,
            roundingBeneficiary: 'platform',
          },
          {
            layer: 'global',
            scopeId: null,
            assetCode: 'USD',
            bands: [{ fromAmount: '0', feeBps: 175, flatFee: '0.1' }],
            spreadBps: null,
            roundingBeneficiary: 'merchant',
          },
        ]
      : null,
    reserve: configured ? { rollingReserveBps: 500, holdDays: 7 } : null,
    version: configured ? '4' : '0',
    updatedAt: configured ? iso(now - 12 * DAY) : null,
  };
  const usage = {
    merchantId: MERCHANT_ID,
    tierId: control.tierId,
    asOf: iso(now - 20_000),
    rows: configured
      ? [
          { kind: 'per_payment', assetCode: 'USDT', limit: '5000', used: null, remaining: null, resetsAt: null },
          {
            kind: 'daily_intake',
            assetCode: 'USDT',
            limit: '20000',
            used: '14200.5',
            remaining: '5799.5',
            resetsAt: iso(Math.ceil(now / DAY) * DAY),
          },
          {
            kind: 'monthly_intake',
            assetCode: 'USDT',
            limit: '250000',
            used: '61250.25',
            remaining: '188749.75',
            resetsAt: iso(Math.ceil(now / DAY) * DAY + 14 * DAY),
          },
          {
            kind: 'daily_payout',
            assetCode: 'USDT',
            limit: '10000',
            used: '9800',
            remaining: '200',
            resetsAt: iso(Math.ceil(now / DAY) * DAY),
          },
          {
            kind: 'beneficiaries_per_day',
            assetCode: null,
            limit: '5',
            used: '2',
            remaining: '3',
            resetsAt: iso(Math.ceil(now / DAY) * DAY),
          },
        ]
      : [],
  };
  const quote = (input) => {
    const rule = control.pricing?.find((r) => r.assetCode === input.assetCode);
    if (!rule) return null;
    const S = 10n ** 18n;
    const toS = (v) => {
      const [w, f = ''] = String(v).split('.');
      return BigInt(w) * S + BigInt(f.padEnd(18, '0').slice(0, 18));
    };
    const fromS = (b) => {
      const w = b / S;
      const f = (b % S).toString().padStart(18, '0').replace(/0+$/, '');
      return f ? `${w}.${f}` : `${w}`;
    };
    const month = input.monthlyVolume ?? '12500';
    const band = [...rule.bands].reverse().find((b) => toS(month) >= toS(b.fromAmount)) ?? rule.bands[0];
    const amt = toS(input.amount);
    const bpsFee = (amt * BigInt(band.feeBps) + 9999n) / 10000n;
    const flat = band.flatFee ? toS(band.flatFee) : 0n;
    const spread = input.conversion && rule.spreadBps !== null ? (amt * BigInt(rule.spreadBps) + 9999n) / 10000n : null;
    const fee = bpsFee + flat;
    return {
      ruleId: 'dd000001-0000-4000-8000-000000000001',
      appliedLayer: rule.layer,
      monthlyVolumeBefore: month,
      bandFrom: band.fromAmount,
      feeBps: band.feeBps,
      flatFee: band.flatFee,
      spreadBps: input.conversion ? rule.spreadBps : null,
      roundingBeneficiary: rule.roundingBeneficiary,
      roundingMode: 'ceil',
      bpsFee: fromS(bpsFee),
      feeBeforeClamp: fromS(fee),
      fee: fromS(fee),
      spread: spread === null ? null : fromS(spread),
      net: fromS(amt - fee - (spread ?? 0n)),
    };
  };

  const SETTLEMENT = (id) => settlements.find((y) => y.id === id);
  const payoutOf = (x) => ({
    id: x.id,
    merchantId: MERCHANT_ID,
    window: x.window,
    assetId: x.assetId,
    gross: x.gross,
    fees: x.fees,
    net: x.net,
    status: x.status,
    payoutMethod: x.payoutMethod,
    payoutReference: x.payoutRef,
    createdAt: x.createdAt,
  });
  const inWindow = (at, input) => (!input.from || at >= input.from) && (!input.to || at < input.to);
  const refunds = activity
    ? [
        ['cc100001', 'TEST-refund-1', '10', 'settled', 'settled', 'merchantProceeds'],
        ['cc100002', 'TEST-refund-2', '4.25', 'posted', 'clearing', 'clearing'],
        ['cc100003', 'TEST-refund-3', '0.000001', 'reversed', 'clearing', 'clearing'],
      ].map(([short, refundId, amount, status, source, pot], i) => ({
        id: `${short}-0000-4000-8000-00000000010${i + 1}`,
        refundId,
        paymentId: `a0000001-0000-4000-8000-00000000000${i + 1}`,
        merchantId: MERCHANT_ID,
        amount,
        assetId: 'USDT',
        reason: null,
        actor: null,
        status,
        createdAt: iso(now - (i + 1) * DAY),
        settledAt: status === 'settled' ? iso(now - (i + 1) * DAY + 3600_000) : null,
        source,
        ledgerEffect: { recorded: true, pot, ledgerTxId: `cc2000${i}1-0000-4000-8000-000000000001`, direction: 'credit' },
        payment: { paymentId: `a0000001-0000-4000-8000-00000000000${i + 1}`, status: 'refunded' },
      }))
    : [];
  const destinations = activity
    ? [
        {
          id: 'dd100001-0000-4000-8000-000000000001',
          railId: 'crypto-native',
          kind: 'crypto',
          destinationMasked: '0x7a3f…4421',
          createdAt: iso(now - 30 * DAY),
          lastUsedAt: iso(now - 9 * DAY),
        },
        {
          id: 'dd100002-0000-4000-8000-000000000002',
          railId: 'card-sandbox',
          kind: 'bank',
          destinationMasked: '••••8821',
          createdAt: iso(now - 12 * DAY),
          lastUsedAt: null,
        },
      ].map((d) => ({ merchantId: MERCHANT_ID, screeningState: 'not_recorded', defaultFlag: 'unset', ...d }))
    : [];
  const orders = (state.conversions ??= activity
    ? [
        {
          conversionId: 'ee100001-0000-4000-8000-000000000001',
          requestId: 'ee200001-0000-4000-8000-000000000001',
          mode: 'sandbox',
          merchantId: MERCHANT_ID,
          settlementId: 'bb000005-0000-4000-8000-000000000005',
          status: 'filled',
          fromAsset: 'USD',
          toAsset: 'USDT',
          fromAmount: '100',
          filledFromAmount: '100',
          filledToAmount: '99.2',
          failureCode: null,
          createdAt: iso(now - 2 * DAY),
          updatedAt: iso(now - 2 * DAY + 60_000),
        },
      ]
    : []);
  state.limitRequest ??= null;
  const statement = (input) => {
    const ambiguous = input.assetId === 'USD';
    const at = (h) => iso(now - h * 3600_000);
    const lines = [
      ['payment_captured', '120', 'clearing', 'debit', 1, '2200.5', null],
      ['fee', '1.8', 'houseFees', 'credit', 2, null, null],
      ['settlement', '118.2', 'proceeds', 'debit', 5, null, '2318.7'],
      ['refund', '4.25', 'proceeds', 'credit', 20, null, '2314.45'],
      ['payout', '965.55', 'proceeds', 'credit', 50, null, '1348.9'],
    ].map(([kind, amount, account, direction, h, clearing, proceeds], i) => ({
      id: hex('ff', i + 1),
      at: at(h),
      assetId: input.assetId || 'USDT',
      kind,
      amount,
      account,
      direction,
      runningClearing: ambiguous ? null : account === 'clearing' ? clearing : null,
      runningProceeds: ambiguous ? null : account === 'proceeds' ? proceeds : null,
      windowNet: null,
      runningOrder: ambiguous ? 'order_ambiguous' : 'clear',
      runningReason: ambiguous ? 'order_ambiguous' : null,
      paymentId: kind === 'payment_captured' ? 'a0000001-0000-4000-8000-000000000001' : null,
      settlementId: kind === 'settlement' || kind === 'payout' ? 'bb000006-0000-4000-8000-000000000006' : null,
      ledgerTxId: hex('fe', i + 1),
    }));
    return {
      items: lines,
      nextCursor: null,
      runningBalances: 'within_range',
      opening: null,
      tieOut: {
        reserve: 'not_booked',
        accounts: [
          {
            assetId: 'USDT',
            clearing: { statement: '2200.5', ledger: '2200.5', matches: ambiguous ? null : true },
            proceeds: { statement: '1348.9', ledger: '1348.9', matches: ambiguous ? null : true },
          },
          {
            assetId: 'USD',
            clearing: { statement: null, ledger: '0', matches: null },
            proceeds: { statement: null, ledger: '305.35', matches: null },
          },
        ],
      },
    };
  };
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'settlement.list':
          return ok(route, {
            items: settlements.filter((x) => !input.status || x.status === input.status).slice(0, input.limit ?? 25),
            nextCursor: null,
          });
        case 'settlement.get': {
          const x = settlements.find((y) => y.id === input.settlementId);
          return x ? ok(route, x) : refuse(route, 404, 'pay.settlement_not_found');
        }
        case 'merchantControl.get':
          return ok(route, control);
        case 'merchantControl.usage':
          return ok(route, usage);
        case 'merchantControl.pricing.preview': {
          const q = quote(input);
          return q ? ok(route, q) : refuse(route, 412, 'pay.pricing_unconfigured');
        }
        case 'merchantControl.approvals.list':
          return ok(
            route,
            page(
              approvals.filter((a) => !input.status || a.status === input.status),
              input,
            ),
          );
        case 'merchantControl.approvals.decide': {
          const a = approvals.find((x) => x.approvalId === input.approvalId);
          if (!a) return refuse(route, 404, 'pay.approval_not_found');
          if (a.makerUserId === USER_ID) return refuse(route, 403, 'pay.approval_self_approval');
          if (a.status !== 'pending') return refuse(route, 409, 'pay.approval_not_pending');
          if (a.payloadHash !== input.expectedPayloadHash) return refuse(route, 409, 'pay.approval_payload_mismatch');
          a.status = input.decision === 'approve' ? 'approved' : 'rejected';
          a.checkerUserId = USER_ID;
          a.decidedAt = iso(Date.now());
          return ok(route, a);
        }
        case 'merchantControl.approvals.cancel': {
          const a = approvals.find((x) => x.approvalId === input.approvalId);
          if (!a) return refuse(route, 404, 'pay.approval_not_found');
          if (a.status !== 'pending') return refuse(route, 409, 'pay.approval_not_pending');
          a.status = 'voided';
          a.decidedAt = iso(Date.now());
          return ok(route, a);
        }

        case 'merchantOps.payouts.list': {
          const rows = settlements
            .filter(
              (x) =>
                (!input.status || x.status === input.status) &&
                (!input.assetId || x.assetId === input.assetId) &&
                (!input.search || x.id === input.search) &&
                inWindow(x.createdAt, input),
            )
            .map(payoutOf);
          return ok(route, page(rows, input));
        }
        case 'settlement.lines': {
          if (!SETTLEMENT(input.settlementId)) return refuse(route, 404, 'pay.settlement_not_found');
          const lines = [0, 1, 2].map((i) => ({
            paymentId: `a0000001-0000-4000-8000-00000000000${i + 1}`,
            amount: i === 2 ? null : `${100 + i * 20}.5`,
            assetId: 'USDT',
            createdAt: iso(now - (i + 4) * DAY),
            includedAmountKnown: i !== 2,
          }));
          return ok(route, page(lines, input));
        }
        case 'settlement.lifecycle': {
          const x = SETTLEMENT(input.settlementId);
          if (!x) return refuse(route, 404, 'pay.settlement_not_found');
          const e = (n, kind, h, extra = {}) => ({
            id: hex('ab', n),
            at: iso(now - h * 3600_000),
            timeKnown: true,
            kind,
            approvalId: null,
            railId: null,
            destinationKind: null,
            destinationMasked: null,
            failure: null,
            ...extra,
          });
          const dest = { railId: 'crypto-native', destinationKind: 'crypto', destinationMasked: '0x7a3f…4421' };
          const events =
            x.status === 'paid_out'
              ? [
                  e(1, 'settlement.opened', 300),
                  e(2, 'approval.requested', 120, { approvalId: 'cc000005-0000-4000-8000-000000000005', ...dest }),
                  e(3, 'approval.rejected', 118, { approvalId: 'cc000005-0000-4000-8000-000000000005', ...dest }),
                  e(4, 'approval.requested', 100, { approvalId: 'cc000003-0000-4000-8000-000000000003', ...dest }),
                  e(5, 'approval.approved', 98, { approvalId: 'cc000003-0000-4000-8000-000000000003', ...dest }),
                  e(6, 'rail.sent', 97, dest),
                  e(7, 'rail.confirmed', 96, dest),
                ]
              : [e(1, 'settlement.opened', 100), ...(x.status === 'pending' ? [] : [e(2, 'settlement.posted', 90)])];
          return ok(route, {
            settlementId: x.id,
            status: x.status,
            screening: 'not_recorded',
            fee: x.fees,
            destination:
              x.status === 'paid_out'
                ? { railId: dest.railId, kind: dest.destinationKind, destinationMasked: dest.destinationMasked }
                : null,
            failure: x.status === 'failed' ? x.failure : null,
            events,
          });
        }
        case 'merchant.statement.list':
          if (!input.from || !input.to) return refuse(route, 400, 'pay.statement_range_required');
          return ok(route, statement(input));
        case 'payment.refunds.list': {
          const rows = refunds.filter(
            (r) =>
              (!input.status || r.status === input.status) &&
              (!input.paymentId || r.paymentId === input.paymentId) &&
              inWindow(r.createdAt, input),
          );
          return ok(route, page(rows, input));
        }
        case 'payment.refunds.get': {
          const r = refunds.find((x) => x.id === input.refundEventId);
          return r ? ok(route, r) : refuse(route, 404, 'pay.refund_not_found');
        }
        case 'merchant.payoutDestinations.list': {
          const saved = state.destination
            ? [
                {
                  id: 'dd100009-0000-4000-8000-000000000009',
                  merchantId: MERCHANT_ID,
                  railId: state.destination.railId,
                  kind: state.destination.kind,
                  destinationMasked: `${state.destination.ref.slice(0, 6)}…${state.destination.ref.slice(-4)}`,
                  screeningState: 'not_recorded',
                  defaultFlag: 'unset',
                  createdAt: iso(now),
                  lastUsedAt: null,
                },
              ]
            : [];
          return ok(route, page([...destinations, ...saved], input));
        }
        case 'merchantControl.tiers.list':
          return ok(
            route,
            control.tierId
              ? {
                  status: 'configured',
                  ownTierId: control.tierId,
                  tiers: [
                    {
                      id: control.tierId,
                      name: 'Standard (test)',
                      archetype: 'standard',
                      caps: control.caps,
                      reserve: null,
                      version: 'v1',
                    },
                  ],
                }
              : { status: 'not_configured', ownTierId: null },
          );
        case 'merchantControl.pricing.history':
          return ok(
            route,
            control.pricing
              ? {
                  status: 'configured',
                  events: control.pricing.map((r, i) => ({
                    ruleId: `dd00000${i + 1}-0000-4000-8000-000000000001`,
                    layer: r.layer,
                    assetCode: r.assetCode,
                    bands: r.bands,
                    spreadBps: r.spreadBps,
                    version: 'v1',
                    createdAt: iso(now - 60 * DAY),
                    supersededAt: null,
                  })),
                }
              : { status: 'not_configured', events: [] },
          );
        case 'merchantControl.limits.open':
          return ok(route, state.limitRequest ? { status: 'pending', request: state.limitRequest } : { status: 'none' });
        case 'merchantControl.limits.requestIncrease': {
          if (state.limitRequest) return ok(route, { ...state.limitRequest, outcome: 'already_open' });
          state.limitRequest = {
            requestId: input.requestId,
            caps: input.caps,
            reason: input.reason,
            status: 'pending',
            requestedBy: USER_ID,
            createdAt: iso(Date.now()),
          };
          return ok(route, { ...state.limitRequest, outcome: 'stored' });
        }
        case 'merchantControl.limits.withdraw': {
          if (!state.limitRequest) return refuse(route, 404, 'pay.limit_request_not_found');
          const id = state.limitRequest.requestId;
          state.limitRequest = null;
          return ok(route, { requestId: id, status: 'withdrawn' });
        }
        case 'merchantControl.approvals.request': {
          const x = SETTLEMENT(input.settlementId);
          if (!x) return refuse(route, 404, 'pay.settlement_not_found');
          if (x.status !== 'posted') return refuse(route, 412, 'pay.settlement_not_payable');
          if (Number(x.net) < 1000) return refuse(route, 412, 'pay.approval_not_required');
          const a = {
            approvalId: hex('cc', approvals.length + 10),
            merchantId: MERCHANT_ID,
            settlementId: x.id,
            amount: x.net,
            assetCode: x.assetId,
            payloadHash: HASH('f'),
            status: 'pending',
            makerUserId: USER_ID,
            checkerUserId: null,
            createdAt: iso(Date.now()),
            decidedAt: null,
            expiresAt: iso(Date.now() + 48 * 3600_000),
            ...DEST,
          };
          approvals.unshift(a);
          return ok(route, a);
        }
        case 'settlement.payout': {
          const x = SETTLEMENT(input.settlementId);
          if (!x) return refuse(route, 404, 'pay.settlement_not_found');
          if (x.status !== 'posted') return refuse(route, 412, 'pay.settlement_not_payable');
          Object.assign(x, {
            status: 'paid_out',
            payoutMethod: input.railId,
            payoutRef: 'TEST-tx-0x999',
            sentAt: iso(Date.now()),
            settledAt: iso(Date.now()),
          });
          return ok(route, x);
        }
        case 'conversion.list':
          return ok(
            route,
            orders.filter((o) => !input.status || o.status === input.status),
          );
        case 'conversion.get': {
          const o = orders.find((x) => x.conversionId === input.conversionId);
          return o ? ok(route, o) : refuse(route, 412, 'pay.conversion_not_found');
        }
        case 'conversion.quote': {
          const q = {
            quoteId: hex('ee3', orders.length + 1),
            mode: 'sandbox',
            merchantId: MERCHANT_ID,
            settlementId: input.settlementId,
            fromAsset: input.fromAsset,
            toAsset: input.toAsset,
            fromAmount: input.fromAmount,
            rate: '0.998',
            feeAmount: '0.1',
            spreadAmount: '0.2',
            minimumOutput: '98.9',
            expectedOutput: '99.4',
            expiresAt: iso(Date.now() + 120_000),
          };
          state.quote = q;
          return ok(route, q);
        }
        case 'conversion.execute': {
          const q = state.quote;
          if (!q || q.quoteId !== input.quoteId) return refuse(route, 412, 'pay.conversion_quote_consumed');
          const o = {
            conversionId: hex('ee1', orders.length + 1),
            requestId: input.requestId,
            mode: 'sandbox',
            merchantId: MERCHANT_ID,
            settlementId: q.settlementId,
            status: 'placing',
            fromAsset: q.fromAsset,
            toAsset: q.toAsset,
            fromAmount: q.fromAmount,
            filledFromAmount: '0',
            filledToAmount: '0',
            failureCode: null,
            createdAt: iso(Date.now()),
            updatedAt: iso(Date.now()),
          };
          orders.unshift(o);
          return ok(route, o);
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
