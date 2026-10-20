import { transaction } from '@intafaced/db';
import { MoneyError, formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { consumePayApproval, payActionPayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { PAY_WITHDRAWAL_LIMIT_CHANGE, withdrawalLimitChangeFields } from '../approval-bindings.js';
import { requireDualControl } from '../dual-control.js';
import { LimitChangeError } from './change-errors.js';
import { limitDualReasons, sameFigures, type LimitFigures } from './change-policy.js';
import type { LimitChangeInput, LimitEventView, LimitPreviewInput, LimitView } from './change-schemas.js';
import * as store from './change-store.js';

/** The action an identity approval must be issued for. */
export const WITHDRAWAL_LIMIT_CHANGE_ACTION = PAY_WITHDRAWAL_LIMIT_CHANGE;

export interface LimitChangeServiceDeps {
  readonly sql: Sql;
  /** Identity-bound second-founder approvals. An unwired consumer refuses every change that needs one. */
  readonly approvals: ActionApprovalConsumer;
}

interface Plan {
  readonly tier: string;
  readonly assetId: string;
  readonly before: store.StoredLimit | null;
  readonly beforeFigures: LimitFigures | null;
  readonly after: LimitFigures | null;
  readonly reasons: string[];
  readonly hashFields: Record<string, string>;
}

const iso = (d: Date) => d.toISOString();
const figuresView = (f: LimitFigures | null) =>
  f === null ? null : { perTx: formatAmount(f.perTx), rolling24h: formatAmount(f.rolling24h) };

/**
 * Owner-set withdrawal limits per KYC tier and asset (W-withdraw-05, D-148).
 *
 * BLANK REFUSES. A tier and asset with no figures is unset, and the guard refuses
 * every withdrawal for it. Nothing here invents, defaults or seeds a number.
 *
 * FOUR EYES. Setting a limit or raising either figure needs a second founder,
 * identity-verified and bound to this exact change (`preview` returns the hash).
 * Lowering a figure or clearing the limit only tightens, so one founder may do
 * it. Every change, either way, appends an audit event.
 */
export class LimitChangeService {
  private readonly sql: Sql;
  private readonly approvals: ActionApprovalConsumer;

  constructor(deps: LimitChangeServiceDeps) {
    this.sql = deps.sql;
    this.approvals = deps.approvals;
  }

  async list(): Promise<LimitView[]> {
    return (await store.listLimits(this.sql)).map(view);
  }

  async history(tier: string | undefined, assetId: string | undefined, limit: number): Promise<LimitEventView[]> {
    return (await store.listEvents(this.sql, tier, assetId, limit)).map((r) => ({
      id: r.id,
      seq: String(r.seq),
      tier: r.tier,
      assetId: r.asset_id,
      action: r.action,
      actorId: r.actor_id,
      approverId: r.approver_id,
      dualControl: r.dual_control,
      before: r.before,
      after: r.after,
      reason: r.reason,
      createdAt: iso(r.created_at),
    }));
  }

  /** What a change would need, and the hash the second founder's approval must bind to. */
  async preview(
    input: LimitPreviewInput,
  ): Promise<{ needsDualControl: boolean; reasons: string[]; actionType: string; payloadHash: string }> {
    const plan = await this.plan(input);
    return {
      needsDualControl: plan.reasons.length > 0,
      reasons: plan.reasons,
      actionType: WITHDRAWAL_LIMIT_CHANGE_ACTION,
      payloadHash: payActionPayloadHash(WITHDRAWAL_LIMIT_CHANGE_ACTION, plan.hashFields),
    };
  }

  async change(actorId: string, input: LimitChangeInput): Promise<LimitView> {
    const plan = await this.plan(input);
    let approverId: string | null = null;
    if (plan.reasons.length > 0) {
      const approver = await consumePayApproval(this.approvals, input, WITHDRAWAL_LIMIT_CHANGE_ACTION, plan.hashFields);
      approverId = requireDualControl(actorId.toLowerCase(), approver.trim().toLowerCase());
    }
    try {
      return await transaction(this.sql, async (tx) => {
        const current = await store.getLimit(tx, plan.tier, plan.assetId, true);
        if (plan.before === null ? current !== null : current === null || current.version !== plan.before.version) {
          throw new LimitChangeError('limits.version_conflict', 'the limit changed while the change was being approved; reload and retry');
        }
        const saved =
          plan.before === null
            ? await store.insertLimit(tx, plan.tier, plan.assetId, plan.after, actorId)
            : await store.updateLimit(tx, plan.tier, plan.assetId, plan.after, actorId);
        await store.appendEvent(tx, {
          tier: plan.tier,
          assetId: plan.assetId,
          actorId,
          approverId,
          before: plan.beforeFigures,
          after: plan.after,
          reason: input.reason,
        });
        return view(saved);
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new LimitChangeError('limits.already_exists', 'the limit was created by someone else first');
      }
      throw error;
    }
  }

  /** Reads only. Checks the rules a change must meet before anything is approved or written. */
  private async plan(input: LimitPreviewInput): Promise<Plan> {
    let after: LimitFigures | null = null;
    if (input.limit !== null) {
      try {
        after = { perTx: parseAmount(input.limit.perTx), rolling24h: parseAmount(input.limit.rolling24h) };
      } catch (error) {
        if (error instanceof MoneyError)
          throw new LimitChangeError('limits.amount_invalid', 'a figure does not fit the ledger amount range');
        throw error;
      }
      if (after.perTx <= 0n || after.rolling24h <= 0n) {
        throw new LimitChangeError('limits.amount_invalid', 'a figure must be above zero; zero is not "unlimited" and not "unset"');
      }
      if (after.perTx > after.rolling24h) {
        throw new LimitChangeError('limits.per_tx_above_rolling', 'the per-transaction figure is above the rolling 24 hour figure');
      }
    }
    const before = await store.getLimit(this.sql, input.tier, input.assetId);
    if (input.expectedVersion === null) {
      if (before !== null) throw new LimitChangeError('limits.already_exists', 'the entry exists; send its current version to edit it');
    } else if (before === null) {
      throw new LimitChangeError('limits.not_found', 'no such entry to edit');
    } else if (before.version !== input.expectedVersion) {
      throw new LimitChangeError('limits.version_conflict', 'the limit changed since you loaded it; reload and retry');
    }
    const beforeFigures = before?.figures ?? null;
    if (sameFigures(beforeFigures, after) && !(before === null && after === null)) {
      throw new LimitChangeError('limits.unchanged', 'the figures are already what you sent');
    }
    return {
      tier: input.tier,
      assetId: input.assetId,
      before,
      beforeFigures,
      after,
      reasons: limitDualReasons(beforeFigures, after),
      hashFields: withdrawalLimitChangeFields({
        tier: input.tier,
        assetId: input.assetId,
        expectedVersion: String(input.expectedVersion),
        after: after === null ? 'clear' : `${formatAmount(after.perTx)}/${formatAmount(after.rolling24h)}`,
        reason: input.reason,
      }),
    };
  }
}

function view(l: store.StoredLimit): LimitView {
  return {
    tier: l.tier as LimitView['tier'],
    assetId: l.assetId,
    limit: figuresView(l.figures),
    version: l.version,
    updatedAt: iso(l.updatedAt),
    updatedBy: l.updatedBy,
  };
}
