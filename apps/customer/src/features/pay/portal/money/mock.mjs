// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, TEAM, USER_ID, hex, iso, ok, page, refuse, startOfDay } from '../mock/shared.mjs';
import { RULE, fromU, toU } from '../mock/world.mjs';
import { createAnalyticsMock } from '../settings/analytics/mock.mjs';

/** Settlements, approvals, pricing and limits. */
export function createMoneyMock(ctx) {
  const { now, activity, state } = ctx;
  // The settlements, refunds, destinations and ledger come from the one fixture world (mock/world.mjs), so the money
  // pages, Home, the payments list and the statement all add up to the same figures.
  const world = ctx.world;
  const settlements = world.settlements;
  const HASH = (c) => `sha256:${c.repeat(64)}`;
  const asDest = ({ railId, kind, destinationMasked }) => ({ railId, destinationKind: kind, destinationMasked });
  const DEST = asDest(world.destinations[0] ?? { railId: 'crypto-native', kind: 'crypto', destinationMasked: '0x7a3f…4421' });
  /** A US dollar payout goes to the bank account, a USDT payout to the wallet: never a dollar payout to a crypto address. */
  const destFor = (assetId) => (assetId === 'USD' && world.destinations[1] ? asDest(world.destinations[1]) : DEST);
  // The fee-rate read is the fees page's own answer with the service's per-asset rate added (#4919).
  const analytics = createAnalyticsMock(ctx);
  const settlementNo = (short) => settlements.find((x) => x.short === short);
  // Every approval is placed on its own settlement's timeline: a request is made after the statement is finalised, and a
  // payout is sent only after the approval that let it go. [id, settlement, status, maker, checker, created, decided or
  // null, hash letter, optional expiry]. Times are ms; `after(stl, hours)` is hours after that statement was finalised, `ago(hours)` is before now.
  const finance = TEAM.finance.userId;
  const after = (short, hours) => Date.parse(settlementNo(short).createdAt) + hours * 3600_000;
  const ago = (hours) => now - hours * 3600_000;
  const APPROVAL_LIFE = 48 * 3600_000;
  // The payout of the oldest settlement predates approvals, so it has none. The one before it was asked for, turned down,
  // asked for again and then approved: the rejected request and the approved one are on the same settlement.
  // The failed USD payout was asked for, approved and sent before the bank refused it, in that order after its statement.
  const failedUsd = activity ? settlementNo('bb000005') : null;
  if (failedUsd)
    Object.assign(failedUsd, {
      payoutMethod: destFor(failedUsd.assetId).railId,
      sentAt: iso(after('bb000005', 4)),
      failedAt: iso(after('bb000005', 5)),
    });
  const approvals = activity
    ? [
        ['cc000001', 'bb000003', 'pending', finance, null, ago(5), null, 'a'],
        ['cc000002', 'bb000004', 'pending', finance, null, ago(1.5), null, 'b', now + 22 * 3600_000],
        ['cc000003', 'bb000002', 'consumed', finance, USER_ID, after('bb000002', 5), after('bb000002', 20), 'c'],
        ['cc000004', 'bb000005', 'consumed', USER_ID, finance, after('bb000005', 1), after('bb000005', 3), 'd'],
        ['cc000005', 'bb000002', 'rejected', USER_ID, finance, after('bb000002', 1), after('bb000002', 3), 'e'],
      ].map(([short, stl, status, maker, checker, createdAt, decidedAt, hash, expiresAt]) => {
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
          createdAt: iso(createdAt),
          decidedAt: decidedAt === null ? null : iso(decidedAt),
          expiresAt: iso(expiresAt ?? createdAt + APPROVAL_LIFE),
          ...destFor(settlement.assetId),
        };
      })
    : [];
  state.approvals = approvals;
  const configured = activity;
  // Sized so the waiting 2,287 approval is over what is left of today while the 1,280 one and the 236 settlement fit.
  const DAILY_PAYOUT_LIMIT = '2000';
  const control = {
    merchantId: MERCHANT_ID,
    tierId: configured ? 'test-tier-a' : null,
    archetypeId: configured ? 'standard' : null,
    caps: configured
      ? [
          { kind: 'per_payment', assetCode: 'USDT', limit: '5000' },
          { kind: 'daily_intake', assetCode: 'USDT', limit: '20000' },
          { kind: 'monthly_intake', assetCode: 'USDT', limit: '250000' },
          { kind: 'daily_payout', assetCode: 'USDT', limit: DAILY_PAYOUT_LIMIT },
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
  // Intake is counted for the UTC day (it resets at midnight UTC), so it is the same figure Home shows for "today".
  const intake = (from) => world.figures(from).captured.find((row) => row.assetCode === 'USDT')?.amount ?? '0';
  const dayStart = startOfDay(now);
  const dayEnd = dayStart + DAY;
  const left = (limit, used) => fromU(toU(limit) > toU(used) ? toU(limit) - toU(used) : 0n);
  /** What was sent out today, worked out from the settlements that were paid out today. */
  const paidOutToday = () => {
    const sent = settlements.filter((x) => x.status === 'paid_out' && x.sentAt && Date.parse(x.sentAt) >= dayStart && x.assetId === 'USDT');
    return { amount: fromU(sent.reduce((t, x) => t + toU(x.net), 0n)), destinations: sent.length ? 1 : 0 };
  };
  const usageNow = () => {
    const paid = paidOutToday();
    return {
      merchantId: MERCHANT_ID,
      tierId: control.tierId,
      asOf: iso(Date.now() - 20_000),
      rows: configured
        ? [
            { kind: 'per_payment', assetCode: 'USDT', limit: '5000', used: null, remaining: null, resetsAt: null },
            {
              kind: 'daily_intake',
              assetCode: 'USDT',
              limit: '20000',
              used: intake(dayStart),
              remaining: left('20000', intake(dayStart)),
              resetsAt: iso(dayEnd),
            },
            {
              kind: 'monthly_intake',
              assetCode: 'USDT',
              limit: '250000',
              used: intake(dayStart - 29 * DAY),
              remaining: left('250000', intake(dayStart - 29 * DAY)),
              resetsAt: iso(dayEnd + 14 * DAY),
            },
            {
              kind: 'daily_payout',
              assetCode: 'USDT',
              limit: DAILY_PAYOUT_LIMIT,
              used: paid.amount,
              remaining: left(DAILY_PAYOUT_LIMIT, paid.amount),
              resetsAt: iso(dayEnd),
            },
            {
              kind: 'beneficiaries_per_day',
              assetCode: null,
              limit: '5',
              used: String(paid.destinations),
              remaining: String(5 - paid.destinations),
              resetsAt: iso(dayEnd),
            },
          ]
        : [],
    };
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
  // The saved destinations as the owner has left them in this session: one may be marked default, and one may be removed.
  const removedDestinations = new Set();
  let defaultDestinationId = null;
  const lastUsed = new Map();
  let sentCount = 0;
  const destinationRows = () => {
    const saved = state.destination
      ? [
          {
            id: 'dd100009-0000-4000-8000-000000000009',
            merchantId: MERCHANT_ID,
            railId: state.destination.railId,
            kind: state.destination.kind,
            // svc-pay's mask: first 6 and last 4 of an address, the last 4 of an account.
            destinationMasked:
              state.destination.kind === 'crypto'
                ? `${state.destination.ref.slice(0, 6)}…${state.destination.ref.slice(-4)}`
                : `••••${state.destination.ref.slice(-4)}`,
            screeningState: 'not_recorded',
            defaultFlag: 'unset',
            createdAt: iso(now),
            lastUsedAt: null,
            ...(!state.destination.verified
              ? { state: 'unverified', activatesAt: null }
              : Date.parse(state.destination.activatesAt) > Date.now()
                ? { state: 'held', activatesAt: state.destination.activatesAt }
                : { state: 'active', activatesAt: null }),
          },
        ]
      : [];
    const usedRails = new Set();
    return [...destinations, ...saved]
      .filter((d) => !removedDestinations.has(d.id))
      .map((d) => {
        const stamp = lastUsed.get(d.railId);
        const first = stamp && !usedRails.has(d.railId);
        if (first) usedRails.add(d.railId);
        return { ...d, defaultFlag: d.id === defaultDestinationId ? 'default' : 'unset', lastUsedAt: first ? stamp : d.lastUsedAt };
      });
  };
  /** A request that is waiting or approved and has not run out keeps its destination from being removed. */
  const destinationInFlight = (d) =>
    approvals.some(
      (a) =>
        (a.status === 'pending' || a.status === 'approved') &&
        Date.parse(a.expiresAt) > Date.now() &&
        a.railId === d.railId &&
        a.destinationMasked === d.destinationMasked,
    );
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
        case 'merchantControl.reserve':
          // TEST: the reserve the control profile sets, recorded on the settlements and never withheld.
          return ok(route, {
            merchantId: MERCHANT_ID,
            rule: control.reserve ? { rollingReserveBps: control.reserve.rollingReserveBps, holdDays: control.reserve.holdDays } : null,
            holding: 'recorded_not_withheld',
            payoutsRefused: Boolean(control.reserve),
            assets: control.reserve
              ? [{ assetCode: 'USDT', recordedAmount: '11.80', entries: 1, nextReleaseAt: iso(Date.now() + 30 * DAY), lastReleaseAt: null }]
              : [],
            readAt: iso(Date.now()),
          });
        case 'merchantControl.topUp.options':
          // No top-up rail is wired, as on the real service.
          return refuse(route, 412, 'pay.topup_unconfigured');
        case 'merchantControl.usage':
          return ok(route, usageNow());
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
        case 'settlement.clearing':
          // the seeded world's captured payments were all available at capture: nothing waits on the rail
          return ok(route, { held: [] });
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
          // The timeline is drawn from the settlement's own dates and its approvals, so every settlement tells its own story:
          // it opens with its oldest payment, is finalised when its statement is posted, is asked for, approved or turned
          // down in between, and is sent and confirmed only after the approval that let it go.
          const own = approvals.filter((a) => a.settlementId === x.id).sort((p, q) => p.createdAt.localeCompare(q.createdAt));
          const dest =
            x.paidTo ??
            (own[0]
              ? asDest({ railId: own[0].railId, kind: own[0].destinationKind, destinationMasked: own[0].destinationMasked })
              : destFor(x.assetId));
          const raw = [
            { kind: 'settlement.opened', at: x.openedAt },
            ...(x.status === 'paid_out' ? [] : [{ kind: 'settlement.posted', at: x.createdAt }]),
            ...own.flatMap((a) => [
              { kind: 'approval.requested', at: a.createdAt, approvalId: a.approvalId, ...dest },
              ...(a.status === 'pending'
                ? []
                : [
                    {
                      kind: {
                        consumed: 'approval.approved',
                        approved: 'approval.approved',
                        rejected: 'approval.rejected',
                        voided: 'approval.voided',
                      }[a.status],
                      at: a.decidedAt,
                      approvalId: a.approvalId,
                      ...dest,
                    },
                  ]),
            ]),
            ...(x.status === 'paid_out'
              ? [
                  { kind: 'rail.sent', at: x.sentAt, ...dest },
                  { kind: 'rail.confirmed', at: x.settledAt, ...dest },
                ]
              : []),
            ...(x.status === 'failed' && x.sentAt
              ? [
                  { kind: 'rail.sent', at: x.sentAt, ...dest },
                  { kind: 'rail.refused', at: x.failedAt, ...dest, failure: x.failure },
                ]
              : []),
          ]
            .filter((e) => e.kind && e.at)
            .sort((p, q) => p.at.localeCompare(q.at));
          const events = raw.map(({ kind, at, ...extra }, i) => ({
            id: hex('ab', i + 1),
            at,
            timeKnown: true,
            kind,
            approvalId: null,
            railId: null,
            destinationKind: null,
            destinationMasked: null,
            failure: null,
            ...extra,
          }));
          return ok(route, {
            settlementId: x.id,
            status: x.status,
            screening: 'not_recorded',
            fee: x.fees,
            destination:
              x.status === 'paid_out' || x.status === 'failed'
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
        case 'merchant.payoutDestinations.list':
          return ok(route, page(destinationRows(), input));
        case 'merchant.payoutDestinations.add': {
          // Saved unverified (J-merchant-02 #5); a verified one changes only through the confirmation and the hold.
          const onRail = destinationRows().find((d) => d.railId === input.railId);
          if (onRail && onRail.state !== 'unverified') return refuse(route, 409, 'pay.payout_destination_verified_locked');
          state.destination = { kind: input.kind, ref: input.ref, railId: input.railId, verified: false, activatesAt: null };
          return ok(route, { kind: input.kind, ref: input.ref, railId: input.railId, status: 'unverified', activatesAt: null });
        }
        case 'merchant.payoutDestinations.cancelHold': {
          // Owner only on the service; a held one goes back to unverified, an unverified one is left, an active one refused.
          const d = destinationRows().find((x) => x.id === input.destinationId);
          if (!d) return refuse(route, 404, 'pay.payout_destination_not_found');
          if (d.state === 'active') return refuse(route, 409, 'pay.payout_destination_not_held');
          const changed = d.state === 'held';
          if (changed) state.destination = { ...state.destination, verified: false, activatesAt: null };
          return ok(route, { destinationId: d.id, state: 'unverified', changed });
        }
        case 'merchant.payoutDestinations.setDefault': {
          const d = destinationRows().find((x) => x.id === input.destinationId);
          if (!d) return refuse(route, 404, 'pay.payout_destination_not_found');
          defaultDestinationId = d.id;
          return ok(route, { ...d, defaultFlag: 'default' });
        }
        case 'merchant.payoutDestinations.remove': {
          const d = destinationRows().find((x) => x.id === input.destinationId);
          if (!d) return refuse(route, 404, 'pay.payout_destination_not_found');
          if (destinationInFlight(d)) return refuse(route, 409, 'pay.payout_destination_in_flight');
          removedDestinations.add(d.id);
          if (defaultDestinationId === d.id) defaultDestinationId = null; // another one is never promoted
          return ok(route, { removed: true });
        }
        case 'merchantAnalytics.fees': {
          let answer = null;
          await analytics.handle(procedure, input, { fulfill: (r) => (answer = JSON.parse(r.body).result.data) });
          if (!answer) return NOT_MINE;
          // The service's own rate per asset over the whole window: fees ÷ gross, rounded down to 6 places.
          const by = new Map();
          for (const row of answer.items) {
            const cur = by.get(row.assetCode) ?? { gross: 0n, fees: 0n };
            by.set(row.assetCode, { gross: cur.gross + toU(row.gross), fees: cur.fees + toU(row.fees) });
          }
          const rates = [...by.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([assetCode, { gross, fees }]) => {
              if (gross === 0n) return { assetCode, fees: fromU(fees), gross: '0', rate: null, rateStatus: 'no_volume' };
              const q = (fees * 1_000_000n) / gross;
              const exact = (fees * 1_000_000n) % gross === 0n;
              const fraction = (q % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
              return {
                assetCode,
                fees: fromU(fees),
                gross: fromU(gross),
                rate: fraction ? `${q / 1_000_000n}.${fraction}` : `${q / 1_000_000n}`,
                rateStatus: exact ? 'exact' : 'rounded',
              };
            });
          return ok(route, { ...answer, rates });
        }
        case 'merchantControl.tiers.list': {
          // The ladder: every tier INTAFACED shows merchants (TEST names and figures), the merchant's own marked by id.
          const usdt = (kind, limit) => ({ kind, assetCode: 'USDT', limit });
          return ok(
            route,
            configured
              ? {
                  status: 'configured',
                  ownTierId: control.tierId,
                  tiers: [
                    {
                      id: 'test-tier-a',
                      name: 'Standard (test)',
                      archetype: 'standard',
                      caps: control.caps,
                      reserve: control.reserve,
                      // Its own fees are the tier-layer rules the profile resolves; payouts are published as not charged.
                      fees: control.pricing.map(({ assetCode, bands, spreadBps, roundingBeneficiary }) => ({
                        assetCode,
                        bands,
                        spreadBps,
                        roundingBeneficiary,
                        minFee: null,
                        maxFee: null,
                        version: '1',
                      })),
                      payoutFee: { kind: 'not_charged' },
                      version: 'v1',
                    },
                    {
                      id: 'test-tier-b',
                      name: 'Growth (test)',
                      archetype: 'standard',
                      caps: [
                        usdt('per_payment', '25000'),
                        usdt('daily_intake', '100000'),
                        usdt('monthly_intake', '1000000'),
                        usdt('daily_payout', '25000'),
                        { kind: 'beneficiaries_per_day', limit: 10 },
                      ],
                      reserve: { rollingReserveBps: 300, holdDays: 5 },
                      // A tier with no fee and no payout fee of its own: the page reads "Not set" for both.
                      fees: [],
                      payoutFee: null,
                      version: 'v1',
                    },
                    {
                      id: 'test-tier-c',
                      name: 'Scale (test)',
                      archetype: 'standard',
                      caps: [
                        usdt('per_payment', '100000'),
                        usdt('daily_intake', '500000'),
                        usdt('monthly_intake', '5000000'),
                        usdt('daily_payout', '100000'),
                        { kind: 'beneficiaries_per_day', limit: 25 },
                      ],
                      reserve: null,
                      version: 'v1',
                    },
                  ],
                }
              : { status: 'not_configured', ownTierId: null },
          );
        }
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
          const dest = destinationRows().find((d) => d.railId === input.railId);
          if (!dest) return refuse(route, 412, 'pay.payout_destination_missing');
          // A request that has run out is expired, as the service does it; asking the same payout again makes a NEW waiting row.
          for (const a of approvals)
            if (a.settlementId === x.id && (a.status === 'pending' || a.status === 'approved') && Date.parse(a.expiresAt) <= Date.now()) {
              a.status = 'expired';
              a.decidedAt = a.decidedAt ?? iso(Date.now());
            }
          const live = approvals.find(
            (a) =>
              a.settlementId === x.id &&
              (a.status === 'pending' || a.status === 'approved') &&
              a.railId === dest.railId &&
              a.destinationMasked === dest.destinationMasked,
          );
          // The same request asked again is the live one, whatever state it is in (as the service does).
          if (live) return ok(route, live);
          // A request for a different destination makes the earlier ones void.
          for (const a of approvals)
            if (a.settlementId === x.id && (a.status === 'pending' || a.status === 'approved')) {
              a.status = 'voided';
              a.decidedAt = iso(Date.now());
            }
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
            ...asDest(dest),
          };
          approvals.unshift(a);
          return ok(route, a);
        }
        case 'settlement.payout': {
          const x = SETTLEMENT(input.settlementId);
          if (!x) return refuse(route, 404, 'pay.settlement_not_found');
          if (x.status !== 'posted' && x.status !== 'failed') return refuse(route, 412, 'pay.settlement_not_payable');
          const dest = destinationRows().find((d) => d.railId === input.railId);
          if (!dest) return refuse(route, 412, 'pay.payout_destination_missing');
          // Above the approval limit a payout needs an approval that was decided, for this destination, and not used yet.
          if (Number(x.net) >= 1000) {
            const usable = approvals.find(
              (a) =>
                a.settlementId === x.id &&
                a.status === 'approved' &&
                a.railId === dest.railId &&
                a.destinationMasked === dest.destinationMasked &&
                Date.parse(a.expiresAt) > Date.now(),
            );
            if (!usable) return refuse(route, 412, 'pay.approval_required');
            usable.status = 'consumed';
          }
          const sentAt = iso(Date.now());
          Object.assign(x, {
            failedAt: null,
            failure: null,
            status: 'paid_out',
            payoutMethod: input.railId,
            payoutRef: `TEST-tx-sent-${(sentCount += 1)}`,
            sentAt,
            settledAt: sentAt,
            paidTo: asDest(dest),
          });
          lastUsed.set(dest.railId, sentAt);
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
            quoteId: hex('e3', orders.length + 1),
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
            conversionId: hex('e1', orders.length + 1),
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
