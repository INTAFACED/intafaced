// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, iso, ok, refuse } from '../mock/shared.mjs';

/** Settlements, approvals, pricing and limits. */
export function createMoneyMock(ctx) {
  const { now, activity } = ctx;
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
      }))
    : [];
  const HASH = (c) => `sha256:${c.repeat(64)}`;
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
          return ok(route, approvals.filter((a) => !input.status || a.status === input.status).slice(0, input.limit ?? 50));
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
        default:
          return NOT_MINE;
      }
    },
  };
}
