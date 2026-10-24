import { z } from 'zod';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  PAY_DEPOSIT_TRAVEL_RULE_STATES,
  PAY_DEPOSIT_WALLET_TYPES,
  PAY_TRAVEL_RULE_FIELDS,
  payDepositTravelRuleDeclareInputSchema,
  payDepositTravelRuleViewSchema,
  router,
  scopedProcedure,
  TRPCError,
  type PayDepositTravelRuleDeclareInput,
  type PayDepositTravelRuleState,
  type PayDepositTravelRuleView,
  type PayTravelRuleField,
} from '@intafaced/contracts';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import type { FounderAuthority } from '../../founder-authority.js';
import { reasonSchema } from '../../registries/schemas.js';
import type { MessageCipher } from '../../travel-rule/cipher.js';

/**
 * The inbound travel rule on customer crypto deposits (W-deposit-07, W-compliance-notices-05; J-wallet-03 #1-#3).
 *
 * NOTHING HERE POSTS. The owner sets, per asset, whether the rule applies to an inbound deposit, its threshold and the fields
 * to collect (`rules.set`, appended; the latest row per asset is the rule). The deposit book (`book.ts`) holds a deposit at or
 * above the threshold (`held_travel_rule`) and opens its record; with no rule for the asset a due deposit is not credited at all
 * (`travel_rule_unset`). The depositor then declares the sending wallet and the asked fields (`custodyDeposit.travelRule.declare`):
 * the values are sealed with the travel-rule key bound to the deposit id and never sent back; with no key nothing is stored
 * (`travel_rule.cipher_unwired`). Compliance may wait on the counterparty (`markCounterpartyPending`, the owner's pending wait
 * limit; blank refuses); a wait that runs out is `blocking_time_expired` and the deposit STAYS HELD: a timer never releases.
 * A founder releases a declared deposit (`release`), and the book credits it once under its usual `deposit` key.
 *
 * The counterparty network itself (`vendor.travelrule`) is not connected: no message is sent to or read from another exchange.
 */

export type DepositTravelRuleErrorCode =
  | 'travel_rule.deposit_not_found'
  | 'travel_rule.deposit_state_refused'
  | 'travel_rule.fields_missing'
  | 'travel_rule.cipher_unwired'
  | 'travel_rule.wait_limit_unset'
  | 'travel_rule.not_declared';

const KIND: Record<DepositTravelRuleErrorCode, TRPCError['code']> = {
  'travel_rule.deposit_not_found': 'NOT_FOUND',
  'travel_rule.deposit_state_refused': 'CONFLICT',
  'travel_rule.fields_missing': 'PRECONDITION_FAILED',
  'travel_rule.cipher_unwired': 'SERVICE_UNAVAILABLE',
  'travel_rule.wait_limit_unset': 'PRECONDITION_FAILED',
  'travel_rule.not_declared': 'PRECONDITION_FAILED',
};

export class DepositTravelRuleError extends Error {
  constructor(
    readonly code: DepositTravelRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DepositTravelRuleError';
  }
}

const assetIdSchema = z.string().regex(/^[A-Za-z0-9]{1,16}$/);
const userIdSchema = z.string().min(1).max(128);
const thresholdSchema = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/, 'a threshold is an unsigned decimal string');
const fieldSchema = z.enum(PAY_TRAVEL_RULE_FIELDS);

export const inboundRuleSetInputSchema = z
  .object({
    assetId: assetIdSchema,
    applies: z.boolean(),
    /** Required when the rule applies; absent when it does not. */
    threshold: thresholdSchema.nullable(),
    fields: z.array(fieldSchema).max(PAY_TRAVEL_RULE_FIELDS.length),
    reason: reasonSchema,
  })
  .strict()
  .refine((v) => (v.applies ? v.threshold !== null && parseAmount(v.threshold) > 0n : v.threshold === null), {
    path: ['threshold'],
    message: 'a rule that applies has a positive threshold; one that does not has none',
  })
  .refine((v) => new Set(v.fields).size === v.fields.length, { path: ['fields'], message: 'each field once' });
export type InboundRuleSetInput = z.infer<typeof inboundRuleSetInputSchema>;

export const inboundRuleViewSchema = z
  .object({
    version: z.number().int(),
    assetId: z.string(),
    applies: z.boolean(),
    threshold: z.string().nullable(),
    fields: z.array(fieldSchema),
    reason: z.string(),
    setBy: z.string(),
    setAt: z.string(),
  })
  .strict();
export type InboundRuleView = z.infer<typeof inboundRuleViewSchema>;

export const heldDepositViewSchema = z
  .object({
    depositId: z.string(),
    userId: z.string(),
    assetId: z.string(),
    networkId: z.string(),
    txHash: z.string(),
    amount: z.string(),
    threshold: z.string(),
    ruleVersion: z.number().int(),
    requiredFields: z.array(fieldSchema),
    state: z.enum(PAY_DEPOSIT_TRAVEL_RULE_STATES),
    walletType: z.enum(PAY_DEPOSIT_WALLET_TYPES).nullable(),
    declaredAt: z.string().nullable(),
    waitDeadline: z.string().nullable(),
    openedAt: z.string(),
    lastActor: z.string(),
    lastReason: z.string().nullable(),
  })
  .strict();
export type HeldDepositView = z.infer<typeof heldDepositViewSchema>;

const depositActionInputSchema = z.object({ depositId: z.string().uuid(), reason: reasonSchema }).strict();
export const releaseResultSchema = z.object({ deposit: heldDepositViewSchema, credited: z.boolean() }).strict();

interface RecordRow {
  deposit_id: string;
  user_id: string;
  deposit_status: string;
  asset_id: string;
  network_id: string;
  tx_hash: string;
  amount: string;
  threshold: string;
  rule_seq: string;
  required_fields: PayTravelRuleField[];
  wallet_type: (typeof PAY_DEPOSIT_WALLET_TYPES)[number] | null;
  declared_at: Date | null;
  opened_at: Date;
  state: PayDepositTravelRuleState;
  wait_deadline: Date | null;
  actor: string;
  reason: string | null;
}

const SELECT_RECORD = `
  SELECT t.deposit_id, t.user_id, d.status AS deposit_status, d.asset_id, d.network_id, d.tx_hash, d.amount, t.threshold::text AS threshold,
         t.rule_seq::text AS rule_seq, t.required_fields, t.wallet_type, t.declared_at, t.opened_at,
         e.state, e.wait_deadline, e.actor, e.reason
    FROM pay.custody_deposit_travel_rule t
    JOIN pay.custody_deposits d ON d.id = t.deposit_id
    JOIN LATERAL (SELECT state, wait_deadline, actor, reason FROM pay.custody_deposit_travel_rule_events
                   WHERE deposit_id = t.deposit_id ORDER BY seq DESC LIMIT 1) e ON true`;

const decimal = (value: string) => formatAmount(parseAmount(value));
const iso = (value: Date | null) => (value ? value.toISOString() : null);

function heldView(r: RecordRow): HeldDepositView {
  return {
    depositId: r.deposit_id,
    userId: r.user_id,
    assetId: r.asset_id,
    networkId: r.network_id,
    txHash: r.tx_hash,
    amount: decimal(r.amount),
    threshold: decimal(r.threshold),
    ruleVersion: Number(r.rule_seq),
    requiredFields: r.required_fields,
    state: r.state,
    walletType: r.wallet_type,
    declaredAt: iso(r.declared_at),
    waitDeadline: iso(r.wait_deadline),
    openedAt: r.opened_at.toISOString(),
    lastActor: r.actor,
    lastReason: r.reason,
  };
}

function customerView(r: RecordRow): PayDepositTravelRuleView {
  return {
    depositId: r.deposit_id,
    assetId: r.asset_id,
    networkId: r.network_id,
    amount: decimal(r.amount),
    threshold: decimal(r.threshold),
    state: r.state,
    requiredFields: r.required_fields,
    walletType: r.wallet_type,
    declaredAt: iso(r.declared_at),
    waitDeadline: iso(r.wait_deadline),
  };
}

/** The additional data the declaration is sealed with: a sealed value moved to another deposit does not open. */
const sealAad = (depositId: string) => `pay.deposit-travel-rule:${depositId.toLowerCase()}`;

/** What the deposit book does when a held deposit is released or its record moves (`CustodyDepositBook`). */
export interface DepositTravelRuleBook {
  releaseTravelRule<T>(depositId: string, record: (tx: Sql) => Promise<T>): Promise<{ recorded: T; credited: boolean }>;
  markTravelRuleReason(tx: Sql, depositId: string, state: string): Promise<void>;
}

export interface DepositTravelRuleDeps {
  readonly sql: Sql;
  readonly book: DepositTravelRuleBook;
  /** The travel-rule key (`PAY_TRAVEL_RULE_MESSAGE_KEY`). Absent: a declaration refuses and nothing is stored. */
  readonly cipher?: MessageCipher | null;
}

/** Where a state may move. `released` is final; the counterparty wait can be set again from its own expiry. */
const MAY_MOVE: Record<PayDepositTravelRuleState, readonly PayDepositTravelRuleState[]> = {
  awaiting_declaration: ['under_review', 'counterparty_pending'],
  under_review: ['counterparty_pending', 'released'],
  counterparty_pending: ['under_review', 'blocking_time_expired', 'released'],
  blocking_time_expired: ['counterparty_pending', 'released'],
  released: [],
};

export class DepositTravelRuleService {
  constructor(private readonly deps: DepositTravelRuleDeps) {}

  // ── owner rules ─────────────────────────────────────────────────────────────

  async setRule(actor: string, input: InboundRuleSetInput): Promise<InboundRuleView> {
    const [row] = await this.deps.sql<RuleRow[]>`
      INSERT INTO pay.travel_rule_inbound_rule_events (asset_id, applies, threshold, fields, reason, set_by)
      VALUES (${input.assetId}, ${input.applies}, ${input.threshold}::numeric, ${this.deps.sql.json(input.fields)}, ${input.reason.trim()}, ${actor})
      RETURNING seq::text, asset_id, applies, threshold::text, fields, reason, set_by, set_at`;
    return ruleView(row!);
  }

  /** The current inbound rule per asset. An asset with none has no row: its due deposits are not credited. */
  async listRules(): Promise<InboundRuleView[]> {
    const rows = await this.deps.sql<RuleRow[]>`
      SELECT DISTINCT ON (asset_id) seq::text, asset_id, applies, threshold::text, fields, reason, set_by, set_at
        FROM pay.travel_rule_inbound_rule_events ORDER BY asset_id, seq DESC`;
    return rows.map(ruleView);
  }

  // ── records ─────────────────────────────────────────────────────────────────

  private async load(q: Sql, depositId: string, lock = false): Promise<RecordRow | undefined> {
    // Lock in its own statement, then read the latest event afresh (as the outbound record does).
    if (lock) await q`SELECT deposit_id FROM pay.custody_deposit_travel_rule WHERE deposit_id = ${depositId}::uuid FOR UPDATE`;
    const [row] = await q.unsafe<RecordRow[]>(`${SELECT_RECORD} WHERE t.deposit_id = $1::uuid`, [depositId]);
    return row;
  }

  /** One account's travel-rule records, newest first. */
  async listForUser(userId: string, limit: number): Promise<HeldDepositView[]> {
    const rows = await this.deps.sql.unsafe<RecordRow[]>(
      `${SELECT_RECORD} WHERE t.user_id = $1 ORDER BY t.opened_at DESC, t.deposit_id LIMIT $2`,
      [userId, limit],
    );
    return rows.map(heldView);
  }

  /** The depositor's own record. Another account's deposit reads as not found. */
  async forCustomer(userId: string, depositId: string): Promise<PayDepositTravelRuleView> {
    const row = await this.load(this.deps.sql, depositId);
    if (!row || row.user_id !== userId)
      throw new DepositTravelRuleError('travel_rule.deposit_not_found', 'no such held deposit for this account');
    return customerView(row);
  }

  /**
   * The depositor declares the sending wallet and every asked field. Sealed, never returned. A repeat after it was taken
   * returns the record as it stands; a declaration once compliance moved past review is refused.
   */
  async declare(userId: string, input: PayDepositTravelRuleDeclareInput): Promise<PayDepositTravelRuleView> {
    const cipher = this.deps.cipher;
    const done = await this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const row = await this.load(q, input.depositId, true);
      if (!row || row.user_id !== userId)
        throw new DepositTravelRuleError('travel_rule.deposit_not_found', 'no such held deposit for this account');
      if (row.declared_at && row.state !== 'awaiting_declaration') return row;
      if (row.state !== 'awaiting_declaration' || row.deposit_status !== 'held_travel_rule') {
        throw new DepositTravelRuleError(
          'travel_rule.deposit_state_refused',
          `a ${row.state} (${row.deposit_status}) deposit takes no declaration`,
        );
      }
      const missing = row.required_fields.filter((f) => !input.fields[f]?.trim());
      if (missing.length > 0) throw new DepositTravelRuleError('travel_rule.fields_missing', `still to give: ${missing.join(', ')}`);
      if (!cipher) throw new DepositTravelRuleError('travel_rule.cipher_unwired', 'no travel-rule key is loaded, so nothing can be stored');
      // Only the asked fields are kept: anything else the client sent is not stored.
      const kept = Object.fromEntries(row.required_fields.map((f) => [f, input.fields[f]!.trim()]));
      const sealed = cipher.seal(
        Buffer.from(JSON.stringify({ walletType: input.walletType, fields: kept }), 'utf8'),
        sealAad(row.deposit_id),
      );
      await q`
        UPDATE pay.custody_deposit_travel_rule
           SET wallet_type = ${input.walletType}, declaration_key_id = ${sealed.keyId}, declaration_iv = ${sealed.iv},
               declaration_auth_tag = ${sealed.authTag}, declaration_ciphertext = ${sealed.ciphertext}, declared_at = now()
         WHERE deposit_id = ${row.deposit_id} AND declared_at IS NULL`;
      await q`
        INSERT INTO pay.custody_deposit_travel_rule_events (deposit_id, state, source, actor, reason)
        VALUES (${row.deposit_id}, 'under_review', 'customer', ${userId}, 'the depositor declared the sending wallet')`;
      await this.deps.book.markTravelRuleReason(q, row.deposit_id, 'under_review');
      return (await this.load(q, row.deposit_id))!;
    });
    return customerView(done);
  }

  /** Compliance waits on the counterparty exchange, for the owner's pending wait limit. Nothing is released by it. */
  async markCounterpartyPending(actor: string, depositId: string, reason: string): Promise<HeldDepositView> {
    const [limit] = await this.deps.sql<Array<{ pending_seconds: number }>>`
      SELECT pending_seconds FROM pay.travel_rule_wait_limit_events ORDER BY seq DESC LIMIT 1`;
    if (!limit) throw new DepositTravelRuleError('travel_rule.wait_limit_unset', 'the owner has not set the travel-rule wait limits');
    const row = await this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const current = await this.movable(q, depositId, 'counterparty_pending');
      await q`
        INSERT INTO pay.custody_deposit_travel_rule_events (deposit_id, state, source, actor, reason, wait_deadline)
        VALUES (${current.deposit_id}, 'counterparty_pending', 'operator', ${actor}, ${reason.trim()},
                now() + make_interval(secs => ${limit.pending_seconds}))`;
      await this.deps.book.markTravelRuleReason(q, current.deposit_id, 'counterparty_pending');
      return (await this.load(q, current.deposit_id))!;
    });
    return heldView(row);
  }

  /**
   * A founder releases a declared deposit. The release and the deposit's return to judging are one transaction; the deposit is
   * then credited once under its usual key. An undeclared deposit is refused, whatever the counterparty said.
   */
  async release(actor: string, depositId: string, reason: string): Promise<{ deposit: HeldDepositView; credited: boolean }> {
    const { credited } = await this.deps.book.releaseTravelRule(depositId, async (tx) => {
      const current = await this.movable(tx, depositId, 'released');
      if (!current.declared_at) throw new DepositTravelRuleError('travel_rule.not_declared', 'the depositor has not declared this deposit');
      await tx`
        INSERT INTO pay.custody_deposit_travel_rule_events (deposit_id, state, source, actor, reason)
        VALUES (${current.deposit_id}, 'released', 'operator', ${actor}, ${reason.trim()})`;
      return current.deposit_id;
    });
    const row = await this.load(this.deps.sql, depositId);
    return { deposit: heldView(row!), credited };
  }

  /** The locked record, when it may move to `to`. */
  private async movable(q: Sql, depositId: string, to: PayDepositTravelRuleState): Promise<RecordRow> {
    const row = await this.load(q, depositId, true);
    if (!row) throw new DepositTravelRuleError('travel_rule.deposit_not_found', 'no travel-rule record for this deposit');
    if (!MAY_MOVE[row.state].includes(to)) {
      throw new DepositTravelRuleError('travel_rule.deposit_state_refused', `a ${row.state} deposit cannot become ${to}`);
    }
    // A held deposit the chain took back (closed `reversed`) or sent to review is no longer the travel rule's to move.
    if (row.deposit_status !== 'held_travel_rule') {
      throw new DepositTravelRuleError(
        'travel_rule.deposit_state_refused',
        `the deposit is ${row.deposit_status}, not held for the travel rule`,
      );
    }
    return row;
  }
}

interface RuleRow {
  seq: string;
  asset_id: string;
  applies: boolean;
  threshold: string | null;
  fields: PayTravelRuleField[];
  reason: string;
  set_by: string;
  set_at: Date;
}

const ruleView = (r: RuleRow): InboundRuleView => ({
  version: Number(r.seq),
  assetId: r.asset_id,
  applies: r.applies,
  threshold: r.threshold === null ? null : decimal(r.threshold),
  fields: r.fields,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at.toISOString(),
});

function toTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof DepositTravelRuleError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
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

export type DepositTravelRuleMountDeps = DepositTravelRuleDeps;

/** `founderAdmin.depositTravelRule.*`: every procedure is founder-only. No procedure returns a declared value. */
export function createDepositTravelRuleRouter(deps: DepositTravelRuleDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new DepositTravelRuleService(deps);
  return router({
    rules: router({
      list: founder
        .input(z.object({}).strict())
        .output(z.array(inboundRuleViewSchema))
        .query(() => wrap(() => service.listRules())),
      set: founder
        .input(inboundRuleSetInputSchema)
        .output(inboundRuleViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setRule(actorOf(ctx), input))),
    }),
    list: founder
      .input(z.object({ userId: userIdSchema, limit: z.number().int().min(1).max(200).default(50) }).strict())
      .output(z.array(heldDepositViewSchema))
      .query(({ input }) => wrap(() => service.listForUser(input.userId, input.limit))),
    markCounterpartyPending: founder
      .input(depositActionInputSchema)
      .output(heldDepositViewSchema)
      .mutation(({ ctx, input }) => wrap(() => service.markCounterpartyPending(actorOf(ctx), input.depositId, input.reason))),
    release: founder
      .input(depositActionInputSchema)
      .output(releaseResultSchema)
      .mutation(({ ctx, input }) => wrap(() => service.release(actorOf(ctx), input.depositId, input.reason))),
  });
}

/**
 * `custodyDeposit.travelRule.get/declare`: the depositor's own held deposit. The user id comes from the session, so another
 * account's deposit reads as not found.
 */
export function createDepositTravelRuleCustomerRouter(deps: DepositTravelRuleDeps) {
  const service = new DepositTravelRuleService(deps);
  return router({
    custodyDeposit: router({
      travelRule: router({
        get: scopedProcedure('trade:read', { module: 'ledger' })
          .input(z.object({ depositId: z.string().uuid() }).strict())
          .output(payDepositTravelRuleViewSchema)
          .query(({ ctx, input }) => wrap(() => service.forCustomer(ctx.principal.userId, input.depositId))),
        declare: scopedProcedure('trade:write', { module: 'ledger' })
          .input(payDepositTravelRuleDeclareInputSchema)
          .output(payDepositTravelRuleViewSchema)
          .mutation(({ ctx, input }) => wrap(() => service.declare(ctx.principal.userId, input))),
      }),
    }),
  });
}
