import { createHash, randomUUID } from 'node:crypto';
import { pendingIdentityIntentCount } from './payment-admission.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  accountControlInputSchema,
  accountControlResultSchema,
  accountControlStateSchema,
  type AccountControlInput,
  type AccountControlResult,
  type AccountControlState,
  type Context,
} from '@intafaced/contracts';

export type FounderAuthority = (ctx: Context) => Promise<string>;
export type PendingIdentityIntentDrain = (tx: Sql, merchantId: string) => Promise<void>;
export class MerchantControlError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function canonical(input: AccountControlInput): string {
  return JSON.stringify({
    requestId: input.requestId,
    target: input.target,
    action: input.action,
    reason: input.reason,
    expectedVersion: input.expectedVersion,
  });
}
export class MerchantAccountControls {
  constructor(
    private readonly sql: Sql,
    private readonly authority: FounderAuthority,
    private readonly drain?: PendingIdentityIntentDrain,
  ) {}
  private async operator(ctx: Context): Promise<string> {
    if (ctx.service || !ctx.principal) throw new MerchantControlError('operator.denied');
    if (!ctx.principal.mfa) throw new MerchantControlError('mfa.required');
    if (ctx.principal.kid || ctx.principal.sub_account || ctx.principal.expiresAt.getTime() <= Date.now())
      throw new MerchantControlError('operator.denied');
    const actor = await this.authority(ctx);
    if (actor.toLowerCase() !== ctx.principal.userId.toLowerCase()) throw new MerchantControlError('operator.denied');
    return actor.toLowerCase();
  }
  private state(
    merchantId: string,
    row: { operations_control_version: unknown; operations_restricted: unknown; status: unknown },
  ): AccountControlState {
    return accountControlStateSchema.parse({
      target: { area: 'merchant', merchantId },
      version: String(row.operations_control_version),
      restricted: Boolean(row.operations_restricted) || row.status === 'suspended' || row.status === 'closed',
    });
  }
  async getState(ctx: Context, input: { target: AccountControlInput['target'] }): Promise<AccountControlState | null> {
    await this.operator(ctx);
    if (input.target.area !== 'merchant') throw new MerchantControlError('target.not_found');
    const rows = await this
      .sql`SELECT status,operations_control_version,operations_restricted FROM pay.merchants WHERE id=${input.target.merchantId}`;
    return rows[0]
      ? this.state(
          input.target.merchantId,
          rows[0] as { operations_control_version: unknown; operations_restricted: unknown; status: unknown },
        )
      : null;
  }
  async history(ctx: Context, input: { target: AccountControlInput['target']; limit: number }): Promise<AccountControlResult[]> {
    await this.operator(ctx);
    if (input.target.area !== 'merchant') throw new MerchantControlError('target.not_found');
    const rows = await this
      .sql`SELECT result FROM pay.account_control_audit WHERE merchant_id=${input.target.merchantId} ORDER BY sequence DESC LIMIT ${input.limit}`;
    return rows.map((row) => accountControlResultSchema.parse(row.result));
  }
  async change(ctx: Context, raw: AccountControlInput): Promise<AccountControlResult> {
    const parsed = accountControlInputSchema.parse(raw);
    const input = {
      ...parsed,
      requestId: parsed.requestId.toLowerCase(),
      target: parsed.target.area === 'merchant' ? { ...parsed.target, merchantId: parsed.target.merchantId.toLowerCase() } : parsed.target,
    };
    if (input.target.area !== 'merchant') throw new MerchantControlError('target.not_found');
    const merchantId = input.target.merchantId;
    let actor: string | null = ctx.principal?.userId.toLowerCase() ?? null;
    let denial: Extract<AccountControlResult, { outcome: 'refused' }>['code'] | null = null;
    try {
      actor = await this.operator(ctx);
    } catch (error) {
      denial =
        error instanceof MerchantControlError && (error.code === 'operator.denied' || error.code === 'mfa.required')
          ? error.code
          : 'authority.unavailable';
    }
    const fingerprint = createHash('sha256').update(canonical(input)).digest('hex');
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('pay.control:'||${input.requestId}))`;
        const base = {
          auditId: randomUUID(),
          requestId: input.requestId,
          target: input.target,
          action: input.action,
          reason: input.reason,
          occurredAt: new Date().toISOString(),
        };
        const record = async (rawResult: unknown, replay: boolean): Promise<AccountControlResult> => {
          const result = accountControlResultSchema.parse(rawResult);
          await tx`INSERT INTO pay.account_control_audit(id,request_id,actor_user_id,merchant_id,fingerprint,result) VALUES(${result.auditId},${input.requestId},${actor},${merchantId},${fingerprint},${tx.json(result)})`;
          if (replay)
            await tx`INSERT INTO pay.account_control_requests(request_id,actor_key,fingerprint,result) VALUES(${input.requestId},${actor ?? 'anonymous'},${fingerprint},${tx.json(result)})`;
          return result;
        };
        if (denial) return record({ ...base, outcome: 'refused', changed: false, actorUserId: actor, code: denial, current: null }, false);
        const previous = await tx`SELECT * FROM pay.account_control_requests WHERE request_id=${input.requestId}`;
        if (previous[0]) {
          if (previous[0].actor_key === actor && previous[0].fingerprint === fingerprint)
            return accountControlResultSchema.parse(previous[0].result);
          return record(
            { ...base, outcome: 'refused', changed: false, actorUserId: actor, code: 'request.conflict', current: null },
            false,
          );
        }
        const rows =
          await tx`SELECT status,operations_control_version,operations_restricted,operations_restore_status FROM pay.merchants WHERE id=${merchantId} FOR UPDATE`;
        const row = rows[0];
        if (!row)
          return record({ ...base, outcome: 'refused', changed: false, actorUserId: actor, code: 'target.not_found', current: null }, true);
        const before = this.state(
          merchantId,
          row as { operations_control_version: unknown; operations_restricted: unknown; status: unknown },
        );
        if (input.expectedVersion !== before.version)
          return record(
            { ...base, outcome: 'conflict', changed: false, actorUserId: actor, code: 'restriction.version_conflict', current: before },
            true,
          );
        const restricting = input.action === 'restrict';
        if (!restricting && before.restricted && (row.status === 'closed' || row.operations_restore_status === null))
          return record(
            { ...base, outcome: 'refused', changed: false, actorUserId: actor, code: 'restore.not_permitted', current: before },
            true,
          );
        if (before.restricted === restricting)
          return record({ ...base, outcome: 'noop', changed: false, actorUserId: actor, before, after: before }, true);
        if (restricting) {
          const pending = await pendingIdentityIntentCount(tx, merchantId);
          if (pending) {
            if (!this.drain)
              return record(
                { ...base, outcome: 'refused', changed: false, actorUserId: actor, code: 'authority.unavailable', current: before },
                true,
              );
            try {
              await this.drain(tx, merchantId);
              if (await pendingIdentityIntentCount(tx, merchantId)) throw new MerchantControlError('authority.unavailable');
            } catch {
              return record(
                { ...base, outcome: 'refused', changed: false, actorUserId: actor, code: 'authority.unavailable', current: before },
                true,
              );
            }
          }
        }
        const status = restricting ? 'suspended' : String(row.operations_restore_status);
        const version = (BigInt(before.version) + 1n).toString();
        await tx`UPDATE pay.merchants SET status=${status}::pay.merchant_status,operations_restricted=${restricting},operations_control_version=${version},operations_restore_status=${restricting ? String(row.status) : null}::pay.merchant_status,updated_at=now() WHERE id=${merchantId}`;
        await tx`INSERT INTO pay.merchant_status_events(merchant_id,from_status,to_status,reason,actor_id,actor_scope) VALUES(${merchantId},${String(row.status)}::pay.merchant_status,${status}::pay.merchant_status,${input.reason},${actor},'identity.operator_entitlement')`;
        return record(
          {
            ...base,
            outcome: 'changed',
            changed: true,
            actorUserId: actor,
            before,
            after: { ...before, version, restricted: restricting },
          },
          true,
        );
      },
      { isolation: 'read committed' },
    );
  }
}
