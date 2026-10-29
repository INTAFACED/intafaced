import { createHash } from 'node:crypto';
import { formatAmount, type Amount } from './money.js';
import {
  IDEMPOTENCY_CONFLICT_CODE,
  accountKey,
  assertIdempotencyKey,
  assertValidPost,
  postFingerprint,
  replayMetaDiffers,
  signedDelta,
  type IdempotencyConflictOptions,
  type LedgerClient,
} from './client.js';
import {
  InsufficientFundsError,
  LedgerError,
  type Account,
  type AccountRef,
  type Balance,
  type LedgerTx,
  type PostRequest,
  type PostedEntry,
} from './types.js';
import { assetIds, crossShardAnchor, hashAssetTx } from './sharding.js';

/**
 * Reference ledger implementation, in memory.
 *
 * This is not a toy. It is the executable specification of §4.2 that
 * svc-ledger's Postgres implementation must match entry for entry:
 *
 *   1. Sum-to-zero per asset, checked before anything is written.
 *   2. `available` never negative (except `treasury`, the external boundary).
 *   3. Locks funded from the owner's own available balance.
 *   4. Idempotency: the same key returns the original transaction, never a second one.
 *   5. Hash chain: hash = SHA-256(previousHash ‖ canonical(tx)).
 *      Asset-chain fields join that body only when the row stores them.
 *
 * The invariant suite in ledger.test.ts runs against this. When svc-ledger
 * lands, the same suite runs against both — that is the Phase 1 exit gate.
 */
export class MemoryLedger implements LedgerClient {
  private readonly accounts = new Map<string, Account>();
  private readonly balancesByAccountId = new Map<string, Amount>();
  private readonly txs = new Map<string, LedgerTx>();
  private readonly txByKey = new Map<string, string>();
  private readonly fingerprintByKey = new Map<string, string>();

  constructor(private readonly options: IdempotencyConflictOptions = {}) {}
  private readonly txOrder: string[] = [];
  private tip: string | null = null;
  private readonly assetTips = new Map<string, string>();

  /**
   * Owner types permitted to hold a negative `available` balance.
   *
   * `treasury` is the boundary with the outside world: when a user deposits,
   * value enters the book from here, so this account runs negative by exactly
   * the platform's total custody obligation. Every other owner — users,
   * sub-accounts, modules, house — is hard non-negative.
   */
  private static readonly NEGATIVE_ALLOWED = new Set(['treasury']);

  async post(request: PostRequest): Promise<LedgerTx> {
    // The shared order, documented at `assertIdempotencyKey` (STOP §4.2b #4):
    // key, then idempotency, then body. This engine already checked idempotency
    // before the body; what it did not do was validate the KEY first, so a post
    // with no key at all reached a `Map.get(undefined)` before being refused.
    // Same outcome, different route — and "different route" is how two engines
    // drift while every test passes.
    assertIdempotencyKey(request.idempotencyKey);

    // Idempotency before validation: a retry must never re-run the invariant
    // checks against a book that already contains its effects.
    const existingId = this.txByKey.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.txs.get(existingId);
      if (!existing) throw new LedgerError('Idempotency index corrupted', 'ledger.corrupt_index');
      if (this.fingerprintByKey.get(request.idempotencyKey) !== postFingerprint(request) || replayMetaDiffers(existing.meta, request)) {
        if ((this.options.idempotencyConflict ?? 'refuse') === 'refuse') {
          throw new LedgerError(
            `Idempotency key ${request.idempotencyKey} already booked a different movement; a retry must carry the same body`,
            IDEMPOTENCY_CONFLICT_CODE,
          );
        }
        try {
          this.options.onIdempotencyMismatch?.({ idempotencyKey: request.idempotencyKey, module: request.module, reason: request.reason });
        } catch {
          // Reporting a mismatch must never change the answer: detect mode returns the original, always.
        }
      }
      return existing;
    }

    assertValidPost(request);

    // Stage every mutation off the live maps, then commit. A refusal must not
    // insert an account or a zero balance: those rows would survive the throw,
    // and the error would name a staged balance the book does not hold.
    const staged = new Map<string, Amount>();
    const pendingAccounts = new Map<string, Account>();
    const postedEntries: PostedEntry[] = [];
    const txId = crypto.randomUUID();

    for (const entry of request.entries) {
      const key = accountKey(entry.account);
      const live = this.accounts.get(key);
      const account = this.stageAccount(entry.account, pendingAccounts);
      const held = live ? (this.balancesByAccountId.get(live.id) ?? 0n) : 0n;
      const current = staged.get(account.id) ?? held;
      const next = current + signedDelta(entry);

      if (next < 0n && !this.canGoNegative(entry.account)) {
        throw new InsufficientFundsError(live?.id ?? '', entry.account.assetId, formatAmount(entry.amount), formatAmount(held));
      }

      staged.set(account.id, next);
      postedEntries.push({
        id: crypto.randomUUID(),
        txId,
        accountId: account.id,
        assetId: entry.account.assetId,
        direction: entry.direction,
        amount: entry.amount,
        balanceAfter: next,
      });
    }

    const postedAt = new Date();
    const previousHash = this.tip;
    const previousAssetHashes: Record<string, string | null> = {};
    const assetHashes: Record<string, string> = {};
    for (const assetId of assetIds({ entries: postedEntries })) {
      const prior = this.assetTips.get(assetId) ?? null;
      previousAssetHashes[assetId] = prior;
      assetHashes[assetId] = hashAssetTx(
        { id: txId, module: request.module, reason: request.reason, postedAt, entries: postedEntries },
        assetId,
        prior,
      );
    }
    for (const [assetId, hash] of Object.entries(assetHashes)) this.assetTips.set(assetId, hash);
    const anchor = crossShardAnchor(assetHashes);
    const tx: LedgerTx = {
      id: txId,
      idempotencyKey: request.idempotencyKey,
      module: request.module,
      reason: request.reason,
      meta: request.meta ?? {},
      postedAt,
      previousHash,
      hash: hashTx(
        {
          id: txId,
          module: request.module,
          reason: request.reason,
          postedAt,
          entries: postedEntries,
          assetHashes,
          previousAssetHashes,
          crossShardAnchor: anchor,
        },
        previousHash,
      ),
      entries: postedEntries,
      assetHashes,
      previousAssetHashes,
      crossShardAnchor: anchor,
    };

    // Commit. New accounts land with the resulting balance, not a placeholder zero.
    for (const [key, account] of pendingAccounts) this.accounts.set(key, account);
    for (const [accountId, balance] of staged) this.balancesByAccountId.set(accountId, balance);
    this.txs.set(tx.id, tx);
    this.txByKey.set(tx.idempotencyKey, tx.id);
    this.fingerprintByKey.set(tx.idempotencyKey, postFingerprint(request));
    this.txOrder.push(tx.id);
    this.tip = tx.hash;

    return tx;
  }

  /**
   * Reading a balance creates nothing — the contract `LedgerClient.balance`
   * states, and what `PostgresLedger.balance` has always done.
   *
   * The reference implementation called `ensureAccount` here, so a read minted
   * the account. Harmless while an account was only ever a bucket; not harmless
   * once "does this owner have an account?" is the question that decides
   * whether an adapter is about to open a second book for one human. A
   * divergence between the two engines is exactly what the conformance suite
   * exists to forbid, and this one sat on the read path where nobody looked.
   */
  async balance(ref: AccountRef): Promise<Balance> {
    const account = this.accounts.get(accountKey(ref));
    if (!account) return { account: ref, accountId: '', amount: 0n };
    return { account: ref, accountId: account.id, amount: this.balancesByAccountId.get(account.id) ?? 0n };
  }

  async balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]> {
    const out: Balance[] = [];
    for (const account of this.accounts.values()) {
      if (account.ownerType !== ownerType || account.ownerId !== ownerId) continue;
      out.push({
        account,
        accountId: account.id,
        amount: this.balancesByAccountId.get(account.id) ?? 0n,
      });
    }
    return out;
  }

  async getTx(txId: string): Promise<LedgerTx | null> {
    return this.txs.get(txId) ?? null;
  }

  async getTxByKey(idempotencyKey: string): Promise<LedgerTx | null> {
    const id = this.txByKey.get(idempotencyKey);
    return id ? (this.txs.get(id) ?? null) : null;
  }

  // ── Reconciliation surface (§4.2) ──────────────────────────────────────────

  /** Every transaction in commit order — the replay source. */
  journal(): LedgerTx[] {
    return this.txOrder.map((id) => this.txs.get(id)!).filter(Boolean);
  }

  /**
   * Replay the journal from zero and compare to live balances.
   * Any mismatch is the condition that pages the operator and freezes a module.
   */
  reconcile(): { ok: true } | { ok: false; drift: Array<{ accountId: string; live: string; replayed: string }> } {
    const replayed = new Map<string, Amount>();
    for (const tx of this.journal()) {
      for (const entry of tx.entries) {
        const delta = entry.direction === 'debit' ? entry.amount : -entry.amount;
        replayed.set(entry.accountId, (replayed.get(entry.accountId) ?? 0n) + delta);
      }
    }

    const drift: Array<{ accountId: string; live: string; replayed: string }> = [];
    const ids = new Set([...this.balancesByAccountId.keys(), ...replayed.keys()]);
    for (const id of ids) {
      const live = this.balancesByAccountId.get(id) ?? 0n;
      const rep = replayed.get(id) ?? 0n;
      if (live !== rep) drift.push({ accountId: id, live: formatAmount(live), replayed: formatAmount(rep) });
    }

    return drift.length === 0 ? { ok: true } : { ok: false, drift };
  }

  /** Verify the hash chain end to end — tamper evidence. */
  verifyChain(): { ok: true } | { ok: false; brokenAt: string } {
    let previous: string | null = null;
    const priorAssetTip = new Map<string, string>();
    for (const tx of this.journal()) {
      const expected = hashTx(
        {
          id: tx.id,
          module: tx.module,
          reason: tx.reason,
          postedAt: tx.postedAt,
          entries: tx.entries,
          assetHashes: tx.assetHashes,
          previousAssetHashes: tx.previousAssetHashes,
          crossShardAnchor: tx.crossShardAnchor,
        },
        previous,
      );
      if (tx.previousHash !== previous || tx.hash !== expected) return { ok: false, brokenAt: tx.id };
      if (tx.assetHashes !== undefined || tx.previousAssetHashes !== undefined || tx.crossShardAnchor !== undefined) {
        if (tx.assetHashes === undefined || tx.previousAssetHashes === undefined) return { ok: false, brokenAt: tx.id };
        const linked = new Set<string>([...assetIds(tx), ...Object.keys(tx.assetHashes), ...Object.keys(tx.previousAssetHashes)]);
        for (const assetId of linked) {
          // Parent is the prior journal tip for this asset, or null until that asset appears.
          const priorTip = priorAssetTip.get(assetId) ?? null;
          const claimedParent = tx.previousAssetHashes[assetId] ?? null;
          if (claimedParent !== priorTip) return { ok: false, brokenAt: tx.id };
          const storedAsset = tx.assetHashes[assetId];
          const expectedAsset = hashAssetTx(tx, assetId, priorTip);
          if (storedAsset !== expectedAsset) return { ok: false, brokenAt: tx.id };
          priorAssetTip.set(assetId, storedAsset);
        }
        if (tx.crossShardAnchor !== crossShardAnchor(tx.assetHashes)) return { ok: false, brokenAt: tx.id };
      }
      previous = tx.hash;
    }
    return { ok: true };
  }

  /**
   * The books must close: every asset nets to zero across all accounts.
   * A non-zero total means value was created or destroyed.
   */
  totalsByAsset(): Record<string, string> {
    const totals = new Map<string, Amount>();
    for (const account of this.accounts.values()) {
      const balance = this.balancesByAccountId.get(account.id) ?? 0n;
      totals.set(account.assetId, (totals.get(account.assetId) ?? 0n) + balance);
    }
    return Object.fromEntries([...totals].map(([asset, total]) => [asset, formatAmount(total)]));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private canGoNegative(ref: AccountRef): boolean {
    return MemoryLedger.NEGATIVE_ALLOWED.has(ref.ownerType);
  }

  /**
   * An account this post needs that the book does not have yet.
   *
   * Minted into `pending` only. The live maps are written after every entry
   * has passed the funds check, so a refusal cannot leave the account — or a
   * zero balance — behind.
   */
  private stageAccount(ref: AccountRef, pending: Map<string, Account>): Account {
    const key = accountKey(ref);
    const existing = this.accounts.get(key) ?? pending.get(key);
    if (existing) return existing;

    const account: Account = { ...ref, id: crypto.randomUUID(), createdAt: new Date() };
    pending.set(key, account);
    return account;
  }
}

interface HashableTx {
  id: string;
  module: string;
  reason: string;
  postedAt: Date;
  entries: readonly PostedEntry[];
  assetHashes?: Readonly<Record<string, string>>;
  previousAssetHashes?: Readonly<Record<string, string | null>>;
  crossShardAnchor?: string;
}

/**
 * Canonical transaction hash. Field order is fixed and amounts are canonical
 * decimal strings, so the same transaction hashes identically in TypeScript,
 * in Postgres, and in any future Rust port.
 *
 * `assetHashes`, `previousAssetHashes`, and `crossShardAnchor` are covered
 * only when the row stores them. A transaction that omits all three keeps the
 * digest from before those fields existed.
 */
export function hashTx(tx: HashableTx, previousHash: string | null): string {
  const body: {
    id: string;
    module: string;
    reason: string;
    postedAt: string;
    entries: Array<{ accountId: string; assetId: string; direction: PostedEntry['direction']; amount: string }>;
    assetHashes?: Readonly<Record<string, string>>;
    previousAssetHashes?: Readonly<Record<string, string | null>>;
    crossShardAnchor?: string;
  } = {
    id: tx.id,
    module: tx.module,
    reason: tx.reason,
    postedAt: tx.postedAt.toISOString(),
    entries: tx.entries.map((e) => ({
      accountId: e.accountId,
      assetId: e.assetId,
      direction: e.direction,
      amount: formatAmount(e.amount),
    })),
  };
  if (tx.assetHashes !== undefined) body.assetHashes = tx.assetHashes;
  if (tx.previousAssetHashes !== undefined) body.previousAssetHashes = tx.previousAssetHashes;
  if (tx.crossShardAnchor !== undefined) body.crossShardAnchor = tx.crossShardAnchor;

  const canonical = JSON.stringify(body);

  return (
    createHash('sha256')
      .update(previousHash ?? '')
      // Space, not NUL. ledger_tx.hash was written with this byte. Reconcile
      // recomputes it. A second separator would fail every stored row.
      .update(' ')
      .update(canonical)
      .digest('hex')
  );
}
