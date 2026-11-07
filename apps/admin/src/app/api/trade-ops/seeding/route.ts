import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { readMarkets } from '@/lib/trade-ops/reads';
import { proposeSeedConfig, readSeedConfigs, writeSeedConfig } from '@/lib/trade-ops/seeding-calls';
import {
  checkSeedConfig,
  MM_SEED_ACTION_TYPE,
  MM_SEED_TARGET_SERVICE,
  seedConfigPayloadHash,
  type MidSource,
  type SeedConfigBody,
  type SeedConfigDraft,
} from '@/lib/trade-ops/seeding-model';

/**
 * Seeding room (J-cex-spot-20 #5), through svc-trade `admin.marketMaker.*` and identity's approvals.
 *
 *   POST { action: 'propose', market, draft }               file the two-person request for the market's next version
 *   POST { action: 'apply',   market, draft, approvalId }   write it, once the request is APPROVED
 *
 * The version a request is bound to is read here, from svc-trade, never taken from the page. A blank value refuses with
 * svc-trade's own `mm.seed_unset` before anything is filed; svc-trade checks it again when it writes. Nothing here moves
 * money: the seed job places the house account's orders through the ordinary order path.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (code: string, message: string) => refused(code, message, 400);

function draftOf(v: unknown): SeedConfigDraft | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const s = (x: unknown): string | null | undefined =>
    x === null || x === undefined || x === '' ? null : typeof x === 'string' ? x : undefined;
  const fields = [r.halfSpreadBps, r.stepBps, r.levels, r.qtyPerLevel, r.configuredMid].map(s);
  if (typeof r.enabled !== 'boolean' || fields.some((f) => f === undefined)) return null;
  const midSource = r.midSource === 'configured' || r.midSource === 'venue' ? (r.midSource as MidSource) : null;
  const [halfSpreadBps, stepBps, levels, qtyPerLevel, configuredMid] = fields as Array<string | null>;
  return {
    enabled: r.enabled,
    halfSpreadBps: halfSpreadBps!,
    stepBps: stepBps!,
    levels: levels!,
    qtyPerLevel: qtyPerLevel!,
    midSource,
    configuredMid: configuredMid!,
  };
}

/** The request for the market's next version exactly as the form asks, or the refusal that stops it. */
async function bodyOf(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<SeedConfigBody>> {
  const market = typeof body.market === 'string' ? body.market : '';
  if (!UUID.test(market)) return bad('trade_ops.seed_market_missing', 'Choose a market.');
  const draft = draftOf(body.draft);
  if (!draft) return bad('trade_ops.seed_draft_invalid', 'The configuration is not complete. Read the room again.');
  const check = checkSeedConfig(draft);
  if (!check.ok) return bad(check.code, check.message);
  const [markets, configs] = await Promise.all([readMarkets(ctx), readSeedConfigs(ctx)]);
  if (markets.kind !== 'ok') return markets;
  if (configs.kind !== 'ok') return configs;
  if (!markets.data.some((m) => m.id === market)) return bad('trade_ops.seed_market_missing', 'That market is not in the catalogue.');
  const expectedVersion = configs.data.find((c) => c.market === market)?.version ?? '0';
  return ok({ market, expectedVersion, config: check.config });
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'propose': {
      const req = await bodyOf(ctx, body);
      if (req.kind !== 'ok') return req;
      const filed = await proposeSeedConfig(ctx, req.data);
      return filed.kind === 'ok'
        ? ok({ approval: filed.data, payloadHash: seedConfigPayloadHash(req.data), expectedVersion: req.data.expectedVersion }, filed.asOf)
        : filed;
    }
    case 'apply': {
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
      if (!TOKEN.test(approvalId)) return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
      const req = await bodyOf(ctx, body);
      if (req.kind !== 'ok') return req;
      const approval = await readMatchingApproval(ctx, approvalId);
      if (approval.kind !== 'ok') return approval;
      const a = approval.data;
      if (a.status !== 'APPROVED')
        return refused(
          a.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
          a.status === 'PENDING'
            ? 'This request is still waiting for a second founder. Nothing was written.'
            : `This request is ${a.status}, not APPROVED. Nothing was written.`,
          409,
        );
      if (a.actionType !== MM_SEED_ACTION_TYPE || a.targetService !== MM_SEED_TARGET_SERVICE || a.targetId !== req.data.market)
        return refused('trade_ops.seed_approval_mismatch', 'That approval is for a different change. Nothing was written.', 409);
      if (a.payloadHash !== seedConfigPayloadHash(req.data))
        return refused(
          'trade_ops.seed_approval_mismatch',
          'That approval is for different values or an older version. Nothing was written.',
          409,
        );
      return writeSeedConfig(ctx, { ...req.data, approvalId, clientRequestId: a.operationId });
    }
    default:
      return bad('trade_ops.bad_action', 'Unknown seeding action.');
  }
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
