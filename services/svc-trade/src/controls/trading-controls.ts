import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import {
  accountControlInputSchema,
  accountControlResultSchema,
  committedOperationAdmissionSchema,
  accountControlLookupInputSchema,
  accountControlHistoryInputSchema,
  currentAuthorityInputSchema,
  identityOperationDecisionSchema,
  identityOperationIntentSchema,
  type AccountControlInput,
  type AccountControlResult,
  type AccountControlState,
  type Context,
  type CommittedOperationAdmission,
  type IdentityOperationDecision,
  type IdentityOperationDecisionPort,
  type IdentityOperationIntent,
} from '@intafaced/contracts';

export class TradingControlError extends Error {
  constructor(
    readonly code:
      | 'authority.unavailable'
      | 'trade.account_restricted'
      | 'operation.conflict'
      | 'auth.credential_denied'
      | 'auth.account_frozen'
      | 'operator.denied',
    message: string = code,
  ) {
    super(message);
    this.name = 'TradingControlError';
  }
}

/** Query-time interactive founder validation, not a cache or operation grant. */
export interface LiveTradingOperatorPort {
  check(context: Context & { principal: Principal }): Promise<'enabled' | 'denied' | 'unavailable'>;
}
export type TradingOperationKind = Extract<IdentityOperationIntent['operation'], { service: 'svc-trade' }>['kind'];
export interface TradingAdmissionPort {
  admit(
    principal: Principal,
    kind: TradingOperationKind,
    businessId: string,
    payload: unknown,
    delegation?: { parentBusinessId: string; parentGrantId: string },
    subAccountId?: string,
  ): Promise<CommittedOperationAdmission>;
  original(
    userId: string,
    businessId: string,
  ): Promise<{ payload: unknown; admission: CommittedOperationAdmission | null; grantId: string | null } | null>;
  resolve(
    userId: string,
    businessId: string,
  ): Promise<{ payload: unknown; admission: CommittedOperationAdmission; grantId: string } | null>;
}

/** Canonical wire payload; scaled money must have been formatted by its owner. */
export function canonicalPayload(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalPayload).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => {
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        })
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalPayload(v))
        .join(',') +
      '}'
    );
  }
  throw new TradingControlError('operation.conflict', 'Operation payload must be immutable JSON');
}
const hash = (value: unknown): string => 'sha256:' + createHash('sha256').update(canonicalPayload(value)).digest('hex');
type IntentRow = {
  intent: IdentityOperationIntent;
  payload: unknown;
  decision: IdentityOperationDecision | null;
  admission: CommittedOperationAdmission | null;
};

/** One local guard covers preparation, grant/finalization, and restriction/drain. */
async function guard(tx: Sql, userId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`trade.account-controls:${userId}`}, 0))`;
}

export class TradingControls implements TradingAdmissionPort {
  constructor(
    private readonly sql: Sql,
    private readonly operators: LiveTradingOperatorPort | null,
    private readonly identity: IdentityOperationDecisionPort | null,
  ) {}

  private state(userId: string, row?: { restricted: boolean; version: string }): AccountControlState {
    return { target: { area: 'trading', userId }, restricted: row?.restricted ?? false, version: row?.version ?? '0' };
  }
  private async loadState(tx: Sql, userId: string): Promise<AccountControlState> {
    const [row] = await tx<Array<{ restricted: boolean; version: string }>>`
      SELECT restricted, version::text FROM trade.account_restrictions WHERE user_id = ${userId}`;
    return this.state(userId, row);
  }
  private async operator(context: Context & { principal: Principal }): Promise<'enabled' | 'denied' | 'unavailable'> {
    if (!this.operators) return 'unavailable';
    if (
      context.service !== null ||
      context.principal.kid ||
      context.principal.sub_account ||
      !context.principal.mfa ||
      context.principal.expiresAt.getTime() <= Date.now()
    )
      return 'denied';
    try {
      return await this.operators.check(context);
    } catch {
      return 'unavailable';
    }
  }
  private target(input: { target: AccountControlState['target'] }): string {
    if (input.target.area !== 'trading') throw new TradingControlError('operation.conflict', 'svc-trade only owns trading controls');
    return input.target.userId.toLowerCase();
  }
  async getState(
    context: Context & { principal: Principal },
    input: { target: AccountControlState['target'] },
  ): Promise<AccountControlState> {
    input = accountControlLookupInputSchema.parse(input);
    const userId = this.target(input);
    const authority = await this.operator(context);
    if (authority !== 'enabled') throw new TradingControlError(authority === 'denied' ? 'operator.denied' : 'authority.unavailable');
    return this.loadState(this.sql, userId);
  }
  async history(
    context: Context & { principal: Principal },
    input: { target: AccountControlState['target']; limit: number },
  ): Promise<AccountControlResult[]> {
    input = accountControlHistoryInputSchema.parse(input);
    const userId = this.target(input);
    const authority = await this.operator(context);
    if (authority !== 'enabled') throw new TradingControlError(authority === 'denied' ? 'operator.denied' : 'authority.unavailable');
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) throw new TradingControlError('operation.conflict');
    const rows = await this.sql<Array<{ result: unknown }>>`SELECT result FROM trade.account_control_history
      WHERE target_user_id = ${userId} ORDER BY occurred_at DESC, audit_id DESC LIMIT ${input.limit}`;
    return rows.map((row) => accountControlResultSchema.parse(row.result));
  }
  async change(context: Context & { principal: Principal }, raw: AccountControlInput): Promise<AccountControlResult> {
    const parsed = accountControlInputSchema.parse(raw);
    const userId = this.target(parsed);
    const input = { ...parsed, requestId: parsed.requestId.toLowerCase(), target: { area: 'trading' as const, userId } };
    const fingerprint = hash({ ...input, actorUserId: context.principal.userId });
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await guard(tx, userId);
          // Reauthenticate every retry after acquiring the owner guard.
          const authority = await this.operator(context);
          const base = {
            auditId: randomUUID(),
            requestId: input.requestId,
            target: input.target,
            action: input.action,
            reason: input.reason,
            occurredAt: new Date().toISOString(),
            actorUserId: context.principal.userId,
            changed: false as const,
          };
          let result: AccountControlResult;
          if (authority !== 'enabled') {
            let code: 'operator.denied' | 'mfa.required' | 'authority.unavailable' = 'authority.unavailable';
            if (authority === 'denied') {
              code = 'operator.denied';
              if (!context.principal.mfa) code = 'mfa.required';
            }
            result = {
              ...base,
              outcome: 'refused',
              code,
              current: null,
            };
          } else {
            // Globally serialize the request key as well as its target.
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`trade.account-controls.request:${input.requestId}`}, 0))`;
            const [prior] = await tx<Array<{ fingerprint: string; result: unknown }>>`
            SELECT fingerprint, result FROM trade.account_control_requests WHERE request_id = ${input.requestId}`;
            if (prior?.fingerprint === fingerprint) return accountControlResultSchema.parse(prior.result);
            const before = await this.loadState(tx, userId);
            if (prior) result = { ...base, outcome: 'refused', code: 'request.conflict', current: before };
            else if (before.version !== input.expectedVersion)
              result = { ...base, outcome: 'conflict', code: 'restriction.version_conflict', current: before };
            else if (input.action === 'restrict' && !(await this.drain(tx, userId))) {
              result = { ...base, outcome: 'refused', code: 'authority.unavailable', current: before };
            } else {
              const restricted = input.action === 'restrict';
              const changed = before.restricted !== restricted;
              const after = { ...before, restricted, version: changed ? (BigInt(before.version) + 1n).toString() : before.version };
              await tx`INSERT INTO trade.account_restrictions(user_id, restricted, version)
              VALUES (${userId}, ${restricted}, ${after.version}::bigint)
              ON CONFLICT (user_id) DO UPDATE SET restricted = EXCLUDED.restricted, version = EXCLUDED.version`;
              result = changed
                ? { ...base, outcome: 'changed', changed: true, before, after }
                : { ...base, outcome: 'noop', before, after };
            }
            // A dependency refusal can be retried with the same request after recovery.
            if (!prior && !(result.outcome === 'refused' && result.code === 'authority.unavailable')) {
              await tx`INSERT INTO trade.account_control_requests(request_id, fingerprint, result)
              VALUES (${input.requestId}, ${fingerprint}, ${tx.json(result)}::jsonb)`;
            }
          }
          result = accountControlResultSchema.parse(result);
          await tx`INSERT INTO trade.account_control_history(audit_id, request_id, target_user_id, result, occurred_at)
          VALUES (${result.auditId}, ${input.requestId}, ${userId}, ${tx.json(result)}::jsonb, ${result.occurredAt})`;
          return result;
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof TradingControlError) throw error;
      throw new TradingControlError('authority.unavailable', 'Trading controls persistence is unavailable');
    }
  }

  async admit(
    principal: Principal,
    kind: TradingOperationKind,
    businessId: string,
    payload: unknown,
    delegation?: { parentBusinessId: string; parentGrantId: string },
    subAccountId?: string,
  ): Promise<CommittedOperationAdmission> {
    const userId = principal.userId.toLowerCase();
    const wire = canonicalPayload(payload);
    const payloadHash = hash(payload);
    const operation = { service: 'svc-trade' as const, kind, userId };
    try {
      // Phase one commits immutable intent AND request marker before any grant.
      const prepared = await transaction(
        this.sql,
        async (tx) => {
          await guard(tx, userId);
          const [old] = await tx<IntentRow[]>`SELECT intent, payload, decision, admission FROM trade.operation_intents
          WHERE user_id = ${userId} AND business_id = ${businessId}`;
          if (old) {
            if (old.intent.payloadHash !== payloadHash || canonicalPayload(old.intent.operation) !== canonicalPayload(operation))
              throw new TradingControlError('operation.conflict');
            return old;
          }
          if (!this.identity) throw new TradingControlError('authority.unavailable');
          if ((await this.loadState(tx, userId)).restricted) throw new TradingControlError('trade.account_restricted');
          let authority: IdentityOperationIntent['authority'];
          if (delegation) {
            const [parent] = await tx<IntentRow[]>`SELECT intent, payload, decision, admission FROM trade.operation_intents
            WHERE user_id = ${userId} AND business_id = ${delegation.parentBusinessId}`;
            if (
              !parent?.admission ||
              parent.decision?.status !== 'granted' ||
              parent.decision.grantId !== delegation.parentGrantId ||
              parent.intent.operation.kind !== 'strategy.start'
            )
              throw new TradingControlError('auth.credential_denied');
            authority = { kind: 'delegation', parentGrantId: delegation.parentGrantId };
          } else {
            if (principal.expiresAt.getTime() <= Date.now() || !principal.scopes.includes('trade:write'))
              throw new TradingControlError('auth.credential_denied');
            if (principal.sub_account && subAccountId && principal.sub_account.toLowerCase() !== subAccountId.toLowerCase())
              throw new TradingControlError('auth.credential_denied');
            const sub = subAccountId ?? principal.sub_account;
            authority = {
              kind: 'credential',
              subject: currentAuthorityInputSchema.parse({
                userId,
                credential: principal.kid
                  ? { kind: 'api_key', apiKeyId: principal.kid.toLowerCase() }
                  : { kind: 'session', sessionId: principal.sid.toLowerCase() },
                ...(sub ? { subAccountId: sub.toLowerCase() } : {}),
              }),
            };
          }
          const intent = identityOperationIntentSchema.parse({ operation, businessId, payloadHash, authority });
          await tx`INSERT INTO trade.operation_intents(user_id, business_id, intent, payload, identity_requested)
          VALUES (${userId}, ${businessId}, ${tx.json(intent)}::jsonb, ${tx.json(JSON.parse(wire))}::jsonb, true)`;
          return { intent, payload: JSON.parse(wire) as unknown, decision: null, admission: null };
        },
        { isolation: 'read committed' },
      );
      if (prepared.admission) return committedOperationAdmissionSchema.parse(prepared.admission);
      // Reacquire the SAME guard. Restriction in the gap drains the marker first.
      const resolved = await transaction(
        this.sql,
        async (tx) => {
          await guard(tx, userId);
          const [row] = await tx<IntentRow[]>`SELECT intent, payload, decision, admission FROM trade.operation_intents
          WHERE user_id = ${userId} AND business_id = ${businessId}`;
          if (!row) throw new TradingControlError('authority.unavailable');
          if (row.admission) return { admission: committedOperationAdmissionSchema.parse(row.admission), refusal: null };
          const restricted = (await this.loadState(tx, userId)).restricted;
          const decision = row.decision ?? (await this.decide(row.intent, restricted ? 'resolve_or_cancel' : 'grant'));
          const admission = await this.finalize(tx, row.intent, decision);
          // A known cancellation is terminal owner evidence. Commit it before refusing
          // the caller, so restart/retry cannot turn the same intent into a new grant.
          let refusal: 'auth.account_frozen' | 'trade.account_restricted' | 'auth.credential_denied' = 'auth.credential_denied';
          if (decision.status === 'cancelled' && decision.code === 'auth.account_frozen') refusal = 'auth.account_frozen';
          else if (restricted) refusal = 'trade.account_restricted';
          return { admission, refusal };
        },
        { isolation: 'read committed' },
      );
      if (!resolved.admission) throw new TradingControlError(resolved.refusal ?? 'auth.credential_denied');
      return resolved.admission;
    } catch (error) {
      if (error instanceof TradingControlError) throw error;
      throw new TradingControlError('authority.unavailable', 'Trading admission persistence is unavailable');
    }
  }
  private async decide(intent: IdentityOperationIntent, mode: 'grant' | 'resolve_or_cancel'): Promise<IdentityOperationDecision> {
    if (!this.identity) throw new TradingControlError('authority.unavailable');
    const result = identityOperationDecisionSchema.parse(await this.identity.decide({ mode, intent }));
    if (result.status === 'unavailable') throw new TradingControlError('authority.unavailable');
    if (result.status === 'conflict') throw new TradingControlError('operation.conflict');
    if (canonicalPayload(result.intent) !== canonicalPayload(intent)) throw new TradingControlError('operation.conflict');
    return result;
  }
  private async finalize(
    tx: Sql,
    intent: IdentityOperationIntent,
    decision: IdentityOperationDecision,
  ): Promise<CommittedOperationAdmission | null> {
    if (decision.status !== 'granted' && decision.status !== 'cancelled') throw new TradingControlError('authority.unavailable');
    const state = await this.loadState(tx, intent.operation.userId);
    const admission =
      decision.status === 'granted'
        ? committedOperationAdmissionSchema.parse({
            operation: intent.operation,
            businessId: intent.businessId,
            payloadHash: intent.payloadHash,
            status: 'committed',
            admissionId: decision.grantId,
            admittedAt: decision.decidedAt,
            identityVersion: decision.identityVersion,
            restrictionVersion: state.version,
          })
        : null;
    await tx`UPDATE trade.operation_intents SET decision = ${tx.json(decision)}::jsonb,
      admission = ${admission ? tx.json(admission) : null}::jsonb
      WHERE user_id = ${intent.operation.userId} AND business_id = ${intent.businessId}`;
    return admission;
  }
  private async drain(tx: Sql, userId: string): Promise<boolean> {
    const pending = await tx<IntentRow[]>`SELECT intent, payload, decision, admission FROM trade.operation_intents
      WHERE user_id = ${userId} AND identity_requested AND decision IS NULL ORDER BY business_id`;
    try {
      for (const row of pending) await this.finalize(tx, row.intent, await this.decide(row.intent, 'resolve_or_cancel'));
      return true;
    } catch {
      return false;
    }
  }
  /** Internal recovery loads original owner evidence; it never accepts public receipts. */
  async resolve(
    userId: string,
    businessId: string,
  ): Promise<{ payload: unknown; admission: CommittedOperationAdmission; grantId: string } | null> {
    userId = userId.toLowerCase();
    return transaction(
      this.sql,
      async (tx) => {
        await guard(tx, userId);
        const [row] = await tx<IntentRow[]>`SELECT intent, payload, decision, admission FROM trade.operation_intents
        WHERE user_id = ${userId} AND business_id = ${businessId}`;
        if (!row) return null;
        const decision = row.decision ?? (await this.decide(row.intent, 'resolve_or_cancel'));
        const admission = row.admission ?? (await this.finalize(tx, row.intent, decision));
        if (!admission || decision.status !== 'granted') return null;
        return { payload: row.payload, admission, grantId: decision.grantId };
      },
      { isolation: 'read committed' },
    );
  }
  async original(
    userId: string,
    businessId: string,
  ): Promise<{ payload: unknown; admission: CommittedOperationAdmission | null; grantId: string | null } | null> {
    try {
      const [row] = await this.sql<IntentRow[]>`SELECT intent, payload, decision, admission FROM trade.operation_intents
      WHERE user_id = ${userId.toLowerCase()} AND business_id = ${businessId}`;
      if (!row) return null;
      return {
        payload: row.payload,
        admission: row.admission ? committedOperationAdmissionSchema.parse(row.admission) : null,
        grantId: row.decision?.status === 'granted' ? row.decision.grantId : null,
      };
    } catch {
      throw new TradingControlError('authority.unavailable', 'Trading admission persistence is unavailable');
    }
  }
  async recover(
    userId: string,
    businessId: string,
  ): Promise<{ payload: unknown; admission: CommittedOperationAdmission; grantId: string } | null> {
    const [row] = await this.sql<IntentRow[]>`SELECT intent, payload, decision, admission FROM trade.operation_intents
      WHERE user_id = ${userId.toLowerCase()} AND business_id = ${businessId}`;
    if (!row?.admission || row.decision?.status !== 'granted') return null;
    return { payload: row.payload, admission: committedOperationAdmissionSchema.parse(row.admission), grantId: row.decision.grantId };
  }
}
