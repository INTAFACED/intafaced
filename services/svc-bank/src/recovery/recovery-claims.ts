import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { recoveryClaimMessage, type RecoveryClaimVerifyRequest, type RecoveryEstate } from '@intafaced/contracts';
import {
  DEFINITE_POST_REFUSAL_CODES,
  LedgerError,
  accountKey,
  accountPurpose,
  bankTransferKey,
  formatAmount,
  parseAmount,
  recipes,
  recoverySweepTransferId,
  userAvailable,
  type AccountKind,
  type AccountRef,
  type Amount,
  type Balance,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { IdentityRecoveryPort } from './identity-recovery.js';

/**
 * Recovery claims (RC-identity-08, J-identity-05 #7): the heir an owner named moves the owner's balances into their own
 * main account, once two staff confirmed the owner's death and enough of the owner's own recovery keys signed the claim.
 * Staff decide only that the owner died; who receives and which keys count are the owner's choices, held by identity.
 *
 * The bank keeps the claim and its sweep plan, never a balance. Each round plans one row per funded account of the owner
 * (their main account in each asset and each of their named spaces) before anything posts, then posts each row as a
 * `bankTransfer` in the `recovery` key space, keyed by the claim, the account and the round. A crash after the plan
 * resumes the same rows with the same keys, so nothing posts twice; value that reaches the owner's accounts after a
 * round is swept by the next round. Value that is not free to move (an order or withdrawal hold, a stake, collateral)
 * stays where it is and is listed: the free value moves without it, and once it is released a later round moves it. A
 * negative balance is a debt the owner still owes, and refuses the whole round with `bank.recovery_blocked`, so no heir
 * is paid ahead of it.
 */

export type RecoveryAccount = {
  readonly account: AccountRef;
  /** The named space this account is, or null for the owner's main account in this asset. */
  readonly spaceId: string | null;
  readonly spaceName: string | null;
  readonly amount: Amount;
};

export type RecoveryEstateView = RecoveryEstate & {
  readonly claim: RecoveryClaimRecord | null;
  /** Free value a sweep moves now, per account. */
  readonly sweepable: RecoveryAccount[];
  /** Value held for an order, withdrawal, stake or collateral: it stays, and a later round moves it once released. */
  readonly held: RecoveryAccount[];
  /** Negative balances (debts): any of these refuses a sweep with `bank.recovery_blocked`. */
  readonly blockers: RecoveryAccount[];
};

export type RecoveryClaimRecord = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly heirUserId: string;
  readonly noticeId: string;
  readonly status: 'open' | 'executed';
  readonly round: number;
  readonly createdAt: Date;
  readonly executedAt: Date | null;
};

export type RecoverySweepRecord = {
  readonly round: number;
  readonly accountKey: string;
  readonly fromOwnerType: 'user' | 'subaccount';
  readonly fromOwnerId: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly idempotencyKey: string;
  readonly status: 'pending' | 'posted' | 'refused';
  readonly ledgerTxId: string | null;
  readonly refusalCode: string | null;
};

export type RecoveryOpened = {
  readonly claim: RecoveryClaimRecord;
  readonly handle: string;
  readonly threshold: number;
  readonly liveKeys: number;
  /** What each recovery key signs for this claim. */
  readonly message: string;
};

export type RecoveryExecuted = {
  readonly claim: RecoveryClaimRecord;
  /** The round this call planned or resumed, or null when there was nothing to sweep. */
  readonly round: number | null;
  readonly sweeps: RecoverySweepRecord[];
};

type ClaimRow = {
  id: string;
  owner_user_id: string;
  heir_user_id: string;
  notice_id: string;
  status: 'open' | 'executed';
  round: number;
  created_at: Date;
  executed_at: Date | null;
};

type SweepRow = {
  round: number;
  account_key: string;
  from_owner_type: 'user' | 'subaccount';
  from_owner_id: string;
  asset_id: string;
  amount: string;
  idempotency_key: string;
  status: 'pending' | 'posted' | 'refused';
  ledger_tx_id: string | null;
  refusal_code: string | null;
};

const toClaim = (row: ClaimRow): RecoveryClaimRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  heirUserId: row.heir_user_id,
  noticeId: row.notice_id,
  status: row.status,
  round: row.round,
  createdAt: row.created_at,
  executedAt: row.executed_at,
});

const toSweep = (row: SweepRow): RecoverySweepRecord => ({
  round: row.round,
  accountKey: row.account_key,
  fromOwnerType: row.from_owner_type,
  fromOwnerId: row.from_owner_id,
  assetId: row.asset_id,
  amount: parseAmount(row.amount),
  idempotencyKey: row.idempotency_key,
  status: row.status,
  ledgerTxId: row.ledger_tx_id,
  refusalCode: row.refusal_code,
});

/**
 * The claim id for one account under one confirmed notice: a business key, so opening again answers the same claim and
 * every sweep key it names is the same on every retry.
 */
export function recoveryClaimId(ownerUserId: string, noticeId: string): string {
  const hex = createHash('sha256').update(`bank.recovery_claim:${ownerUserId.toLowerCase()}:${noticeId.toLowerCase()}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Free value: an `available` account with no purpose. Every other kind is claimed by something and blocks a sweep. */
function isFree(account: AccountRef): boolean {
  return account.kind === 'available' && accountPurpose(account) === '';
}

type RecoveryHoldings = Pick<RecoveryEstateView, 'sweepable' | 'held' | 'blockers'>;

/** What a sweep moves (free value), what stays until it is released (held value) and what stops it (a debt). */
export function splitHoldings(all: readonly RecoveryAccount[]): RecoveryHoldings {
  const sorted = [...all].sort((a, b) => (accountKey(a.account) < accountKey(b.account) ? -1 : 1));
  return {
    sweepable: sorted.filter((a) => isFree(a.account) && a.amount > 0n),
    held: sorted.filter((a) => !isFree(a.account) && a.amount > 0n),
    blockers: sorted.filter((a) => a.amount < 0n),
  };
}

function sweepRef(ownerType: 'user' | 'subaccount', ownerId: string, assetId: string): AccountRef {
  return { ownerType, ownerId, assetId, kind: 'available' satisfies AccountKind };
}

export class RecoveryClaimService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly spaces: SpaceService,
    private readonly identity: IdentityRecoveryPort,
  ) {}

  /** Every funded account of the owner, read from the ledger now: their own accounts and their named spaces'. */
  private async holdings(ownerUserId: string): Promise<RecoveryHoldings> {
    const [own, named] = await Promise.all([this.ledger.balances('user', ownerUserId), this.spaces.allNamedSpaces(ownerUserId)]);
    const pots = await Promise.all(named.map(async (space) => ({ space, balances: await this.ledger.balances('subaccount', space.id) })));
    const all: RecoveryAccount[] = [];
    const add = (balances: Balance[], spaceId: string | null, spaceName: string | null) => {
      for (const balance of balances) {
        if (balance.amount === 0n) continue;
        const { ownerType, ownerId, assetId, kind, purpose } = balance.account;
        all.push({
          account: { ownerType, ownerId, assetId, kind, ...(purpose ? { purpose } : {}) },
          spaceId,
          spaceName,
          amount: balance.amount,
        });
      }
    };
    add(own, null, null);
    for (const pot of pots) add(pot.balances, pot.space.id, pot.space.name);
    return splitHoldings(all);
  }

  private async claimFor(ownerUserId: string): Promise<RecoveryClaimRecord | null> {
    const rows = await this.sql<ClaimRow[]>`SELECT * FROM bank.recovery_claims WHERE owner_user_id = ${ownerUserId}`;
    return rows[0] ? toClaim(rows[0]) : null;
  }

  /** The accounts this person may claim as heir, as identity answers now, with what a sweep would move. */
  async estates(heirUserId: string): Promise<RecoveryEstateView[]> {
    const estates = await this.identity.estates(heirUserId);
    return Promise.all(
      estates.map(async (estate) => {
        const claim = await this.claimFor(estate.userId);
        return { ...estate, claim: claim && claim.heirUserId === heirUserId ? claim : null, ...(await this.holdings(estate.userId)) };
      }),
    );
  }

  /** Open (or answer again) the claim on one account identity lists for this heir. Moves nothing. */
  async open(heirUserId: string, ownerUserId: string): Promise<RecoveryOpened> {
    const wanted = ownerUserId.toLowerCase();
    const estate = (await this.identity.estates(heirUserId)).find((e) => e.userId.toLowerCase() === wanted);
    if (!estate)
      throw new BankError('This account is not one you can claim [bank.recovery_estate_not_found]', 'bank.recovery_estate_not_found');
    const id = recoveryClaimId(estate.userId, estate.noticeId);
    await this.sql`
      INSERT INTO bank.recovery_claims (id, owner_user_id, heir_user_id, notice_id)
      VALUES (${id}, ${estate.userId}, ${heirUserId}, ${estate.noticeId})
      ON CONFLICT (owner_user_id) DO NOTHING
    `;
    const claim = await this.claimFor(estate.userId);
    if (!claim || claim.id !== id || claim.heirUserId !== heirUserId) {
      throw new BankError(
        'This account already has a claim under another notice [bank.recovery_claim_conflict]',
        'bank.recovery_claim_conflict',
      );
    }
    return {
      claim,
      handle: estate.handle,
      threshold: estate.threshold,
      liveKeys: estate.liveKeys,
      message: recoveryClaimMessage({ userId: claim.ownerUserId, heirUserId, claimId: claim.id }),
    };
  }

  /**
   * Sweep the owner's free balances into the heir's main account in each asset, once identity says these signatures
   * claim this account for this heir now. A retry resumes the round it planned with the same keys; once a round has
   * settled, asking again sweeps whatever arrived since in the next round.
   */
  async execute(heirUserId: string, claimId: string, signatures: RecoveryClaimVerifyRequest['signatures']): Promise<RecoveryExecuted> {
    const found = await this.sql<ClaimRow[]>`SELECT * FROM bank.recovery_claims WHERE id = ${claimId} AND heir_user_id = ${heirUserId}`;
    if (!found[0]) throw new BankError('No claim by that id is yours [bank.recovery_claim_not_found]', 'bank.recovery_claim_not_found');
    const opened = toClaim(found[0]);

    const verdict = await this.identity.verify({ userId: opened.ownerUserId, heirUserId, claimId: opened.id, signatures });
    if (!verdict.ok) throw new BankError(`The recovery keys did not claim this account [${verdict.code}]`, 'bank.recovery_claim_refused');
    if (verdict.noticeId.toLowerCase() !== opened.noticeId.toLowerCase()) {
      throw new BankError(
        'The account changed since this claim was opened [identity.recovery_account_changed]',
        'bank.recovery_claim_refused',
      );
    }

    // Plan: under the claim's lock, either the round a crash left pending, or a new one from the balances read just
    // before. The ledger is read outside the lock, so the lock and its connection are held only for the claim's rows;
    // value that arrives after the read goes to the next round, and value gone since is refused by the ledger.
    const { sweepable, blockers } = await this.holdings(opened.ownerUserId);
    const planned = await transaction(
      this.sql,
      async (tx) => {
        const [row] = await tx<ClaimRow[]>`SELECT * FROM bank.recovery_claims WHERE id = ${opened.id} FOR UPDATE`;
        const claim = toClaim(row!);
        const pending = await tx<SweepRow[]>`
          SELECT * FROM bank.recovery_sweeps WHERE claim_id = ${claim.id} AND status = 'pending' ORDER BY account_key
        `;
        if (pending.length > 0) return { round: claim.round, rows: pending.map(toSweep) };
        // A round whose rows have all settled is done, even when the call that posted it has not moved the claim on yet.
        let round = claim.round;
        const [planned] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM bank.recovery_sweeps WHERE claim_id = ${claim.id} AND round = ${round}
        `;
        if (planned!.n > 0) {
          round += 1;
          await tx`UPDATE bank.recovery_claims SET round = ${round} WHERE id = ${claim.id}`;
        }
        if (blockers.length > 0) {
          const named = [...new Set(blockers.map((b) => `${b.account.assetId} ${b.account.kind}`))].join(', ');
          throw new BankError(
            `The account owes a debt that must be settled first (${named}) [bank.recovery_blocked]`,
            'bank.recovery_blocked',
          );
        }
        if (sweepable.length === 0) return { round: null, rows: [] };
        const rows: RecoverySweepRecord[] = [];
        for (const item of sweepable) {
          const from = sweepRef(item.account.ownerType as 'user' | 'subaccount', item.account.ownerId, item.account.assetId);
          const key = accountKey(from);
          const idempotencyKey = bankTransferKey('recovery', recoverySweepTransferId(claim.id, from), round);
          const [inserted] = await tx<SweepRow[]>`
            INSERT INTO bank.recovery_sweeps (claim_id, round, account_key, from_owner_type, from_owner_id, asset_id, amount, idempotency_key)
            VALUES (${claim.id}, ${round}, ${key}, ${from.ownerType}, ${from.ownerId}, ${from.assetId},
                    ${formatAmount(item.amount)}::numeric, ${idempotencyKey})
            RETURNING *
          `;
          rows.push(toSweep(inserted!));
        }
        return { round, rows };
      },
      { isolation: 'read committed' },
    );

    // Post: each row once, with the key it was planned under. A refusal that proves nothing committed settles the row,
    // and the next round plans from the ledger again; anything else leaves it pending for the next call, which posts
    // the same key again. The heir's main account in each asset exists first, so the swept value shows in their spaces.
    // Whether the heir may receive was identity's answer a moment ago, under the owner's lock (`recovery_heir_inactive`).
    for (const assetId of new Set(planned.rows.map((r) => r.assetId))) await this.spaces.ensurePrimary(heirUserId, assetId);
    for (const sweep of planned.rows) {
      const from = sweepRef(sweep.fromOwnerType, sweep.fromOwnerId, sweep.assetId);
      try {
        const tx = await this.ledger.post(
          recipes.bankTransfer({
            transferId: recoverySweepTransferId(opened.id, from),
            occurrence: sweep.round,
            from,
            to: userAvailable(heirUserId, sweep.assetId),
            amount: sweep.amount,
            kind: 'manual',
            keySpace: 'recovery',
          }),
        );
        await this.sql`
          UPDATE bank.recovery_sweeps SET status = 'posted', ledger_tx_id = ${tx.id}, settled_at = now()
           WHERE claim_id = ${opened.id} AND round = ${sweep.round} AND account_key = ${sweep.accountKey} AND status = 'pending'
        `;
      } catch (err) {
        if (!(err instanceof LedgerError) || !DEFINITE_POST_REFUSAL_CODES.has(err.code)) throw err;
        await this.sql`
          UPDATE bank.recovery_sweeps SET status = 'refused', refusal_code = ${err.code}, settled_at = now()
           WHERE claim_id = ${opened.id} AND round = ${sweep.round} AND account_key = ${sweep.accountKey} AND status = 'pending'
        `;
      }
    }

    // Settle: a round with nothing pending is done, and the next call plans the next one.
    const claim = await transaction(
      this.sql,
      async (tx) => {
        const [row] = await tx<ClaimRow[]>`SELECT * FROM bank.recovery_claims WHERE id = ${opened.id} FOR UPDATE`;
        const current = toClaim(row!);
        const [left] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM bank.recovery_sweeps WHERE claim_id = ${opened.id} AND status = 'pending'
        `;
        if (left!.n > 0) return current;
        const nextRound = planned.round !== null && planned.round === current.round ? current.round + 1 : current.round;
        // Executed means value moved: a claim whose rounds swept nothing stays open.
        const [done] = await tx<ClaimRow[]>`
          UPDATE bank.recovery_claims c
             SET round = ${nextRound},
                 status = CASE WHEN p.any THEN 'executed' ELSE c.status END,
                 executed_at = CASE WHEN p.any THEN coalesce(c.executed_at, now()) ELSE c.executed_at END
            FROM (SELECT EXISTS (SELECT 1 FROM bank.recovery_sweeps WHERE claim_id = ${opened.id} AND status = 'posted') AS any) p
           WHERE c.id = ${opened.id}
           RETURNING c.*
        `;
        return toClaim(done!);
      },
      { isolation: 'read committed' },
    );

    const sweeps =
      planned.round === null
        ? []
        : (
            await this.sql<SweepRow[]>`
              SELECT * FROM bank.recovery_sweeps WHERE claim_id = ${opened.id} AND round = ${planned.round} ORDER BY account_key
            `
          ).map(toSweep);
    return { claim, round: planned.round, sweeps };
  }
}
