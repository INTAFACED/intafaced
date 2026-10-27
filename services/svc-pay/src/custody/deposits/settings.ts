import { z } from 'zod';
import type { Sql } from 'postgres';
import {
  PAY_CUSTODY_DEPOSIT_UNSUPPORTED_CASE_MAX,
  PAY_CUSTODY_DEPOSIT_UNSUPPORTED_MAX,
  router,
  TRPCError,
  payAmountStringSchema,
} from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import {
  consumePayApproval,
  payActionPayloadHash,
  ActionApprovalConsumeError,
  type ActionApprovalConsumer,
} from '../../action-approval-consume.js';
import { requireDualControl, DualControlError } from '../../dual-control.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import type { FounderAuthority } from '../../founder-authority.js';
import { parseAmount } from '@intafaced/ledger-client';
import { assetCodeSchema, reasonSchema } from '../../registries/schemas.js';

/**
 * The owner's customer deposit settings (W-deposit-04): label, smallest credited deposit, the arrival time customers are told, the
 * cases custody will not credit on the network (W-deposit-03), the on/off switch with a halt note, all per asset and network. Founder-only, audited, and dual-controlled where the change loosens or
 * switches something (a second founder's identity-bound approval bound to the exact change).
 *
 * NOTHING HAS A DEFAULT. A pair with no row is not published; a new pair is created switched OFF, and switching it on is its own
 * dual-controlled change. Switching a pair off never cancels a deposit already seen: the deposit record keeps judging rows it holds
 * (a halted pair stops new addresses and new catalogue entries only).
 */

export const DEPOSIT_SETTING_ACTION = 'pay.deposit_setting_change';

export type DepositSettingErrorCode =
  | 'deposit_settings.not_found'
  | 'deposit_settings.already_exists'
  | 'deposit_settings.version_conflict'
  | 'deposit_settings.create_must_be_inert'
  | 'deposit_settings.minimum_invalid';

const KIND: Record<DepositSettingErrorCode, TRPCError['code']> = {
  'deposit_settings.not_found': 'NOT_FOUND',
  'deposit_settings.already_exists': 'CONFLICT',
  'deposit_settings.version_conflict': 'CONFLICT',
  'deposit_settings.create_must_be_inert': 'BAD_REQUEST',
  'deposit_settings.minimum_invalid': 'BAD_REQUEST',
};

export class DepositSettingError extends Error {
  constructor(
    readonly code: DepositSettingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DepositSettingError';
  }
}

const networkIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const labelSchema = z.string().trim().min(1).max(64);
const haltNoteSchema = z.string().trim().min(1).max(280);
/** One case custody will not credit on this network, as the owner writes it for customers. */
const unsupportedCaseSchema = z.string().trim().min(1).max(PAY_CUSTODY_DEPOSIT_UNSUPPORTED_CASE_MAX);
const versionSchema = z.number().int().min(1).max(2_147_483_647);

export const depositSettingSaveInputSchema = z
  .object({
    assetId: assetCodeSchema,
    networkId: networkIdSchema,
    label: labelSchema,
    /** The smallest deposit that is credited. A decimal string above zero; never blank. */
    minimumDeposit: payAmountStringSchema,
    estimatedArrivalMinutes: z.number().int().min(1).max(100_000),
    /**
     * The cases custody will not credit on this network, shown to customers before any address. Absent keeps the list the pair
     * has (none for a new pair); an empty list publishes none.
     */
    unsupportedCases: z
      .array(unsupportedCaseSchema)
      .max(PAY_CUSTODY_DEPOSIT_UNSUPPORTED_MAX)
      .refine((cases) => new Set(cases).size === cases.length, 'each unsupported case once')
      .optional(),
    enabled: z.boolean(),
    /** Shown to customers while the pair is off. Null means the standard "switched off" line only. */
    haltNote: haltNoteSchema.nullable(),
    /** null creates the pair; otherwise the version this edit is based on. */
    expectedVersion: versionSchema.nullable(),
    reason: reasonSchema,
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();
export type DepositSettingSaveInput = z.infer<typeof depositSettingSaveInputSchema>;

export const depositSettingViewSchema = z
  .object({
    assetId: z.string(),
    networkId: z.string(),
    label: z.string(),
    minimumDeposit: z.string(),
    estimatedArrivalMinutes: z.number().int(),
    unsupportedCases: z.array(z.string()),
    enabled: z.boolean(),
    haltNote: z.string().nullable(),
    version: z.number().int(),
    setBy: z.string(),
    setAt: z.string(),
  })
  .strict();
export type DepositSettingView = z.infer<typeof depositSettingViewSchema>;

export const depositSettingPreviewSchema = z
  .object({ needsDualControl: z.boolean(), reasons: z.array(z.string()), actionType: z.string(), payloadHash: z.string() })
  .strict();

export const depositSettingEventViewSchema = z
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
  label: string;
  minimum_deposit: string;
  estimated_arrival_minutes: number;
  unsupported_cases: string[];
  enabled: boolean;
  halt_note: string | null;
  version: number;
  set_by: string;
  set_at: Date;
}

type State = Pick<DepositSettingView, 'label' | 'minimumDeposit' | 'estimatedArrivalMinutes' | 'unsupportedCases' | 'enabled' | 'haltNote'>;

const stateOf = (row: Row): State => ({
  label: row.label,
  minimumDeposit: row.minimum_deposit,
  estimatedArrivalMinutes: row.estimated_arrival_minutes,
  unsupportedCases: row.unsupported_cases,
  enabled: row.enabled,
  haltNote: row.halt_note,
});
const viewOf = (row: Row): DepositSettingView => ({
  assetId: row.asset_id,
  networkId: row.network_id,
  ...stateOf(row),
  version: row.version,
  setBy: row.set_by,
  setAt: row.set_at.toISOString(),
});

/** Canonical decimal so "10" and "10.0" bind to the same approval. */
function canonical(minimum: string): string {
  let parsed: bigint;
  try {
    parsed = parseAmount(minimum);
  } catch {
    throw new DepositSettingError('deposit_settings.minimum_invalid', 'the minimum is not an exact decimal this ledger can hold');
  }
  if (parsed <= 0n) throw new DepositSettingError('deposit_settings.minimum_invalid', 'the minimum must be above zero');
  const trimmed = minimum.includes('.') ? minimum.replace(/0+$/, '').replace(/\.$/, '') : minimum;
  return trimmed.replace(/^0+(?=\d)/, '');
}

/**
 * What needs a second founder: switching a pair on or off, or, on a pair that is on, lowering the minimum or taking any case's exact
 * words off the unsupported list (customers stop being warned in those words; a rewording counts too). Adding a case needs one
 * founder. A new pair is created off.
 */
export function depositSettingDualReasons(before: State | null, after: State): string[] {
  if (before === null) return [];
  const reasons: string[] = [];
  if (before.enabled !== after.enabled) reasons.push(after.enabled ? 'enabled' : 'disabled');
  if (before.enabled && after.enabled && parseAmount(after.minimumDeposit) < parseAmount(before.minimumDeposit)) {
    reasons.push('minimum_lowered');
  }
  if (before.enabled && after.enabled && before.unsupportedCases.some((item) => !after.unsupportedCases.includes(item))) {
    reasons.push('unsupported_case_removed');
  }
  return reasons;
}

export interface DepositSettingServiceDeps {
  readonly sql: Sql;
  readonly approvals: ActionApprovalConsumer;
}

export class DepositSettingService {
  constructor(private readonly deps: DepositSettingServiceDeps) {}

  async list(): Promise<DepositSettingView[]> {
    const rows = await this.deps.sql<Row[]>`SELECT * FROM pay.custody_deposit_settings ORDER BY asset_id, network_id`;
    return rows.map(viewOf);
  }

  async history(assetId: string | undefined, networkId: string | undefined, limit: number) {
    const { sql } = this.deps;
    const rows = await sql<
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
        FROM pay.custody_deposit_setting_events
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

  async preview(input: DepositSettingSaveInput) {
    const plan = await this.plan(input);
    return {
      needsDualControl: plan.reasons.length > 0,
      reasons: plan.reasons,
      actionType: DEPOSIT_SETTING_ACTION,
      payloadHash: payActionPayloadHash(DEPOSIT_SETTING_ACTION, plan.fields),
    };
  }

  async save(actorId: string, input: DepositSettingSaveInput): Promise<DepositSettingView> {
    const plan = await this.plan(input);
    let approverId: string | null = null;
    if (plan.reasons.length > 0) {
      const approver = await consumePayApproval(this.deps.approvals, input, DEPOSIT_SETTING_ACTION, plan.fields);
      approverId = requireDualControl(actorId.toLowerCase(), approver.trim().toLowerCase());
    }
    const { sql } = this.deps;
    try {
      return await transaction(sql, async (tx) => {
        const current = (
          await tx<
            Row[]
          >`SELECT * FROM pay.custody_deposit_settings WHERE asset_id = ${input.assetId} AND network_id = ${input.networkId} FOR UPDATE`
        )[0];
        if (plan.before === null ? current !== undefined : current === undefined || current.version !== plan.before.version) {
          throw new DepositSettingError(
            'deposit_settings.version_conflict',
            'the setting changed while the change was being approved; reload and retry',
          );
        }
        const saved =
          plan.before === null
            ? (
                await tx<Row[]>`
                  INSERT INTO pay.custody_deposit_settings
                    (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, unsupported_cases, enabled, halt_note,
                     set_by)
                  VALUES (${input.assetId}, ${input.networkId}, ${plan.after.label}, ${plan.after.minimumDeposit},
                          ${plan.after.estimatedArrivalMinutes}, ${tx.array(plan.after.unsupportedCases)}::text[], ${plan.after.enabled},
                          ${plan.after.haltNote}, ${actorId})
                  RETURNING *`
              )[0]!
            : (
                await tx<Row[]>`
                  UPDATE pay.custody_deposit_settings
                     SET label = ${plan.after.label}, minimum_deposit = ${plan.after.minimumDeposit},
                         estimated_arrival_minutes = ${plan.after.estimatedArrivalMinutes},
                         unsupported_cases = ${tx.array(plan.after.unsupportedCases)}::text[], enabled = ${plan.after.enabled},
                         halt_note = ${plan.after.haltNote}, version = version + 1, set_by = ${actorId}, set_at = now()
                   WHERE asset_id = ${input.assetId} AND network_id = ${input.networkId}
                  RETURNING *`
              )[0]!;
        await tx`
          INSERT INTO pay.custody_deposit_setting_events (asset_id, network_id, action, actor_id, approver_id, dual_control, before, after, reason)
          VALUES (${input.assetId}, ${input.networkId}, ${plan.before === null ? 'create' : 'update'}, ${actorId}, ${approverId},
                  ${approverId !== null}, ${plan.beforeState === null ? null : tx.json(plan.beforeState as never)},
                  ${tx.json(plan.after as never)}, ${input.reason})`;
        return viewOf(saved);
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new DepositSettingError('deposit_settings.already_exists', 'the setting was created by someone else first');
      }
      throw error;
    }
  }

  private async plan(input: DepositSettingSaveInput) {
    const minimumDeposit = canonical(input.minimumDeposit);
    const row = (
      await this.deps.sql<
        Row[]
      >`SELECT * FROM pay.custody_deposit_settings WHERE asset_id = ${input.assetId} AND network_id = ${input.networkId}`
    )[0];
    const after: State = {
      label: input.label,
      minimumDeposit,
      estimatedArrivalMinutes: input.estimatedArrivalMinutes,
      // Absent keeps what the pair has, so an edit made without the list never drops a warning customers are shown.
      unsupportedCases: input.unsupportedCases ?? row?.unsupported_cases ?? [],
      enabled: input.enabled,
      haltNote: input.enabled ? null : input.haltNote,
    };
    if (input.expectedVersion === null) {
      if (row) throw new DepositSettingError('deposit_settings.already_exists', 'the setting exists; send its current version to edit it');
      if (after.enabled) {
        throw new DepositSettingError(
          'deposit_settings.create_must_be_inert',
          'create the pair switched off, then switch it on as a separate, dual-controlled change',
        );
      }
    } else {
      if (!row) throw new DepositSettingError('deposit_settings.not_found', 'no such setting to edit');
      if (row.version !== input.expectedVersion) {
        throw new DepositSettingError('deposit_settings.version_conflict', 'the setting changed since you loaded it; reload and retry');
      }
    }
    const beforeState = row ? stateOf(row) : null;
    return {
      before: row ?? null,
      beforeState,
      after,
      reasons: depositSettingDualReasons(beforeState, after),
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

function toTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof DepositSettingError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  if (error instanceof DualControlError || error instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
  }
  return error;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toTrpcError(error);
  }
}

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

export interface DepositSettingsMountDeps {
  readonly sql: Sql;
  readonly approvals: ActionApprovalConsumer;
}

/** `founderAdmin.depositSettings.*`: every procedure is founder-only. */
export function createDepositSettingsRouter(deps: DepositSettingsMountDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new DepositSettingService({ sql: deps.sql, approvals: deps.approvals });
  return router({
    list: founder
      .input(z.object({}).strict().optional())
      .output(z.array(depositSettingViewSchema))
      .query(() => wrap(() => service.list())),
    preview: founder
      .input(depositSettingSaveInputSchema)
      .output(depositSettingPreviewSchema)
      .query(({ input }) => wrap(() => service.preview(input))),
    save: founder
      .input(depositSettingSaveInputSchema)
      .output(depositSettingViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.save(actorOf(ctx), input))),
    history: founder
      .input(
        z
          .object({ assetId: z.string().optional(), networkId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) })
          .strict(),
      )
      .output(z.array(depositSettingEventViewSchema))
      .query(({ input }) => wrap(() => service.history(input.assetId, input.networkId, input.limit))),
  });
}
