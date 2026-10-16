import type { Sql } from 'postgres';
import {
  formatAmount,
  houseFees,
  merchantClearing,
  merchantProceeds,
  userAvailable,
  type Amount,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { encodeListCursor } from '../list-page.js';
import type { PayFail } from './common.js';
import { asUuid, assertPortalPageLimit, cursorStamp, portalFilters, stableUuid } from './common.js';

type Reader = Pick<LedgerClient, 'balance' | 'getTxByKey'>;

export interface StatementLine {
  id: string;
  merchantId: string;
  at: string;
  assetId: string;
  kind: 'payment_captured' | 'fee' | 'refund' | 'chargeback' | 'settlement' | 'payout' | 'reserve';
  amount: string;
  account: 'clearing' | 'proceeds' | 'userAvailable' | 'houseFees' | 'payoutHold';
  direction: 'debit' | 'credit';
  runningClearing: string;
  runningProceeds: string;
  paymentId: string | null;
  settlementId: string | null;
  ledgerTxId: string;
}

export interface StatementTie {
  reserve: 'not_booked';
  accounts: Array<{
    assetId: string;
    clearing: { statement: string; ledger: string; matches: boolean };
    proceeds: { statement: string; ledger: string; matches: boolean };
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
}

interface Pots {
  clearing: string;
  proceeds: string;
  personal: string;
  fees: string;
}

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

function draftsFrom(tx: LedgerTx, pots: Pots, settlementId: string | null, merchantId: string): Draft[] {
  const paymentId = metaId(tx, 'paymentId');
  const drafts: Draft[] = [];
  for (const entry of tx.entries) {
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
      });
    }
  }
  return drafts;
}

function apply(balance: Amount, direction: 'debit' | 'credit', amount: Amount): Amount {
  return direction === 'debit' ? balance + amount : balance - amount;
}

function wire(amount: Amount, fail: PayFail): string {
  if (amount < 0n) fail('Statement running balance went negative against a non-negative account', 'pay.invalid_amount');
  return formatAmount(amount);
}

export async function listMerchantStatement(
  sql: Sql,
  ledger: Reader,
  input: { merchantId: string; limit?: number; cursor?: string; assetId?: string; from?: string; to?: string },
  fail: PayFail,
): Promise<{ items: StatementLine[]; nextCursor: string | null; tieOut: StatementTie }> {
  const limit = assertPortalPageLimit(input.limit, 'pay.statement_list_limit_unset', 'merchant.statement.list', fail);
  const filters = portalFilters(input, fail);
  const merchants = await sql<Array<{ user_id: string }>>`SELECT user_id FROM pay.merchants WHERE id = ${input.merchantId}`;
  const userId = merchants[0]?.user_id;
  if (!userId) return fail(`Merchant ${input.merchantId} not found`, 'pay.merchant_not_found');

  const captures = await sql<Array<{ id: string; currency: string }>>`
    SELECT DISTINCT p.id, p.currency
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
     WHERE p.merchant_id = ${input.merchantId} AND e.event = 'captured'`;
  const settlements = await sql<Array<{ id: string; window: string; asset_id: string }>>`
    SELECT id, "window", asset_id FROM pay.settlements WHERE merchant_id = ${input.merchantId}`;
  const refunds = await sql<Array<{ payment_id: string; refund_id: string; currency: string }>>`
    SELECT e.payment_id, e.payload->>'refundId' AS refund_id, p.currency
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
     WHERE p.merchant_id = ${input.merchantId} AND e.event = 'refund.posted'
       AND e.payload->>'refundId' IS NOT NULL`;
  const disputes = await sql<Array<{ dispute_id: string; currency: string }>>`
    SELECT DISTINCT e.payload->>'disputeId' AS dispute_id, p.currency
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
     WHERE p.merchant_id = ${input.merchantId}
       AND e.payload->>'disputeId' IS NOT NULL
       AND e.event IN ('chargeback.opening_planned', 'disputed')`;
  const payouts = await sql<Array<{ settlement_id: string; attempt: number; asset_id: string }>>`
    SELECT settlement_id, attempt, asset_id FROM pay.payout_admissions WHERE merchant_id = ${input.merchantId}`;

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

  const potCache = new Map<string, Pots>();
  const drafts: Draft[] = [];
  for (const candidate of keys) {
    const tx = await ledger.getTxByKey(candidate.key);
    if (!tx) continue;
    let pots = potCache.get(candidate.assetId);
    if (!pots) {
      pots = await potsFor(ledger, input.merchantId, userId, candidate.assetId);
      potCache.set(candidate.assetId, pots);
    }
    drafts.push(...draftsFrom(tx, pots, candidate.settlementId, input.merchantId));
  }

  drafts.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const running = new Map<string, { clearing: Amount; proceeds: Amount }>();
  const lined: Array<Draft & { runningClearing: Amount; runningProceeds: Amount }> = [];
  for (const draft of drafts) {
    const state = running.get(draft.assetId) ?? { clearing: 0n, proceeds: 0n };
    if (draft.account === 'clearing') state.clearing = apply(state.clearing, draft.direction, draft.amount);
    if (draft.account === 'proceeds') state.proceeds = apply(state.proceeds, draft.direction, draft.amount);
    running.set(draft.assetId, state);
    lined.push({ ...draft, runningClearing: state.clearing, runningProceeds: state.proceeds });
  }

  const assetIds = new Set<string>(lined.map((line) => line.assetId));
  if (filters.assetId) assetIds.add(filters.assetId);
  for (const row of captures) assetIds.add(row.currency);
  for (const row of settlements) assetIds.add(row.asset_id);

  const tieAccounts: StatementTie['accounts'] = [];
  for (const assetId of [...assetIds].sort()) {
    if (filters.assetId && assetId !== filters.assetId) continue;
    const state = running.get(assetId) ?? { clearing: 0n, proceeds: 0n };
    const clearingLedger = (await ledger.balance(merchantClearing(input.merchantId, assetId))).amount;
    const proceedsLedger = (await ledger.balance(merchantProceeds(input.merchantId, assetId))).amount;
    tieAccounts.push({
      assetId,
      clearing: {
        statement: wire(state.clearing, fail),
        ledger: formatAmount(clearingLedger),
        matches: state.clearing === clearingLedger,
      },
      proceeds: {
        statement: wire(state.proceeds, fail),
        ledger: formatAmount(proceedsLedger),
        matches: state.proceeds === proceedsLedger,
      },
    });
  }

  const visible = lined.filter((line) => {
    if (filters.assetId && line.assetId !== filters.assetId) return false;
    if (filters.from && line.at < filters.from) return false;
    if (filters.to && line.at >= filters.to) return false;
    return true;
  });
  visible.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const cursor = filters.cursor;
  const afterCursor = cursor
    ? visible.filter((line) => {
        const stamp = cursorStamp(line.at);
        return stamp < cursor.createdAtCursor || (stamp === cursor.createdAtCursor && line.id < cursor.id);
      })
    : visible;
  const page = afterCursor.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = afterCursor.length > limit && last ? encodeListCursor(cursorStamp(last.at), last.id) : null;

  return {
    items: page.map((line) => ({
      id: line.id,
      merchantId: line.merchantId,
      at: line.at.toISOString(),
      assetId: line.assetId,
      kind: line.kind,
      amount: formatAmount(line.amount),
      account: line.account,
      direction: line.direction,
      runningClearing: wire(line.runningClearing, fail),
      runningProceeds: wire(line.runningProceeds, fail),
      paymentId: line.paymentId,
      settlementId: line.settlementId,
      ledgerTxId: line.ledgerTxId,
    })),
    nextCursor,
    tieOut: { reserve: 'not_booked', accounts: tieAccounts },
  };
}
