import type { Amount } from '@intafaced/ledger-client';
import type { AccountLine, InflowLine } from './ledger-reads.js';

/**
 * OWN-ACCOUNT MOVES (LB-6). A transaction whose customer lines are one credit on one of their own accounts and one debit on
 * another, of the same coin and amount, is a move between their own accounts: the lot book carries the lots, it does not
 * sell them or open new ones. "Own accounts" are the main available balance and the available balance of each named space
 * the customer owns (svc-bank says which). Lines are paired only inside one transaction: a deposit here and a withdrawal
 * there, in two transactions, are never paired.
 *
 * What is not a move stays what it was: an arrival on the main account is an inflow lot as before, an arrival in a space is an
 * inflow lot in that space, and anything that left a space other than to another own account is not followed (the same as
 * the main account, whose outflows other than sales are not followed either).
 */

export interface OwnMove {
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly amount: Amount;
  /** Null: the main account. */
  readonly from: string | null;
  readonly to: string | null;
}

export interface SpaceInflow extends InflowLine {
  readonly spaceId: string;
}

interface Leg {
  readonly at: string | null;
  /** True: the coins left this account in the transaction; false: they arrived. */
  readonly out: boolean;
  readonly line: InflowLine;
}

export function pairOwnMoves(input: {
  /** Arrivals on the main account that were not fills or own coins coming back. */
  readonly mainInflows: readonly InflowLine[];
  /** What left the main account other than by a fill. */
  readonly mainOutflows: readonly AccountLine[];
  readonly spaceLines: ReadonlyArray<AccountLine & { readonly spaceId: string }>;
}): { moves: OwnMove[]; mainInflows: InflowLine[]; spaceInflows: SpaceInflow[] } {
  const byTx = new Map<string, Leg[]>();
  const add = (at: string | null, out: boolean, line: InflowLine) => {
    const key = `${line.txId}|${line.assetId}`;
    byTx.set(key, [...(byTx.get(key) ?? []), { at, out, line }]);
  };
  // Only transactions that touch a space can be moves; a main-only transaction is never one.
  const spaceTx = new Set(input.spaceLines.map((l) => `${l.txId}|${l.assetId}`));
  for (const l of input.spaceLines) add(l.spaceId, l.direction === 'credit', l);
  for (const l of input.mainOutflows) if (spaceTx.has(`${l.txId}|${l.assetId}`)) add(null, true, l);
  for (const l of input.mainInflows) if (spaceTx.has(`${l.txId}|${l.assetId}`)) add(null, false, l);

  const moves: OwnMove[] = [];
  const paired = new Set<string>();
  for (const [key, legs] of byTx) {
    const out = legs.filter((l) => l.out);
    const into = legs.filter((l) => !l.out);
    if (out.length !== 1 || into.length !== 1) continue;
    const [from, to] = [out[0]!, into[0]!];
    if (from.at === to.at || from.line.amount !== to.line.amount) continue;
    moves.push({
      txId: to.line.txId,
      postedAt: to.line.postedAt,
      assetId: to.line.assetId,
      amount: to.line.amount,
      from: from.at,
      to: to.at,
    });
    paired.add(key);
  }

  const mainInflows = input.mainInflows.filter((l) => !paired.has(`${l.txId}|${l.assetId}`));
  const spaceInflows: SpaceInflow[] = input.spaceLines
    .filter((l) => l.direction === 'debit' && !paired.has(`${l.txId}|${l.assetId}`))
    .map((l) => ({ txId: l.txId, postedAt: l.postedAt, assetId: l.assetId, amount: l.amount, reason: l.reason, spaceId: l.spaceId }));
  moves.sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.txId.localeCompare(b.txId));
  return { moves, mainInflows, spaceInflows };
}
