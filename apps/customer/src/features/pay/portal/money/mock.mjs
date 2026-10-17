// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, hex, iso, ok, page, refuse } from '../mock/shared.mjs';
import { RULE, fromU, isTaken, toU } from '../mock/world.mjs';

/** Settlements, approvals, pricing and limits. */
export function createMoneyMock(ctx) {
  const { now, activity, state } = ctx;
  // The settlements, refunds, destinations and ledger come from the one fixture world (mock/world.mjs), so the money
  // pages, Home, the payments list and the statement all add up to the same figures.
  const world = ctx.world;
  const settlements = world.settlements;
  const HASH = (c) => `sha256:${c.repeat(64)}`;
  const DEST = (({ railId, kind, destinationMasked }) => ({ railId, destinationKind: kind, destinationMasked }))(
    world.destinations[0] ?? { railId: 'crypto-native', kind: 'crypto', destinationMasked: '0x7a3f…4421' },
  );
  const settlementNo = (short) => settlements.find((x) => x.short === short);
  // [id, settlement, status, maker, checker, created (h ago), decided (h after created) or null, expires (h from now)]
  const approvals = activity
    ? [
        ['cc000001', 'bb000003', 'pending', 'TEST-user-finance', null, 5, null, 43, 'a'],
        ['cc000002', 'bb000004', 'pending', USER_ID, null, 1.5, null, 22, 'b'],
        ['cc000003', 'bb000002', 'consumed', 'TEST-user-finance', USER_ID, 9 * 24, 1, -7 * 24, 'c'],
        ['cc000004', 'bb000005', 'voided', USER_ID, null, 3 * 24, 1 / 6, -24, 'd'],
        ['cc000005', 'bb000001', 'rejected', USER_ID, 'TEST-user-finance', 16 * 24, 2, -14 * 24, 'e'],
      ].map(([short, stl, status, maker, checker, createdHoursAgo, decidedAfter, expiresIn, hash]) => {
        const settlement = settlementNo(stl);
        return {
          approvalId: `${short}-0000-4000-8000-00000000000${short.slice(-1)}`,
          merchantId: MERCHANT_ID,
          settlementId: settlement.id,
          amount: settlement.net,
          assetCode: settlement.assetId,
          payloadHash: HASH(hash),
          status,
          makerUserId: maker,
          checkerUserId: checker,
          createdAt: iso(now - createdHoursAgo * 3600_000),
          decidedAt: decidedAfter === null ? null : iso(now - createdHoursAgo * 3600_000 + decidedAfter * 3600_000),
          expiresAt: iso(now + expiresIn * 3600_000),
          ...DEST,
        };
      })
    : [];
  state.approvals = approvals;
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
              { fromAmount: '0', feeBps: RULE.feeBps, flatFee: RULE.flatFee },
              { fromAmount: '100000', feeBps: 120, flatFee: '0.25' },
            ],
            spreadBps: 40,
            roundingBeneficiary: 'platform',
          },
          {
            layer: 'tier',
            scopeId: 'test-tier-a',
            assetCode: 'USD',
            bands: [{ fromAmount: '0', feeBps: RULE.feeBps, flatFee: RULE.flatFee }],
            spreadBps: null,
            roundingBeneficiary: 'merchant',
          },
        ]
      : null,
    reserve: configured ? { rollingReserveBps: 500, holdDays: 7 } : null,
    version: configured ? '4' : '0',
    updatedAt: configured ? iso(now - 12 * DAY) : null,
  };
  const intake = (windowMs) => {
    const f = world.figures(now - windowMs);
    return f.captured.find((row) => row.assetCode === 'USDT')?.amount ?? '0';
  };
  const dayEnd = Math.ceil(now / DAY) * DAY;
  const left = (limit, used) => fromU(toU(limit) - toU(used));
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
            used: intake(DAY),
            remaining: left('20000', intake(DAY)),
            resetsAt: iso(dayEnd),
          },
          {
            kind: 'monthly_intake',
            assetCode: 'USDT',
            limit: '250000',
            used: intake(30 * DAY),
            remaining: left('250000', intake(30 * DAY)),
            resetsAt: iso(dayEnd + 14 * DAY),
          },
          // TEST figure: today's payouts are already near the daily limit, so a large approval can show its warning.
          { kind: 'daily_payout', assetCode: 'USDT', limit: '10000', used: '9800', remaining: '200', resetsAt: iso(dayEnd) },
          { kind: 'beneficiaries_per_day', assetCode: null, limit: '5', used: '2', remaining: '3', resetsAt: iso(dayEnd) },
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
    const unit = 10n ** BigInt(18 - (input.assetCode === 'USD' ? 2 : 6));
    const bpsFee = (((amt * BigInt(band.feeBps) + 9999n) / 10000n + unit - 1n) / unit) * unit;
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
  const refunds = world.refunds;
  const destinations = world.destinations;
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
  /** The ledger statement: lines from the world's ledger, newest first, with the balances the lines add up to. */
  const statement = (input) => {
    const ambiguous = input.assetId === 'USD';
    const assetId = input.assetId || 'USDT';
    const all = world.ledgerLines(assetId);
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    const inRange = all.filter((l) => l.at >= from && l.at < to);
    const before = all.filter((l) => l.at < from).at(-1);
    const opening = { clearing: before?.runningClearing ?? 0n, proceeds: before?.runningProceeds ?? 0n };
    const end = inRange.at(-1) ?? before;
    const items = [...inRange].reverse().map((l) => ({
      id: hex('ff', l.index),
      at: iso(l.at),
      assetId,
      kind: l.kind,
      amount: l.amount,
      account: l.account,
      direction: l.direction,
      runningClearing: ambiguous || l.clearing === undefined ? null : fromU(l.runningClearing),
      runningProceeds: ambiguous || l.proceeds === undefined ? null : fromU(l.runningProceeds),
      windowNet: null,
      runningOrder: ambiguous ? 'order_ambiguous' : 'clear',
      runningReason: ambiguous ? 'order_ambiguous' : null,
      paymentId: l.paymentId ?? null,
      settlementId: l.settlementId ?? null,
      ledgerTxId: hex('fe', l.index),
    }));
    const held = (asset) => world.balance(asset);
    const stated = end ? { clearing: end.runningClearing, proceeds: end.runningProceeds } : opening;
    const side = (statement, ledger, blind) => ({
      statement: blind ? null : fromU(statement),
      ledger: fromU(ledger),
      matches: blind ? null : statement === ledger,
    });
    return {
      ...page(items, input),
      runningBalances: 'from_opening',
      opening: [{ assetId, clearing: fromU(opening.clearing), proceeds: fromU(opening.proceeds) }],
      tieOut: {
        reserve: 'not_booked',
        accounts: world.assets.map((asset) => {
          const blind = asset !== assetId || ambiguous;
          // the ledger figure is the balance at the end of the range; a range that stops early shows the balance then
          const ledgerAt = asset === assetId && end ? stated : held(asset);
          return {
            assetId: asset,
            clearing: side(stated.clearing, ledgerAt.clearing, blind),
            proceeds: side(stated.proceeds, ledgerAt.proceeds, blind),
          };
        }),
      },
    };
  };
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'settlement.list':
          return ok(route, {
            items: settlements
              .filter((x) => (!input.status || x.status === input.status) && (!input.assetId || x.assetId === input.assetId))
              .slice(0, input.limit ?? 25),
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
          const lines = SETTLEMENT(input.settlementId).members.map((paymentId, i) => {
            const p = world.paymentById(paymentId);
            return {
              paymentId,
              // the oldest line of the oldest settlement predates amount recording, so its included amount is not known
              amount: i === 0 && SETTLEMENT(input.settlementId).short === 'bb000001' ? null : p.amount,
              assetId: p.assetId,
              createdAt: p.createdAt,
              includedAmountKnown: !(i === 0 && SETTLEMENT(input.settlementId).short === 'bb000001'),
            };
          });
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
          const dest = DEST;
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
              (!input.assetId || r.assetId === input.assetId) &&
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
          if (x.status !== 'posted' && x.status !== 'failed') return refuse(route, 412, 'pay.settlement_not_payable');
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
          if (x.status !== 'posted' && x.status !== 'failed') return refuse(route, 412, 'pay.settlement_not_payable');
          Object.assign(x, {
            failedAt: null,
            failure: null,
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
