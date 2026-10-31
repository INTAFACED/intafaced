import { formatAmount, parseAmount, SCALE, type Amount } from '@intafaced/ledger-client';
import type {
  FounderDisputeListInput,
  FounderMerchantSectionInput,
  FounderMerchantSectionPage,
  FounderPayoutListInput,
  FounderRiskSummaryInput,
  PayMetricWindow,
} from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { loadChargebackLedgerEffects, type ChargebackLedgerEffect } from '../chargeback-ledger-effect.js';
import type { DisputeCaseStore } from '../fraud/dispute-case.js';
import { defaultDisputeCaseStore } from '../fraud/dispute-case.js';
import { ActivityFeed } from '../merchant-ops/activity.js';
import { CustomerDirectory } from '../merchant-ops/customers.js';
import { DisputeOpsService } from '../merchant-ops/disputes.js';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { ExportService } from '../merchant-ops/exports.js';
import { InvoiceService } from '../merchant-ops/invoices.js';
import { MerchantKybView } from '../merchant-ops/kyb.js';
import { iso } from '../merchant-ops/money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from '../merchant-ops/pagination.js';
import { PayoutList, payoutReference } from '../merchant-ops/payouts.js';
import type { MerchantCaller } from '../merchant-ops/roles.js';
import { TeamService } from '../merchant-ops/team.js';
import { WebhookOps } from '../merchant-ops/webhooks.js';
import { merchantNotFound } from '../metrics/errors.js';
import { resolveWindow } from '../metrics/window.js';
import { PayError, type PayService } from '../payment-service.js';
import { merchantFeeView, MerchantStoredFeeError, type MerchantStarterFee } from '../starter-fee.js';
import type { StoredPricingSnapshot } from '../control/snapshots.js';
import { SubscriptionService } from '../subscriptions/subscription-service.js';

/**
 * Founder reads of one merchant, and the founder-wide lists.
 *
 * Query work stays in the merchant services. This file only chooses the merchant,
 * calls the existing method, and drops fields a founder list must not carry
 * (destination refs, webhook secrets, export file bytes, API key material).
 *
 * The caller object below is not an ownership claim. `founderProcedure` has
 * already authorised the session. `owner` is how those services express
 * "may read every row of this merchant", including exports a viewer cannot see.
 * Only read methods are called with it.
 */
function founderReadCaller(merchantId: string, founderUserId: string): MerchantCaller {
  return { merchantId, userId: founderUserId, role: 'owner', viaApiKey: false, interactive: true };
}

/** Ratio truncated to the ledger scale. Null when there is nothing to share. Not rounded. */
export function concentrationShare(part: Amount, total: Amount): string | null {
  if (total <= 0n || part < 0n) return null;
  return formatAmount((part * SCALE) / total);
}

const PAY_SECTIONS = new Set(['payments', 'refunds', 'settlements', 'links', 'destinations']);

const badStatus = () => new MerchantOpsError('pay.list_status_invalid', 'bad_request');

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw badStatus();
  return value as T;
}

function kybStatus(value: string): 'none' | 'pending' | 'approved' | 'rejected' {
  if (value === 'none' || value === 'pending' || value === 'approved' || value === 'rejected') return value;
  throw badStatus();
}

function stamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function ageSeconds(at: Date | null, now: Date): number | null {
  if (!at) return null;
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  return seconds < 0 ? 0 : seconds;
}

function pricingOf(snap: StoredPricingSnapshot | null) {
  if (!snap) return null;
  return {
    fee: snap.fee,
    assetCode: snap.assetCode,
    appliedLayer: snap.appliedLayer,
    ruleId: snap.ruleId,
    recordedAt: snap.recordedAt,
  };
}

function amountText(value: string | null): string | null {
  if (value === null) return null;
  return formatAmount(parseAmount(value));
}

export function createFounderMerchantReads(deps: {
  sql: Sql;
  pay?: PayService;
  disputes?: DisputeCaseStore;
  /** Published local-test starter fee. Omitted or null means it is not set. */
  starterFee?: MerchantStarterFee | null;
}) {
  const sql = deps.sql;
  const pay = deps.pay;
  const starterFee = deps.starterFee ?? null;
  const callerFor = founderReadCaller;
  const disputes = new DisputeOpsService(sql, deps.disputes ?? defaultDisputeCaseStore);
  const payouts = new PayoutList(sql);
  const customers = new CustomerDirectory(sql);
  const invoices = new InvoiceService(sql);
  const team = new TeamService(sql);
  const kyb = new MerchantKybView(sql);
  const activity = new ActivityFeed(sql);
  const exports_ = new ExportService(sql, { disputes: deps.disputes ?? defaultDisputeCaseStore });
  const webhooks = new WebhookOps(sql);
  const subscriptions = new SubscriptionService(sql);

  async function assertMerchant(merchantId: string): Promise<void> {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE id = ${merchantId}::uuid`;
    if (!rows[0]) throw merchantNotFound();
  }

  return {
    hasPay: pay !== undefined,

    async section(founderUserId: string, input: FounderMerchantSectionInput): Promise<FounderMerchantSectionPage> {
      if (PAY_SECTIONS.has(input.section) && !pay) {
        throw new MerchantOpsError('pay.not_built', 'unavailable');
      }
      await assertMerchant(input.merchantId);
      const caller = callerFor(input.merchantId, founderUserId);
      const filters = input.filters ?? {};
      const limit = input.limit;
      const cursor = input.cursor;
      switch (input.section) {
        case 'payments': {
          const page = await pay!.listPayments({
            merchantId: input.merchantId,
            limit,
            cursor,
            search: filters.search,
            assetId: filters.assetId,
            from: filters.from,
            to: filters.to,
            status: oneOf(filters.status, ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']),
          });
          return {
            section: 'payments',
            items: page.items.map((row) => ({
              id: row.id,
              merchantId: row.merchantId,
              assetId: row.assetId,
              amount: formatAmount(row.amount),
              capturedAmount: formatAmount(row.capturedAmount),
              refundedAmount: formatAmount(row.refundedAmount),
              method: row.method,
              railAdapter: row.railAdapter,
              railRef: row.railRef,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              failureCode: row.failure?.code ?? null,
              pricing: pricingOf(row.pricingSnapshot),
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'refunds': {
          const page = await pay!.listRefunds({
            merchantId: input.merchantId,
            limit,
            cursor,
            search: filters.search,
            assetId: filters.assetId,
            from: filters.from,
            to: filters.to,
            paymentId: filters.paymentId,
            status: oneOf(filters.status, ['posted', 'settled', 'reversed']),
          });
          return { section: 'refunds', items: page.items, nextCursor: page.nextCursor };
        }
        case 'disputes': {
          const page = await disputes.list(caller, {
            limit,
            cursor,
            status: oneOf(filters.status, ['open', 'contested', 'accepted', 'won', 'lost']),
            paymentId: filters.paymentId,
            search: filters.search,
            from: filters.from,
            to: filters.to,
            dueAfter: filters.dueAfter,
            dueBefore: filters.dueBefore,
            deadline: filters.deadline,
          });
          const effects = await loadChargebackLedgerEffects(
            sql,
            page.items.map((row) => row.disputeId),
          );
          return {
            section: 'disputes',
            items: page.items.map((row) => ({
              merchantId: input.merchantId,
              ...disputeWire(row, effects.get(row.disputeId) ?? null),
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'settlements': {
          const page = await pay!.listSettlements({
            merchantId: input.merchantId,
            limit,
            cursor,
            search: filters.search,
            assetId: filters.assetId,
            from: filters.from,
            to: filters.to,
            status: oneOf(filters.status, ['pending', 'posted', 'paid_out', 'failed']),
          });
          return {
            section: 'settlements',
            items: page.items.map((row) => ({
              id: row.id,
              merchantId: row.merchantId,
              window: row.window,
              assetId: row.assetId,
              gross: formatAmount(row.gross),
              fees: formatAmount(row.fees),
              net: formatAmount(row.net),
              status: row.status,
              payoutMethod: row.payoutMethod && row.payoutMethod.length <= 64 ? row.payoutMethod : null,
              payoutReference: payoutReference(row.payoutRef),
              createdAt: row.createdAt.toISOString(),
              sentAt: stamp(row.sentAt),
              settledAt: stamp(row.settledAt),
              failedAt: stamp(row.failedAt),
              failureCode: row.failure?.code ?? null,
              pricing: pricingOf(row.pricingSnapshot),
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'payouts': {
          const page = await payouts.list(caller, {
            limit,
            cursor,
            status: oneOf(filters.status, ['pending', 'posted', 'paid_out', 'failed']),
            assetId: filters.assetId,
            from: filters.from,
            to: filters.to,
            search: filters.search,
          });
          return { section: 'payouts', items: page.items, nextCursor: page.nextCursor };
        }
        case 'destinations': {
          const page = await pay!.listPayoutDestinations({ merchantId: input.merchantId, limit, cursor });
          // The founder section's contract (founder-admin.ts) predates the destination state (J-merchant-02 #5); it is
          // left out here until that contract carries it, rather than changing a second consumer in this slice.
          const items = page.items.map(({ state: _state, activatesAt: _activatesAt, ...item }) => item);
          return { section: 'destinations', items, nextCursor: page.nextCursor };
        }
        case 'customers': {
          const page = await customers.list(caller, {
            limit,
            cursor,
            search: filters.search,
            seenAfter: filters.from,
            seenBefore: filters.to,
          });
          return { section: 'customers', items: page.items, nextCursor: page.nextCursor };
        }
        case 'links': {
          const page = await pay!.listPaymentLinks(input.merchantId, {
            limit,
            cursor,
            search: filters.search,
            assetId: filters.assetId,
            from: filters.from,
            to: filters.to,
            active: filters.active,
          });
          return {
            section: 'links',
            items: page.items.map((row) => ({
              id: row.id,
              prefix: row.prefix,
              label: row.label,
              amount: amountText(row.amount),
              currency: row.currency,
              active: row.active,
              expiresAt: row.expiresAt,
              maxUses: row.maxUses,
              uses: row.uses,
              createdAt: row.createdAt,
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'invoices': {
          const page = await invoices.list(caller, {
            limit,
            cursor,
            status: oneOf(filters.status, ['draft', 'sent', 'void', 'paid']),
            assetId: filters.assetId,
            search: filters.search,
            from: filters.from,
            to: filters.to,
          });
          return {
            section: 'invoices',
            items: page.items.map((row) => ({
              id: row.id,
              status: row.status,
              assetId: row.assetId,
              amount: row.amount,
              customerRef: row.customerRef,
              description: row.description,
              paymentLinkId: row.paymentLinkId,
              paymentId: row.paymentId,
              sentAt: row.sentAt,
              voidedAt: row.voidedAt,
              paidAt: row.paidAt,
              createdAt: row.createdAt,
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'subscriptions': {
          const page = await subscriptions.listSubscriptions(input.merchantId, {
            limit,
            cursor,
            search: filters.search,
            from: filters.from,
            to: filters.to,
            status: oneOf(filters.status, ['active', 'paused', 'cancelled', 'completed']),
          });
          return {
            section: 'subscriptions',
            items: page.items.map((row) => ({
              id: row.id,
              mandateId: row.mandateId,
              merchantId: row.merchantId,
              customerId: row.customerId,
              status: row.status,
              path: row.path,
              nextRunAt: row.nextRunAt.toISOString(),
              createdAt: row.createdAt.toISOString(),
              cancelledAt: stamp(row.cancelledAt),
              pausedAt: stamp(row.pausedAt),
              stallReason: row.stallReason,
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'team': {
          const page = await team.list(caller, {
            limit,
            cursor,
            status: oneOf(filters.status, ['active', 'invited', 'removed']),
            role: filters.role,
            search: filters.search,
          });
          return {
            section: 'team',
            items: page.items.map((row) => ({
              memberId: row.memberId,
              userId: row.userId,
              role: row.role,
              status: row.status,
              label: row.label,
              invitedBy: row.invitedBy,
              createdAt: row.createdAt,
              activatedAt: row.activatedAt,
              removedAt: row.removedAt,
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'apiKeys':
          return { section: 'apiKeys', catalog: 'not_configured', items: [], nextCursor: null };
        case 'webhooks': {
          const page = await webhooks.list(caller, {
            limit,
            cursor,
            status: oneOf(filters.status, ['active', 'disabled']),
            search: filters.search,
          });
          return { section: 'webhooks', items: page.items, nextCursor: page.nextCursor };
        }
        case 'deliveries': {
          const page = await webhooks.listDeliveries(caller, {
            limit,
            cursor,
            endpointId: filters.endpointId,
            status: oneOf(filters.status, ['pending', 'delivered', 'failed', 'dead']),
            from: filters.from,
            to: filters.to,
          });
          return {
            section: 'deliveries',
            items: page.items.map((row) => ({
              id: row.id,
              endpointId: row.endpointId,
              eventType: row.eventType,
              status: row.status,
              attempts: row.attempts,
              lastStatusCode: row.lastStatusCode,
              createdAt: row.createdAt,
              deliveredAt: row.deliveredAt,
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'activity': {
          const page = await activity.list(caller, {
            limit,
            cursor,
            objectType: filters.objectType,
            search: filters.search,
            from: filters.from,
            to: filters.to,
          });
          return { section: 'activity', items: page.items, nextCursor: page.nextCursor };
        }
        case 'exports': {
          const page = await exports_.list(caller, {
            limit,
            cursor,
            kind: filters.kind,
            status: oneOf(filters.status, ['queued', 'running', 'ready', 'failed', 'expired']),
            search: filters.search,
            from: filters.from,
            to: filters.to,
          });
          return {
            section: 'exports',
            items: page.items.map((row) => ({
              jobId: row.jobId,
              kind: row.kind,
              status: row.status,
              failureCode: row.failureCode,
              fileName: row.fileName,
              sizeBytes: row.sizeBytes,
              rowCount: row.rowCount,
              requestedBy: row.requestedBy,
              createdAt: row.createdAt,
              completedAt: row.completedAt,
            })),
            nextCursor: page.nextCursor,
          };
        }
        case 'profile': {
          const [names, current, history] = await Promise.all([
            sql<
              Array<{
                display_name: string | null;
                legal_name: string | null;
                status: 'pending' | 'active' | 'suspended' | 'closed';
                pricing: unknown;
              }>
            >`
              SELECT display_name, legal_name, status::text AS status, pricing
                FROM pay.merchants WHERE id = ${input.merchantId}::uuid`,
            kyb.current(caller),
            kyb.history(caller, { limit, cursor }),
          ]);
          const row = names[0];
          if (!row) throw merchantNotFound();
          if (current.mode !== 'gateway' && current.mode !== 'psp' && current.mode !== 'payfac') throw badStatus();
          if (
            current.kybStatus !== 'none' &&
            current.kybStatus !== 'pending' &&
            current.kybStatus !== 'approved' &&
            current.kybStatus !== 'rejected'
          ) {
            throw badStatus();
          }
          let fee: ReturnType<typeof merchantFeeView>;
          try {
            fee = merchantFeeView(row.pricing, starterFee);
          } catch (err) {
            if (err instanceof MerchantStoredFeeError) {
              throw new PayError(`Merchant ${input.merchantId} has malformed pricing`, 'pay.merchant_pricing_invalid');
            }
            throw err;
          }
          return {
            section: 'profile',
            current: {
              merchantId: input.merchantId,
              displayName: row.display_name,
              legalName: row.legal_name,
              status: row.status,
              mode: current.mode,
              kybStatus: current.kybStatus,
              kybRef: current.kybRef,
              feeBps: fee.feeBps,
              starterFee: fee.starterFee,
            },
            items: history.items.map((item) => ({
              seq: item.seq,
              fromStatus: kybStatus(item.fromStatus),
              toStatus: kybStatus(item.toStatus),
              kybRef: item.kybRef,
              decidedBy: item.decidedBy,
              reason: item.reason,
              at: item.at,
            })),
            nextCursor: history.nextCursor,
          };
        }
        default:
          throw badStatus();
      }
    },

    async recent(input: { limit?: number; cursor?: string }) {
      const limit = requireLimit(input.limit);
      const after = decodeCursor(input.cursor);
      const rows = await sql<
        Array<{
          id: string;
          display_name: string | null;
          legal_name: string | null;
          status: 'pending' | 'active' | 'suspended' | 'closed';
          kyb_status: 'none' | 'pending' | 'approved' | 'rejected';
          created_at: Date;
          cursor_ts: string;
        }>
      >`
        SELECT id::text AS id, display_name, legal_name, status::text AS status, kyb_status::text AS kyb_status, created_at,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
          FROM pay.merchants
         WHERE true
           ${after ? sql`AND (created_at, id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit + 1}`;
      return toPage(
        rows,
        limit,
        (row) => ({
          merchantId: row.id,
          displayName: row.display_name,
          legalName: row.legal_name,
          status: row.status,
          kybStatus: row.kyb_status,
          createdAt: iso(row.created_at),
        }),
        (row) => encodeCursor(row.cursor_ts, row.id),
      );
    },

    async payoutList(input: FounderPayoutListInput) {
      return payouts.listAcross(input);
    },

    async disputeList(input: FounderDisputeListInput) {
      const page = await disputes.listAcross(input);
      const effects = await loadChargebackLedgerEffects(
        sql,
        page.items.map((row) => row.disputeId),
      );
      return {
        items: page.items.map((row) => ({
          merchantId: row.merchantId,
          ...disputeWire(row, effects.get(row.disputeId) ?? null),
        })),
        nextCursor: page.nextCursor,
      };
    },

    async live(now = new Date()) {
      const [payments, payoutRows, refunds, queues] = await Promise.all([
        sql<Array<{ status: string; h1: number; h24: number }>>`
          SELECT status::text AS status,
                 count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS h1,
                 count(*)::int AS h24
            FROM pay.payments
           WHERE created_at >= now() - interval '24 hours'
           GROUP BY status`,
        sql<Array<{ status: string; h1: number; h24: number }>>`
          SELECT status::text AS status,
                 count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS h1,
                 count(*)::int AS h24
            FROM pay.settlements
           WHERE created_at >= now() - interval '24 hours'
           GROUP BY status`,
        sql<Array<{ status: string; h1: number; h24: number }>>`
          SELECT CASE
                   WHEN rev.ts IS NOT NULL THEN 'reversed'
                   WHEN done.ts IS NOT NULL THEN 'settled'
                   ELSE 'posted'
                 END AS status,
                 count(*) FILTER (WHERE e.ts >= now() - interval '1 hour')::int AS h1,
                 count(*)::int AS h24
            FROM pay.payment_events e
            LEFT JOIN LATERAL (
              SELECT ts FROM pay.payment_events d
               WHERE d.payment_id = e.payment_id AND d.event = 'refunded'
                 AND d.payload->>'refundId' = e.payload->>'refundId'
               ORDER BY d.seq DESC LIMIT 1
            ) done ON true
            LEFT JOIN LATERAL (
              SELECT ts FROM pay.payment_events r
               WHERE r.payment_id = e.payment_id AND r.event = 'refund.reversed'
                 AND r.payload->>'refundId' = e.payload->>'refundId'
               ORDER BY r.seq DESC LIMIT 1
            ) rev ON true
           WHERE e.event = 'refund.posted' AND e.ts >= now() - interval '24 hours'
           GROUP BY 1`,
        sql<Array<{ approval_at: Date | null; payout_at: Date | null; dispute_due: Date | null }>>`
          SELECT
            (SELECT min(created_at) FROM pay.control_payout_approvals WHERE status = 'pending') AS approval_at,
            (SELECT min(created_at) FROM pay.settlements WHERE status = 'pending') AS payout_at,
            (SELECT min(d.response_due_at)
               FROM pay.dispute_response_deadlines d
               JOIN pay.dispute_cases c ON c.dispute_id = d.dispute_id AND c.merchant_id = d.merchant_id
              WHERE c.status IN ('open', 'contested') AND d.response_due_at IS NOT NULL) AS dispute_due`,
      ]);
      const split = (rows: Array<{ status: string; h1: number; h24: number }>) => ({
        h1: rows.filter((row) => row.h1 > 0).map((row) => ({ status: row.status, count: row.h1 })),
        h24: rows.filter((row) => row.h24 > 0).map((row) => ({ status: row.status, count: row.h24 })),
      });
      const payCounts = split(payments);
      const payoutCounts = split(payoutRows);
      const refundCounts = split(refunds);
      const queue = queues[0];
      return {
        asOf: now.toISOString(),
        h1: { payments: payCounts.h1, payouts: payoutCounts.h1, refunds: refundCounts.h1 },
        h24: { payments: payCounts.h24, payouts: payoutCounts.h24, refunds: refundCounts.h24 },
        queues: {
          oldestPendingApprovalAt: stamp(queue?.approval_at ?? null),
          oldestPendingApprovalAgeSeconds: ageSeconds(queue?.approval_at ?? null, now),
          oldestPendingPayoutAt: stamp(queue?.payout_at ?? null),
          oldestPendingPayoutAgeSeconds: ageSeconds(queue?.payout_at ?? null, now),
          earliestDisputeDeadlineAt: stamp(queue?.dispute_due ?? null),
        },
      };
    },

    async risk(input: FounderRiskSummaryInput, now = new Date()) {
      const range = input.window ? resolveWindow(input.window, now) : null;
      const [rows, through, failed] = await Promise.all([
        sql<Array<{ merchant_id: string; asset_code: string; captured: string }>>`
          SELECT merchant_id::text AS merchant_id, asset_code, sum(captured)::text AS captured
            FROM pay.metrics_merchant_day
           WHERE captured > 0
             ${range ? sql`AND day >= ${range.from}::date AND day < ${range.to}::date` : sql``}
           GROUP BY merchant_id, asset_code`,
        sql<Array<{ day: string | null }>>`SELECT max(day)::text AS day FROM pay.metrics_merchant_day`,
        sql<
          Array<{
            payments_failed: number;
            payouts_failed: number;
            refunds_reversed: number;
            webhook_failed: number;
            webhook_dead: number;
            exports_failed: number;
          }>
        >`
          SELECT
            (SELECT count(*)::int FROM pay.payments WHERE status = 'failed') AS payments_failed,
            (SELECT count(*)::int FROM pay.settlements WHERE status = 'failed') AS payouts_failed,
            (SELECT count(*)::int FROM pay.payment_events WHERE event = 'refund.reversed') AS refunds_reversed,
            (SELECT count(*)::int FROM pay.merchant_webhook_deliveries WHERE status = 'failed') AS webhook_failed,
            (SELECT count(*)::int FROM pay.merchant_webhook_deliveries WHERE status = 'dead') AS webhook_dead,
            (SELECT count(*)::int FROM pay.merchant_export_jobs WHERE status = 'failed') AS exports_failed`,
      ]);
      const byAsset = new Map<string, Array<{ merchantId: string; captured: Amount }>>();
      for (const row of rows) {
        const list = byAsset.get(row.asset_code) ?? [];
        list.push({ merchantId: row.merchant_id, captured: parseAmount(row.captured) });
        byAsset.set(row.asset_code, list);
      }
      const concentration = [...byAsset.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([assetCode, merchants]) => {
          const total = merchants.reduce((sum, row) => sum + row.captured, 0n);
          const top = merchants
            .slice()
            .sort((a, b) => (a.captured === b.captured ? (a.merchantId < b.merchantId ? -1 : 1) : a.captured > b.captured ? -1 : 1))
            .slice(0, input.topN);
          const topTotal = top.reduce((sum, row) => sum + row.captured, 0n);
          return {
            assetCode,
            totalCaptured: formatAmount(total),
            topShare: concentrationShare(topTotal, total),
            merchants: top.map((row) => ({
              merchantId: row.merchantId,
              captured: formatAmount(row.captured),
              share: concentrationShare(row.captured, total),
            })),
          };
        });
      const counts = failed[0];
      return {
        window: (input.window ?? null) as PayMetricWindow | null,
        projectedThrough: through[0]?.day ?? null,
        concentration,
        failedWorkflows: {
          paymentsFailed: counts?.payments_failed ?? 0,
          payoutsFailed: counts?.payouts_failed ?? 0,
          refundsReversed: counts?.refunds_reversed ?? 0,
          webhookDeliveriesFailed: counts?.webhook_failed ?? 0,
          webhookDeliveriesDead: counts?.webhook_dead ?? 0,
          exportsFailed: counts?.exports_failed ?? 0,
        },
      };
    },
  };
}

function disputeWire(
  row: {
    disputeId: string;
    paymentId: string;
    amount: string;
    assetId: string;
    reasonCode: string | null;
    status: 'open' | 'contested' | 'accepted' | 'won' | 'lost';
    openedAt: string;
    contestedAt: string | null;
    closedAt: string | null;
    responseDueAt: string | null;
    responseDueSource: 'rail_event' | null;
    ledgerWire: 'posted' | 'refused';
    ledgerRefuseCode: string | null;
  },
  effect: ChargebackLedgerEffect | null,
) {
  return {
    disputeId: row.disputeId,
    paymentId: row.paymentId,
    amount: row.amount,
    assetId: row.assetId,
    reasonCode: row.reasonCode,
    status: row.status,
    openedAt: row.openedAt,
    contestedAt: row.contestedAt,
    closedAt: row.closedAt,
    responseDueAt: row.responseDueAt,
    responseDueSource: row.responseDueSource,
    ledgerWire: row.ledgerWire,
    ledgerRefuseCode: row.ledgerRefuseCode,
    ledgerEffect: effect,
  };
}
