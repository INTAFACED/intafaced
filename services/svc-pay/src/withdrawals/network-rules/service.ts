import { z } from 'zod';
import type { Sql } from 'postgres';
import { router, TRPCError, payAmountStringSchema } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  consumePayApproval,
  payActionPayloadHash,
  ActionApprovalConsumeError,
  type ActionApprovalConsumer,
} from '../../action-approval-consume.js';
import { requireDualControl, DualControlError } from '../../dual-control.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import type { FounderAuthority } from '../../founder-authority.js';
import { assetCodeSchema, reasonSchema } from '../../registries/schemas.js';

/**
 * The owner's withdrawal rules per asset and network (W-withdraw-02, J-wallet-05 #1): the smallest and largest amount one
 * withdrawal may send, the step every amount is a whole multiple of, and whether the network takes a tag or memo. The customer
 * reads them on Withdraw before any fee (`withdrawal.networkRules`), and a quote outside them is refused
 * (`WithdrawalQuoteService`), so a send is never quoted on terms the network's rules refuse.
 *
 * NOTHING HAS A DEFAULT. A pair with no row has no rules: the read and every quote on it refuse `withdrawal_network_rules.unset`
 * (a blank minimum is not zero, a blank maximum is not unlimited). Founder-only, audited, and dual-controlled where a change
 * loosens: publishing a pair, lowering its minimum, raising its maximum, a step that is not a whole multiple of the one before,
 * or dropping a required tag (a second founder's identity-bound approval bound to the exact change).
 */

export const WITHDRAWAL_NETWORK_RULE_ACTION = 'pay.withdrawal_network_rule_change';

export type WithdrawalNetworkRuleErrorCode =
  | 'withdrawal_network_rules.unset'
  | 'withdrawal_network_rules.not_found'
  | 'withdrawal_network_rules.already_exists'
  | 'withdrawal_network_rules.version_conflict'
  | 'withdrawal_network_rules.invalid'
  | 'withdrawal_network_rules.unwired';

const KIND: Record<WithdrawalNetworkRuleErrorCode, TRPCError['code']> = {
  'withdrawal_network_rules.unset': 'PRECONDITION_FAILED',
  'withdrawal_network_rules.not_found': 'NOT_FOUND',
  'withdrawal_network_rules.already_exists': 'CONFLICT',
  'withdrawal_network_rules.version_conflict': 'CONFLICT',
  'withdrawal_network_rules.invalid': 'BAD_REQUEST',
  'withdrawal_network_rules.unwired': 'SERVICE_UNAVAILABLE',
};

export class WithdrawalNetworkRuleError extends Error {
  constructor(
    readonly code: WithdrawalNetworkRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WithdrawalNetworkRuleError';
  }
}

export function withdrawalNetworkRuleToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof WithdrawalNetworkRuleError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  if (error instanceof DualControlError || error instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
  }
  return error;
}

export const networkIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const versionSchema = z.number().int().min(1).max(2_147_483_647);
export const tagRuleSchema = z.enum(['none', 'required']);

export const withdrawalNetworkRuleSaveInputSchema = z
  .object({
    assetId: assetCodeSchema,
    networkId: networkIdSchema,
    /** Decimal strings above zero, never blank: step <= minimum <= maximum. */
    minimum: payAmountStringSchema,
    maximum: payAmountStringSchema,
    step: payAmountStringSchema,
    tag: tagRuleSchema,
    /** null creates the pair's rules; otherwise the version this edit is based on. */
    expectedVersion: versionSchema.nullable(),
    reason: reasonSchema,
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();
export type WithdrawalNetworkRuleSaveInput = z.infer<typeof withdrawalNetworkRuleSaveInputSchema>;

/** What a customer reads: the rules only, never who set them. */
export const withdrawalNetworkRulesSchema = z
  .object({ assetId: z.string(), networkId: z.string(), minimum: z.string(), maximum: z.string(), step: z.string(), tag: tagRuleSchema })
  .strict();
export type WithdrawalNetworkRules = z.infer<typeof withdrawalNetworkRulesSchema>;

export const withdrawalNetworkRuleViewSchema = withdrawalNetworkRulesSchema
  .extend({ version: z.number().int(), setBy: z.string(), setAt: z.string() })
  .strict();
export type WithdrawalNetworkRuleView = z.infer<typeof withdrawalNetworkRuleViewSchema>;

export const withdrawalNetworkRulePreviewSchema = z
  .object({ needsDualControl: z.boolean(), reasons: z.array(z.string()), actionType: z.string(), payloadHash: z.string() })
  .strict();

export const withdrawalNetworkRuleEventViewSchema = z
  .object({
    seq: z.string(),
    assetId: z.string(),
    networkId: z.string(),
    action: z.enum(['create', 'update']),
    actorId: z.string(),
    approverId: z.string().nullable(),
    dualControl: z.boolean(),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()),
    reason: z.string(),
    createdAt: z.string(),
  })
  .strict();

interface Row {
  asset_id: string;
  network_id: string;
  minimum: string;
  maximum: string;
  step: string;
  tag: 'none' | 'required';
  version: number;
  set_by: string;
  set_at: Date;
}

type State = Pick<WithdrawalNetworkRules, 'minimum' | 'maximum' | 'step' | 'tag'>;

const stateOf = (row: Row): State => ({ minimum: row.minimum, maximum: row.maximum, step: row.step, tag: row.tag });
const rulesOf = (row: Row): WithdrawalNetworkRules => ({ assetId: row.asset_id, networkId: row.network_id, ...stateOf(row) });
const viewOf = (row: Row): WithdrawalNetworkRuleView => ({
  ...rulesOf(row),
  version: row.version,
  setBy: row.set_by,
  setAt: row.set_at.toISOString(),
});

/** Canonical decimal above zero, so "10" and "10.0" bind to the same approval. */
function canonical(field: string, value: string): string {
  let parsed: Amount;
  try {
    parsed = parseAmount(value);
  } catch {
    throw new WithdrawalNetworkRuleError('withdrawal_network_rules.invalid', `the ${field} is not an exact decimal this ledger can hold`);
  }
  if (parsed <= 0n) throw new WithdrawalNetworkRuleError('withdrawal_network_rules.invalid', `the ${field} must be above zero`);
  return formatAmount(parsed);
}

/**
 * What needs a second founder: publishing a pair (sends on it become possible), and on an edit lowering the minimum, raising the
 * maximum, a step that is not a whole multiple of the old one (amounts that were refused become sendable), or dropping a
 * required tag.
 * Tightening needs one founder.
 */
export function withdrawalNetworkRuleDualReasons(before: State | null, after: State): string[] {
  if (before === null) return ['published'];
  const reasons: string[] = [];
  if (parseAmount(after.minimum) < parseAmount(before.minimum)) reasons.push('minimum_lowered');
  if (parseAmount(after.maximum) > parseAmount(before.maximum)) reasons.push('maximum_raised');
  if (parseAmount(after.step) % parseAmount(before.step) !== 0n) reasons.push('step_loosened');
  if (before.tag === 'required' && after.tag === 'none') reasons.push('tag_dropped');
  return reasons;
}

/** Why an amount is outside a pair's rules, or null when it is inside them. */
export function amountOutsideRules(rules: State, amount: Amount): 'below_minimum' | 'above_maximum' | 'off_step' | null {
  if (amount < parseAmount(rules.minimum)) return 'below_minimum';
  if (amount > parseAmount(rules.maximum)) return 'above_maximum';
  if (amount % parseAmount(rules.step) !== 0n) return 'off_step';
  return null;
}

export interface WithdrawalNetworkRuleServiceDeps {
  readonly sql: Sql;
  readonly approvals: ActionApprovalConsumer;
}

/** The customer's read of one pair's rules. A pair with no row refuses `withdrawal_network_rules.unset`. */
export async function readWithdrawalNetworkRules(sql: Sql, assetId: string, networkId: string): Promise<WithdrawalNetworkRules> {
  const [row] = await sql<Row[]>`SELECT * FROM pay.withdrawal_network_rules WHERE asset_id = ${assetId} AND network_id = ${networkId}`;
  if (!row) {
    throw new WithdrawalNetworkRuleError(
      'withdrawal_network_rules.unset',
      `the minimum, maximum, step and tag rule for ${assetId} on ${networkId} are not set`,
    );
  }
  return rulesOf(row);
}

export class WithdrawalNetworkRuleService {
  constructor(private readonly deps: WithdrawalNetworkRuleServiceDeps) {}

  async list(): Promise<WithdrawalNetworkRuleView[]> {
    const rows = await this.deps.sql<Row[]>`SELECT * FROM pay.withdrawal_network_rules ORDER BY asset_id, network_id`;
    return rows.map(viewOf);
  }

  async history(assetId: string | undefined, networkId: string | undefined, limit: number) {
    const rows = await this.deps.sql<
      Array<{
        seq: string;
        asset_id: string;
        network_id: string;
        action: 'create' | 'update';
        actor_id: string;
        approver_id: string | null;
        dual_control: boolean;
        before: Record<string, unknown> | null;
        after: Record<string, unknown>;
        reason: string;
        created_at: Date;
      }>
    >`
      SELECT seq::text AS seq, asset_id, network_id, action, actor_id, approver_id, dual_control, before, after, reason, created_at
        FROM pay.withdrawal_network_rule_events
       WHERE (${assetId ?? null}::text IS NULL OR asset_id = ${assetId ?? null})
         AND (${networkId ?? null}::text IS NULL OR network_id = ${networkId ?? null})
       ORDER BY seq DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      seq: r.seq,
      assetId: r.asset_id,
      networkId: r.network_id,
      action: r.action,
      actorId: r.actor_id,
      approverId: r.approver_id,
      dualControl: r.dual_control,
      before: r.before,
      after: r.after,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async preview(input: WithdrawalNetworkRuleSaveInput) {
    const plan = await this.plan(input);
    return {
      needsDualControl: plan.reasons.length > 0,
      reasons: plan.reasons,
      actionType: WITHDRAWAL_NETWORK_RULE_ACTION,
      payloadHash: payActionPayloadHash(WITHDRAWAL_NETWORK_RULE_ACTION, plan.fields),
    };
  }

  async save(actorId: string, input: WithdrawalNetworkRuleSaveInput): Promise<WithdrawalNetworkRuleView> {
    const plan = await this.plan(input);
    let approverId: string | null = null;
    if (plan.reasons.length > 0) {
      const approver = await consumePayApproval(this.deps.approvals, input, WITHDRAWAL_NETWORK_RULE_ACTION, plan.fields);
      approverId = requireDualControl(actorId.toLowerCase(), approver.trim().toLowerCase());
    }
    const { sql } = this.deps;
    try {
      return await transaction(sql, async (tx) => {
        const [current] = await tx<Row[]>`
          SELECT * FROM pay.withdrawal_network_rules WHERE asset_id = ${input.assetId} AND network_id = ${input.networkId} FOR UPDATE`;
        if (plan.before === null ? current !== undefined : current === undefined || current.version !== plan.before.version) {
          throw new WithdrawalNetworkRuleError(
            'withdrawal_network_rules.version_conflict',
            'the rules changed while the change was being approved; reload and retry',
          );
        }
        const { minimum, maximum, step, tag } = plan.after;
        const saved =
          plan.before === null
            ? (
                await tx<Row[]>`
                  INSERT INTO pay.withdrawal_network_rules (asset_id, network_id, minimum, maximum, step, tag, set_by)
                  VALUES (${input.assetId}, ${input.networkId}, ${minimum}, ${maximum}, ${step}, ${tag}, ${actorId})
                  RETURNING *`
              )[0]!
            : (
                await tx<Row[]>`
                  UPDATE pay.withdrawal_network_rules
                     SET minimum = ${minimum}, maximum = ${maximum}, step = ${step}, tag = ${tag}, version = version + 1,
                         set_by = ${actorId}, set_at = now()
                   WHERE asset_id = ${input.assetId} AND network_id = ${input.networkId}
                  RETURNING *`
              )[0]!;
        await tx`
          INSERT INTO pay.withdrawal_network_rule_events
            (asset_id, network_id, action, actor_id, approver_id, dual_control, before, after, reason)
          VALUES (${input.assetId}, ${input.networkId}, ${plan.before === null ? 'create' : 'update'}, ${actorId}, ${approverId},
                  ${approverId !== null}, ${plan.beforeState === null ? null : tx.json(plan.beforeState as never)},
                  ${tx.json(plan.after as never)}, ${input.reason.trim()})`;
        return viewOf(saved);
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new WithdrawalNetworkRuleError('withdrawal_network_rules.already_exists', 'the rules were created by someone else first');
      }
      throw error;
    }
  }

  private async plan(input: WithdrawalNetworkRuleSaveInput) {
    const after: State = {
      minimum: canonical('minimum', input.minimum),
      maximum: canonical('maximum', input.maximum),
      step: canonical('step', input.step),
      tag: input.tag,
    };
    const [step, minimum, maximum] = [after.step, after.minimum, after.maximum].map(parseAmount) as [Amount, Amount, Amount];
    if (minimum < step) throw new WithdrawalNetworkRuleError('withdrawal_network_rules.invalid', 'the minimum must be at least one step');
    if (maximum < minimum)
      throw new WithdrawalNetworkRuleError('withdrawal_network_rules.invalid', 'the maximum must be at least the minimum');
    // Both ends must be sendable amounts themselves, or a customer is shown a minimum every quote refuses.
    if (minimum % step !== 0n || maximum % step !== 0n) {
      throw new WithdrawalNetworkRuleError(
        'withdrawal_network_rules.invalid',
        'the minimum and the maximum must be whole numbers of steps',
      );
    }
    const [row] = await this.deps.sql<Row[]>`
      SELECT * FROM pay.withdrawal_network_rules WHERE asset_id = ${input.assetId} AND network_id = ${input.networkId}`;
    if (input.expectedVersion === null) {
      if (row) {
        throw new WithdrawalNetworkRuleError(
          'withdrawal_network_rules.already_exists',
          'the rules exist; send their current version to edit them',
        );
      }
    } else {
      if (!row) throw new WithdrawalNetworkRuleError('withdrawal_network_rules.not_found', 'no such rules to edit');
      if (row.version !== input.expectedVersion) {
        throw new WithdrawalNetworkRuleError(
          'withdrawal_network_rules.version_conflict',
          'the rules changed since you loaded them; reload and retry',
        );
      }
    }
    const beforeState = row ? stateOf(row) : null;
    return {
      before: row ?? null,
      beforeState,
      after,
      reasons: withdrawalNetworkRuleDualReasons(beforeState, after),
      fields: {
        assetId: input.assetId,
        networkId: input.networkId,
        expectedVersion: String(input.expectedVersion),
        after: JSON.stringify(after),
        reason: input.reason.trim(),
      },
    };
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw withdrawalNetworkRuleToTrpcError(error);
  }
}

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

export type WithdrawalNetworkRulesMountDeps = WithdrawalNetworkRuleServiceDeps;

/** `founderAdmin.withdrawalNetworkRules.*`: every procedure is founder-only. */
export function createWithdrawalNetworkRulesRouter(deps: WithdrawalNetworkRulesMountDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new WithdrawalNetworkRuleService({ sql: deps.sql, approvals: deps.approvals });
  return router({
    list: founder
      .input(z.object({}).strict().optional())
      .output(z.array(withdrawalNetworkRuleViewSchema))
      .query(() => wrap(() => service.list())),
    preview: founder
      .input(withdrawalNetworkRuleSaveInputSchema)
      .output(withdrawalNetworkRulePreviewSchema)
      .query(({ input }) => wrap(() => service.preview(input))),
    save: founder
      .input(withdrawalNetworkRuleSaveInputSchema)
      .output(withdrawalNetworkRuleViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.save(actorOf(ctx), input))),
    history: founder
      .input(
        z
          .object({ assetId: z.string().optional(), networkId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) })
          .strict(),
      )
      .output(z.array(withdrawalNetworkRuleEventViewSchema))
      .query(({ input }) => wrap(() => service.history(input.assetId, input.networkId, input.limit))),
  });
}
