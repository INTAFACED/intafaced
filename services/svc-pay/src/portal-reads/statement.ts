import type { Sql } from 'postgres';
import {
  formatAmount,
  houseFees,
  merchantClearing,
  merchantProceeds,
  userAvailable,
  type AccountRef,
  type Amount,
  type Balance,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { encodeListCursor } from '../list-page.js';
import type { PayFail } from './common.js';
import { asUuid, assertPortalPageLimit, cursorStamp, portalFilters, stableUuid } from './common.js';

type Reader = Pick<LedgerClient, 'balance' | 'getTxByKey'>;

/**
 * Technical safety bounds for one statement request. Not a retention rule,
 * a fee, or a tier. Documented on `listMerchantStatement` and in
 * `services/svc-pay/README.md`.
 */
export const STATEMENT_MAX_SPAN_MS = 92 * 24 * 60 * 60 * 1000;
export const STATEMENT_MAX_CANDIDATE_KEYS = 2000;

export interface StatementLine {
  id: string;
  merchantId: string;
  at: string;
  assetId: string;
  kind: 'payment_captured' | 'fee' | 'refund' | 'chargeback' | 'settlement' | 'payout' | 'reserve';
  amount: string;
  account: 'clearing' | 'proceeds' | 'userAvailable' | 'houseFees' | 'payoutHold';
  direction: 'debit' | 'credit';
  runningClearing: string | null;
  runningProceeds: string | null;
  runningOrder: 'clear' | 'order_ambiguous';
  paymentId: string | null;
  settlementId: string | null;
  ledgerTxId: string;
}

export interface StatementOpening {
  assetId: string;
  clearing: string;
  proceeds: string;
}

export interface StatementTie {
  reserve: 'not_booked';
  accounts: Array<{
    assetId: string;
    clearing: { statement: string | null; ledger: string; matches: boolean | null };
    proceeds: { statement: string | null; ledger: string; matches: boolean | null };
  }>;
}

interface Draft {
  id: string;
  at: Date;
  assetId: string;
  kind: StatementLine['kind'];
  amount: Amount;
  account: StatementLine['account'];
  direction: 'debit' | 'credit';
  paymentId: string | null;
  settlementId: string | null;
  ledgerTxId: string;
  merchantId: string;
  sequence: number | null;
  chainRank: number;
  entryIndex: number;
}

interface Pots {
  clearing: string;
  proceeds: string;
  personal: string;
  fees: string;
}

interface Lined {
  draft: Draft;
  runningClearing: string | null;
  runningProceeds: string | null;
  runningOrder: 'clear' | 'order_ambiguous';
}

type BalanceAsOf = (ref: AccountRef, at: Date) => Promise<Balance>;

function kindFor(reason: string, account: StatementLine['account']): StatementLine['kind'] {
  if (reason === 'payment.captured') return 'payment_captured';
  if (reason === 'pay.settled' && account === 'houseFees') return 'fee';
  if (reason === 'pay.settled') return 'settlement';
  if (reason === 'payment.refunded' || reason === 'payment.refund.reversed') return 'refund';
  if (reason.startsWith('pay.chargeback.')) return 'chargeback';
  return 'payout';
}

function metaId(tx: LedgerTx, key: string): string | null {
  return asUuid(tx.meta[key]);
}

/**
 * `ledger_tx.seq` is the hash-chain position in svc-ledger. LedgerClient does
 * not put it on `LedgerTx`. A client that does expose `seq` or `sequence` is
 * honoured; otherwise the hash chain among the loaded transactions is used.
 */
function ledgerSequence(tx: LedgerTx): number | null {
  const extra = tx as LedgerTx & { sequence?: unknown; seq?: unknown };
  return asSequence(extra.sequence) ?? asSequence(extra.seq);
}

function asSequence(raw: unknown): number | null {
  if (typeof raw === 'bigint' && raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(raw);
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function balanceAsOfOf(ledger: Reader): BalanceAsOf | null {
  const fn = (ledger as Reader & { balanceAsOf?: unknown }).balanceAsOf;
  if (typeof fn !== 'function') return null;
  return fn.bind(ledger) as BalanceAsOf;
}

function chainRanks(txs: readonly LedgerTx[]): Map<string, number> {
  const byHash = new Map<string, LedgerTx>();
  for (const tx of txs) {
    if (!byHash.has(tx.hash)) byHash.set(tx.hash, tx);
  }
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (tx: LedgerTx): number => {
    const known = rank.get(tx.id);
    if (known !== undefined) return known;
    if (visiting.has(tx.id)) return 0;
    visiting.add(tx.id);
    const prev = tx.previousHash ? byHash.get(tx.previousHash) : undefined;
    const value = prev ? walk(prev) + 1 : 0;
    rank.set(tx.id, value);
    visiting.delete(tx.id);
    return value;
  };
  for (const tx of txs) walk(tx);
  return rank;
}

function timestampsWithSequence(drafts: readonly Draft[]): Set<number> {
  const byTime = new Map<number, Draft[]>();
  for (const draft of drafts) {
    const time = draft.at.getTime();
    const group = byTime.get(time);
    if (group) group.push(draft);
    else byTime.set(time, [draft]);
  }
  const ready = new Set<number>();
  for (const [time, group] of byTime) {
    if (group.every((draft) => draft.sequence !== null)) ready.add(time);
  }
  return ready;
}

function sortDrafts(drafts: Draft[]): void {
  const sequenced = timestampsWithSequence(drafts);
  drafts.sort((a, b) => {
    const time = a.at.getTime() - b.at.getTime();
    if (time !== 0) return time;
    if (sequenced.has(a.at.getTime()) && a.sequence !== null && b.sequence !== null && a.sequence !== b.sequence) {
      return a.sequence < b.sequence ? -1 : 1;
    }
    if (a.chainRank !== b.chainRank) return a.chainRank - b.chainRank;
    if (a.ledgerTxId === b.ledgerTxId && a.entryIndex !== b.entryIndex) return a.entryIndex - b.entryIndex;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

async function potsFor(ledger: Reader, merchantId: string, userId: string, assetId: string): Promise<Pots> {
  const [clearing, proceeds, personal, fees] = await Promise.all([
    ledger.balance(merchantClearing(merchantId, assetId)),
    ledger.balance(merchantProceeds(merchantId, assetId)),
    ledger.balance(userAvailable(userId, assetId)),
    ledger.balance(houseFees('pay', assetId)),
  ]);
  return { clearing: clearing.accountId, proceeds: proceeds.accountId, personal: personal.accountId, fees: fees.accountId };
}

function accountOf(pots: Pots, accountId: string): StatementLine['account'] | null {
  if (pots.clearing && accountId === pots.clearing) return 'clearing';
  if (pots.proceeds && accountId === pots.proceeds) return 'proceeds';
  if (pots.personal && accountId === pots.personal) return 'userAvailable';
  if (pots.fees && accountId === pots.fees) return 'houseFees';
  return null;
}

function draftsFrom(
  tx: LedgerTx,
  pots: Pots,
  settlementId: string | null,
  merchantId: string,
  sequence: number | null,
  chainRank: number,
): Draft[] {
  const paymentId = metaId(tx, 'paymentId');
  const drafts: Draft[] = [];
  let entryIndex = 0;
  for (const entry of tx.entries) {
    const index = entryIndex;
    entryIndex += 1;
    const account = accountOf(pots, entry.accountId);
    if (!account) continue;
    if (entry.amount <= 0n) continue;
    drafts.push({
      id: stableUuid(`${tx.id}:${entry.id}`),
      at: tx.postedAt,
      assetId: entry.assetId,
      kind: kindFor(tx.reason, account),
      amount: entry.amount,
      account,
      direction: entry.direction,
      paymentId,
      settlementId,
      ledgerTxId: tx.id,
      merchantId,
      sequence,
      chainRank,
      entryIndex: index,
    });
  }
  if (drafts.length === 0 && (tx.reason === 'pay.proceeds.payout.settled' || tx.reason === 'withdraw.settled')) {
    const entry = tx.entries.find((e) => e.amount > 0n);
    if (entry) {
      drafts.push({
        id: stableUuid(`${tx.id}:payout-hold`),
        at: tx.postedAt,
        assetId: entry.assetId,
        kind: 'payout',
        amount: entry.amount,
        account: 'payoutHold',
        direction: 'credit',
        paymentId,
        settlementId,
        ledgerTxId: tx.id,
        merchantId,
        sequence,
        chainRank,
        entryIndex: 0,
      });
    }
  }
  return drafts;
}

function apply(balance: Amount, direction: 'debit' | 'credit', amount: Amount): Amount {
  return direction === 'debit' ? balance + amount : balance - amount;
}

/**
 * One merchant's ledger statement.
 *
 * `from` and `to` are required (`pay.statement_range_required`). The window
 * is at most 92 days (`pay.statement_range_too_wide`). One request resolves
 * at most 2000 candidate ledger keys (`pay.statement_too_large`). These are
 * technical safety bounds so a read cannot walk every capture, settlement,
 * refund, dispute, and payout the merchant has ever had. They are not a
 * retention rule and not a fee.
 *
 * Running balances sum the lines inside `[from, to)`. The opening balance at
 * `from` is `balanceAsOf` when the ledger client exposes it. svc-ledger does
 * not, so `runningBalances` is `within_range` and `opening` is null.
 *
 * TODO(svc-ledger): replace this candidate-key scan with a cursor endpoint
 * that pages entries by account. See services/svc-pay/README.md.
 *
 * Same-timestamp lines follow the ledger sequence when the client exposes
 * one (`seq` / `sequence`), otherwise hash-chain position (`previousHash`).
 * A reconstructed balance that would go negative flags that line
 * (`runningOrder: order_ambiguous`) and does not fail the page.
 */
export async function listMerchantStatement(
  sql: Sql,
  ledger: Reader,
  input: { merchantId: string; limit?: number; cursor?: string; assetId?: string; from?: string; to?: string },
  fail: PayFail,
): Promise<{
  items: StatementLine[];
  nextCursor: string | null;
  runningBalances: 'within_range' | 'from_opening';
  opening: StatementOpening[] | null;
  tieOut: StatementTie;
}> {
  const limit = assertPortalPageLimit(input.limit, 'pay.statement_list_limit_unset', 'merchant.statement.list', fail);
  const filters = portalFilters(input, fail);
  const from = filters.from;
  const to = filters.to;
  if (from === null || to === null) {
    return fail(
      'merchant.statement.list requires from and to. A statement is one window, not the whole history.',
      'pay.statement_range_required',
    );
  }
  if (to.getTime() - from.getTime() > STATEMENT_MAX_SPAN_MS) {
    return fail('merchant.statement.list covers at most 92 days.', 'pay.statement_range_too_wide');
  }
  const merchants = await sql<Array<{ user_id: string }>>`SELECT user_id FROM pay.merchants WHERE id = ${input.merchantId}`;
  const userId = merchants[0]?.user_id;
  if (!userId) return fail(`Merchant ${input.merchantId} not found`, 'pay.merchant_not_found');

  const captures = await sql<Array<{ id: string; currency: string }>>`
    SELECT DISTINCT p.id, p.currency
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
     WHERE p.merchant_id = ${input.merchantId} AND e.event = 'captured'
       AND e.ts >= ${from} AND e.ts < ${to}`;
  const settlements = await sql<Array<{ id: string; window: string; asset_id: string }>>`
    SELECT id, "window", asset_id FROM pay.settlements
     WHERE merchant_id = ${input.merchantId}
       AND (
         (created_at >= ${from} AND created_at < ${to})
         OR (settled_at >= ${from} AND settled_at < ${to})
         OR (sent_at >= ${from} AND sent_at < ${to})
         OR (failed_at >= ${from} AND failed_at < ${to})
       )`;
  const refunds = await sql<Array<{ payment_id: string; refund_id: string; currency: string }>>`
    SELECT e.payment_id, e.payload->>'refundId' AS refund_id, p.currency
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
     WHERE p.merchant_id = ${input.merchantId} AND e.event = 'refund.posted'
       AND e.payload->>'refundId' IS NOT NULL
       AND e.ts >= ${from} AND e.ts < ${to}`;
  const disputes = await sql<Array<{ dispute_id: string; currency: string }>>`
    SELECT DISTINCT e.payload->>'disputeId' AS dispute_id, p.currency
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
     WHERE p.merchant_id = ${input.merchantId}
       AND e.payload->>'disputeId' IS NOT NULL
       AND e.event IN ('chargeback.opening_planned', 'disputed')
       AND e.ts >= ${from} AND e.ts < ${to}`;
  const payouts = await sql<Array<{ settlement_id: string; attempt: number; asset_id: string }>>`
    SELECT settlement_id, attempt, asset_id FROM pay.payout_admissions
     WHERE merchant_id = ${input.merchantId}
       AND admitted_at >= ${from} AND admitted_at < ${to}`;

  const keys: Array<{ key: string; assetId: string; settlementId: string | null }> = [];
  for (const row of captures) keys.push({ key: `payment.capture:${row.id}`, assetId: row.currency, settlementId: null });
  for (const row of settlements) {
    keys.push({
      key: `settlement:${input.merchantId}:${row.window}:${row.asset_id}`,
      assetId: row.asset_id,
      settlementId: row.id,
    });
  }
  for (const row of refunds) {
    keys.push({ key: `payment.refund:${row.payment_id}:${row.refund_id}`, assetId: row.currency, settlementId: null });
    keys.push({ key: `payment.refund.reverse:${row.payment_id}:${row.refund_id}`, assetId: row.currency, settlementId: null });
  }
  for (const row of disputes) {
    keys.push({ key: `pay.chargeback.open:${row.dispute_id}`, assetId: row.currency, settlementId: null });
    keys.push({ key: `pay.chargeback.won:${row.dispute_id}`, assetId: row.currency, settlementId: null });
  }
  for (const row of payouts) {
    const withdrawalId = `${row.settlement_id}:${row.attempt}`;
    for (const key of [
      `pay.proceeds.payout.hold:${withdrawalId}`,
      `pay.proceeds.payout.settle:${withdrawalId}`,
      `pay.proceeds.payout.reverse:${withdrawalId}`,
      `withdraw.hold:${withdrawalId}`,
      `withdraw.settle:${withdrawalId}`,
      `withdraw.reverse:${withdrawalId}`,
    ]) {
      keys.push({ key, assetId: row.asset_id, settlementId: row.settlement_id });
    }
  }
  if (keys.length > STATEMENT_MAX_CANDIDATE_KEYS) {
    return fail(
      `merchant.statement.list resolves at most ${STATEMENT_MAX_CANDIDATE_KEYS} ledger keys per request.`,
      'pay.statement_too_large',
    );
  }

  const loaded: Array<{ tx: LedgerTx; settlementId: string | null; assetId: string }> = [];
  for (const candidate of keys) {
    const tx = await ledger.getTxByKey(candidate.key);
    if (!tx) continue;
    if (tx.postedAt < from || tx.postedAt >= to) continue;
    loaded.push({ tx, settlementId: candidate.settlementId, assetId: candidate.assetId });
  }
  const ranks = chainRanks(loaded.map((row) => row.tx));

  const potCache = new Map<string, Pots>();
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (const row of loaded) {
    let pots = potCache.get(row.assetId);
    if (!pots) {
      pots = await potsFor(ledger, input.merchantId, userId, row.assetId);
      potCache.set(row.assetId, pots);
    }
    for (const draft of draftsFrom(row.tx, pots, row.settlementId, input.merchantId, ledgerSequence(row.tx), ranks.get(row.tx.id) ?? 0)) {
      if (seen.has(draft.id)) continue;
      seen.add(draft.id);
      drafts.push(draft);
    }
  }

  sortDrafts(drafts);

  const assetIds = new Set<string>(drafts.map((line) => line.assetId));
  if (filters.assetId) assetIds.add(filters.assetId);
  for (const row of captures) assetIds.add(row.currency);
  for (const row of settlements) assetIds.add(row.asset_id);

  const asOf = balanceAsOfOf(ledger);
  const start = new Map<string, { clearing: Amount; proceeds: Amount }>();
  let opening: StatementOpening[] | null = null;
  if (asOf) {
    opening = [];
    for (const assetId of [...assetIds].sort()) {
      const clearing = await asOf(merchantClearing(input.merchantId, assetId), from);
      const proceeds = await asOf(merchantProceeds(input.merchantId, assetId), from);
      if (clearing.amount < 0n || proceeds.amount < 0n) {
        return fail('Statement opening balance was negative against a non-negative account', 'pay.invalid_amount');
      }
      start.set(assetId, { clearing: clearing.amount, proceeds: proceeds.amount });
      opening.push({
        assetId,
        clearing: formatAmount(clearing.amount),
        proceeds: formatAmount(proceeds.amount),
      });
    }
  }

  const running = new Map<string, { clearing: Amount; proceeds: Amount }>();
  const ambiguous = new Set<string>();
  const lined: Lined[] = [];
  for (const draft of drafts) {
    if (ambiguous.has(draft.assetId)) {
      lined.push({ draft, runningClearing: null, runningProceeds: null, runningOrder: 'order_ambiguous' });
      continue;
    }
    const state = running.get(draft.assetId) ?? start.get(draft.assetId) ?? { clearing: 0n, proceeds: 0n };
    const next = { clearing: state.clearing, proceeds: state.proceeds };
    if (draft.account === 'clearing') next.clearing = apply(next.clearing, draft.direction, draft.amount);
    if (draft.account === 'proceeds') next.proceeds = apply(next.proceeds, draft.direction, draft.amount);
    if (next.clearing < 0n || next.proceeds < 0n) {
      ambiguous.add(draft.assetId);
      lined.push({ draft, runningClearing: null, runningProceeds: null, runningOrder: 'order_ambiguous' });
      continue;
    }
    running.set(draft.assetId, next);
    lined.push({
      draft,
      runningClearing: formatAmount(next.clearing),
      runningProceeds: formatAmount(next.proceeds),
      runningOrder: 'clear',
    });
  }

  const runningBalances = asOf ? 'from_opening' : 'within_range';
  const tieAccounts: StatementTie['accounts'] = [];
  for (const assetId of [...assetIds].sort()) {
    if (filters.assetId && assetId !== filters.assetId) continue;
    const state = running.get(assetId) ?? start.get(assetId) ?? { clearing: 0n, proceeds: 0n };
    const clearingLedger = (await ledger.balance(merchantClearing(input.merchantId, assetId))).amount;
    const proceedsLedger = (await ledger.balance(merchantProceeds(input.merchantId, assetId))).amount;
    const statementClearing = ambiguous.has(assetId) ? null : formatAmount(state.clearing);
    const statementProceeds = ambiguous.has(assetId) ? null : formatAmount(state.proceeds);
    const comparable = runningBalances === 'from_opening' && !ambiguous.has(assetId);
    tieAccounts.push({
      assetId,
      clearing: {
        statement: statementClearing,
        ledger: formatAmount(clearingLedger),
        matches: comparable && statementClearing !== null ? statementClearing === formatAmount(clearingLedger) : null,
      },
      proceeds: {
        statement: statementProceeds,
        ledger: formatAmount(proceedsLedger),
        matches: comparable && statementProceeds !== null ? statementProceeds === formatAmount(proceedsLedger) : null,
      },
    });
  }

  const visible = lined.filter((line) => {
    if (filters.assetId && line.draft.assetId !== filters.assetId) return false;
    if (line.draft.at < from || line.draft.at >= to) return false;
    return true;
  });
  visible.sort((a, b) => b.draft.at.getTime() - a.draft.at.getTime() || (a.draft.id < b.draft.id ? 1 : a.draft.id > b.draft.id ? -1 : 0));
  const cursor = filters.cursor;
  const afterCursor = cursor
    ? visible.filter((line) => {
        const stamp = cursorStamp(line.draft.at);
        return stamp < cursor.createdAtCursor || (stamp === cursor.createdAtCursor && line.draft.id < cursor.id);
      })
    : visible;
  const page = afterCursor.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = afterCursor.length > limit && last ? encodeListCursor(cursorStamp(last.draft.at), last.draft.id) : null;

  return {
    items: page.map((line) => ({
      id: line.draft.id,
      merchantId: line.draft.merchantId,
      at: line.draft.at.toISOString(),
      assetId: line.draft.assetId,
      kind: line.draft.kind,
      amount: formatAmount(line.draft.amount),
      account: line.draft.account,
      direction: line.draft.direction,
      runningClearing: line.runningClearing,
      runningProceeds: line.runningProceeds,
      runningOrder: line.runningOrder,
      paymentId: line.draft.paymentId,
      settlementId: line.draft.settlementId,
      ledgerTxId: line.draft.ledgerTxId,
    })),
    nextCursor,
    runningBalances,
    opening,
    tieOut: { reserve: 'not_booked', accounts: tieAccounts },
  };
}
