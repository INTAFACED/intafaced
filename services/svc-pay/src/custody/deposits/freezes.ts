import { z } from 'zod';
import type { Sql } from 'postgres';
import { router, TRPCError } from '@intafaced/contracts';
import {
  consumePayApproval,
  payActionPayloadHash,
  ActionApprovalConsumeError,
  type ActionApprovalConsumer,
} from '../../action-approval-consume.js';
import { requireDualControl, DualControlError } from '../../dual-control.js';
import { founderProcedure, type FounderContext } from '../../namespaces/founder-procedure.js';
import type { FounderAuthority } from '../../founder-authority.js';
import { reasonSchema } from '../../registries/schemas.js';

/**
 * Compliance freezes on customer deposit addresses (W-compliance-notices-03, J-wallet-03 #4). Founder-only and audited: every
 * freeze is a row in `custody_deposit_address_freezes`, so the table is also the history.
 *
 * A FREEZE POSTS NOTHING. While an address has an open freeze, a deposit to it that is not yet credited is `on_hold` (reason
 * `address_frozen`) and is never credited (`custody/deposits/book.ts`). Freezing needs one founder and a reason. Unfreezing
 * needs a SECOND founder: an identity approval bound to this freeze, consumed before the freeze is lifted, and the founder who
 * lifts it is not its approver. Then the held deposits are judged again and each is credited once under its usual key.
 *
 * A deposit already credited is not touched by a freeze; stopping an account's money is the account freeze, which belongs to
 * svc-identity (Account controls). The reply says how many credited deposits the freeze leaves as they are.
 */

export const DEPOSIT_ADDRESS_UNFREEZE_ACTION = 'pay.deposit_address_unfreeze';

export type DepositFreezeErrorCode =
  'deposit_freeze.address_unknown' | 'deposit_freeze.already_frozen' | 'deposit_freeze.not_frozen' | 'deposit_freeze.freeze_changed';

const KIND: Record<DepositFreezeErrorCode, TRPCError['code']> = {
  'deposit_freeze.address_unknown': 'NOT_FOUND',
  'deposit_freeze.already_frozen': 'CONFLICT',
  'deposit_freeze.not_frozen': 'CONFLICT',
  'deposit_freeze.freeze_changed': 'CONFLICT',
};

export class DepositFreezeError extends Error {
  constructor(
    readonly code: DepositFreezeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DepositFreezeError';
  }
}

const userIdSchema = z.string().min(1).max(128);
const networkIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const addressSchema = z.string().min(1).max(256).regex(/^\S+$/);

export const depositFreezeInputSchema = z
  .object({ userId: userIdSchema, networkId: networkIdSchema, address: addressSchema, reason: reasonSchema })
  .strict();
export type DepositFreezeInput = z.infer<typeof depositFreezeInputSchema>;

export const depositUnfreezeInputSchema = z
  .object({
    userId: userIdSchema,
    networkId: networkIdSchema,
    address: addressSchema,
    /** The open freeze this unfreeze lifts; a freeze lifted and placed again since needs a new approval. */
    freezeId: z.string().uuid(),
    reason: reasonSchema,
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();
export type DepositUnfreezeInput = z.infer<typeof depositUnfreezeInputSchema>;

export const depositFreezeViewSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    networkId: z.string(),
    address: z.string(),
    reason: z.string(),
    frozenBy: z.string(),
    frozenAt: z.string(),
    unfrozenBy: z.string().nullable(),
    unfreezeApprover: z.string().nullable(),
    unfreezeReason: z.string().nullable(),
    unfrozenAt: z.string().nullable(),
  })
  .strict();
export type DepositFreezeView = z.infer<typeof depositFreezeViewSchema>;

export const depositAddressStateSchema = z
  .object({
    /** `<networkId>:<address>`: an address belongs to one customer, asset and network. */
    id: z.string(),
    userId: z.string(),
    assetId: z.string(),
    networkId: z.string(),
    address: z.string(),
    /** When an extra address stops being for deposits; null when it never expires. */
    expiresAt: z.string().nullable(),
    frozen: z.boolean(),
    /** The open freeze, when there is one. */
    freezeId: z.string().nullable(),
    freezeReason: z.string().nullable(),
    frozenBy: z.string().nullable(),
    frozenAt: z.string().nullable(),
    /** Deposits to this address held by a freeze now. */
    held: z.number().int(),
  })
  .strict();

export const depositFreezeResultSchema = z
  .object({ freeze: depositFreezeViewSchema, held: z.number().int(), creditedUntouched: z.number().int() })
  .strict();
export const depositUnfreezeResultSchema = z
  .object({ freeze: depositFreezeViewSchema, released: z.number().int(), credited: z.number().int() })
  .strict();
export const depositUnfreezePreviewSchema = z.object({ actionType: z.string(), payloadHash: z.string() }).strict();

interface FreezeRow {
  id: string;
  user_id: string;
  network_id: string;
  address: string;
  reason: string;
  frozen_by: string;
  frozen_at: Date;
  unfrozen_by: string | null;
  unfreeze_approver: string | null;
  unfreeze_reason: string | null;
  unfrozen_at: Date | null;
}

const viewOf = (row: FreezeRow): DepositFreezeView => ({
  id: row.id,
  userId: row.user_id,
  networkId: row.network_id,
  address: row.address,
  reason: row.reason,
  frozenBy: row.frozen_by,
  frozenAt: row.frozen_at.toISOString(),
  unfrozenBy: row.unfrozen_by,
  unfreezeApprover: row.unfreeze_approver,
  unfreezeReason: row.unfreeze_reason,
  unfrozenAt: row.unfrozen_at ? row.unfrozen_at.toISOString() : null,
});

/** The fields the second founder's approval binds: this freeze, this address, this reason. */
export function unfreezeApprovalFields(input: Pick<DepositUnfreezeInput, 'userId' | 'networkId' | 'address' | 'freezeId' | 'reason'>) {
  return {
    freezeId: input.freezeId.toLowerCase(),
    userId: input.userId,
    networkId: input.networkId,
    address: input.address.toLowerCase(),
    reason: input.reason.trim(),
  };
}

/** What the deposit record does when a freeze is placed or lifted (`CustodyDepositBook`). */
export interface DepositFreezeBook {
  holdAddress(networkId: string, address: string): Promise<number>;
  /** Runs `lift` and puts the address's held deposits back to be judged in one transaction, then credits each that is due. */
  release<T>(networkId: string, address: string, lift: (tx: Sql) => Promise<T>): Promise<{ lifted: T; released: number; credited: number }>;
}

export interface DepositFreezesMountDeps {
  readonly sql: Sql;
  readonly approvals: ActionApprovalConsumer;
  readonly book: DepositFreezeBook;
}

export class DepositFreezeService {
  constructor(private readonly deps: DepositFreezesMountDeps) {}

  /** The customer's deposit addresses (each unique per network), with its open freeze and how many deposits it holds. */
  async addresses(userId: string) {
    const rows = await this.deps.sql<
      Array<{ asset_id: string; network_id: string; address: string; expires_at: Date | null; held: string }>
    >`
      SELECT a.asset_id, a.network_id, a.address, a.expires_at,
             (SELECT count(*) FROM pay.custody_deposits d
               WHERE d.network_id = a.network_id AND lower(d.address) = lower(a.address) AND d.status = 'on_hold')::text AS held
        FROM pay.custody_deposit_addresses a
       WHERE a.user_id = ${userId}
       ORDER BY a.asset_id, a.network_id, a.address_index`;
    const open = await this.deps.sql<FreezeRow[]>`
      SELECT * FROM pay.custody_deposit_address_freezes WHERE user_id = ${userId} AND unfrozen_at IS NULL`;
    return rows.map((r) => {
      const freeze = open.find((f) => f.network_id === r.network_id && f.address === r.address.toLowerCase()) ?? null;
      return {
        id: `${r.network_id}:${r.address}`,
        userId,
        assetId: r.asset_id,
        networkId: r.network_id,
        address: r.address,
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
        frozen: freeze !== null,
        freezeId: freeze?.id ?? null,
        freezeReason: freeze?.reason ?? null,
        frozenBy: freeze?.frozen_by ?? null,
        frozenAt: freeze ? freeze.frozen_at.toISOString() : null,
        held: Number(r.held),
      };
    });
  }

  /** Every freeze on the customer's addresses, open and lifted, newest first. */
  async history(userId: string, limit: number): Promise<DepositFreezeView[]> {
    const rows = await this.deps.sql<FreezeRow[]>`
      SELECT * FROM pay.custody_deposit_address_freezes WHERE user_id = ${userId} ORDER BY frozen_at DESC, id LIMIT ${limit}`;
    return rows.map(viewOf);
  }

  async freeze(actorId: string, input: DepositFreezeInput) {
    const { sql } = this.deps;
    const address = await this.ownedAddress(input);
    let row: FreezeRow;
    try {
      row = (
        await sql<FreezeRow[]>`
          INSERT INTO pay.custody_deposit_address_freezes (user_id, network_id, address, reason, frozen_by)
          VALUES (${input.userId}, ${input.networkId}, ${address}, ${input.reason.trim()}, ${actorId})
          RETURNING *`
      )[0]!;
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new DepositFreezeError('deposit_freeze.already_frozen', 'this deposit address is already frozen');
      }
      throw error;
    }
    const held = await this.deps.book.holdAddress(input.networkId, address);
    // Credited, or with a credit already started (it may be in the ledger, so it is finished): a freeze does not undo either.
    const [credited] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM pay.custody_deposits
       WHERE network_id = ${input.networkId} AND lower(address) = ${address} AND status <> 'reversed'
         AND (credited_at IS NOT NULL OR credit_started_at IS NOT NULL)`;
    return { freeze: viewOf(row), held, creditedUntouched: Number(credited?.n ?? '0') };
  }

  /** The action type and payload hash the proposing founder files with identity for this unfreeze. */
  previewUnfreeze(input: DepositUnfreezeInput) {
    return {
      actionType: DEPOSIT_ADDRESS_UNFREEZE_ACTION,
      payloadHash: payActionPayloadHash(DEPOSIT_ADDRESS_UNFREEZE_ACTION, unfreezeApprovalFields(input)),
    };
  }

  async unfreeze(actorId: string, input: DepositUnfreezeInput) {
    const { sql } = this.deps;
    const address = await this.ownedAddress(input);
    const open = await this.openFreeze(input.networkId, address);
    if (!open) throw new DepositFreezeError('deposit_freeze.not_frozen', 'this deposit address is not frozen');
    if (open.id !== input.freezeId.toLowerCase()) {
      throw new DepositFreezeError('deposit_freeze.freeze_changed', 'the freeze changed since it was read; reload and ask again');
    }
    const approver = await consumePayApproval(
      this.deps.approvals,
      input,
      DEPOSIT_ADDRESS_UNFREEZE_ACTION,
      unfreezeApprovalFields({ ...input, address }),
    );
    const approverId = requireDualControl(actorId.toLowerCase(), approver.trim().toLowerCase());
    const { lifted, released, credited } = await this.deps.book.release(input.networkId, address, async (tx) => {
      const rows = await tx<FreezeRow[]>`
        UPDATE pay.custody_deposit_address_freezes
           SET unfrozen_by = ${actorId}, unfreeze_approver = ${approverId}, unfreeze_reason = ${input.reason.trim()}, unfrozen_at = now()
         WHERE id = ${open.id} AND unfrozen_at IS NULL RETURNING *`;
      if (!rows[0]) throw new DepositFreezeError('deposit_freeze.freeze_changed', 'the freeze was lifted by someone else first');
      return rows[0];
    });
    return { freeze: viewOf(lifted), released, credited };
  }

  private async openFreeze(networkId: string, address: string): Promise<FreezeRow | null> {
    const rows = await this.deps.sql<FreezeRow[]>`
      SELECT * FROM pay.custody_deposit_address_freezes
       WHERE network_id = ${networkId} AND address = ${address} AND unfrozen_at IS NULL`;
    return rows[0] ?? null;
  }

  /** The address, lower-cased, when it is one of this customer's deposit addresses on this network. */
  private async ownedAddress(input: { userId: string; networkId: string; address: string }): Promise<string> {
    const rows = await this.deps.sql<Array<{ address: string }>>`
      SELECT address FROM pay.custody_deposit_addresses
       WHERE user_id = ${input.userId} AND network_id = ${input.networkId} AND lower(address) = ${input.address.toLowerCase()}`;
    if (!rows[0]) {
      throw new DepositFreezeError('deposit_freeze.address_unknown', 'no deposit address of this customer on this network matches');
    }
    return rows[0].address.toLowerCase();
  }
}

function toTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof DepositFreezeError) {
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

/** `founderAdmin.depositFreezes.*`: every procedure is founder-only. */
export function createDepositFreezesRouter(deps: DepositFreezesMountDeps & { founderAuthority: FounderAuthority }) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new DepositFreezeService(deps);
  return router({
    addresses: founder
      .input(z.object({ userId: userIdSchema }).strict())
      .output(z.array(depositAddressStateSchema))
      .query(({ input }) => wrap(() => service.addresses(input.userId))),
    history: founder
      .input(z.object({ userId: userIdSchema, limit: z.number().int().min(1).max(200).default(50) }).strict())
      .output(z.array(depositFreezeViewSchema))
      .query(({ input }) => wrap(() => service.history(input.userId, input.limit))),
    freeze: founder
      .input(depositFreezeInputSchema)
      .output(depositFreezeResultSchema)
      .mutation(({ ctx, input }) => wrap(() => service.freeze(actorOf(ctx), input))),
    previewUnfreeze: founder
      .input(depositUnfreezeInputSchema)
      .output(depositUnfreezePreviewSchema)
      .query(({ input }) => wrap(async () => service.previewUnfreeze(input))),
    unfreeze: founder
      .input(depositUnfreezeInputSchema)
      .output(depositUnfreezeResultSchema)
      .mutation(({ ctx, input }) => wrap(() => service.unfreeze(actorOf(ctx), input))),
  });
}
