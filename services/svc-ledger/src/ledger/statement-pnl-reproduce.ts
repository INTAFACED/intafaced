/**
 * G-statements-happy (PTX-M14-R05). When lots exist, statements reproduce
 * through the mill compose. Missing lots keep the B5 refuse. History/cash
 * are not cost basis. Mill statement-pnl.ts is not recut. svc-trade is not.
 */

import type { Balance } from '@intafaced/ledger-client';
import { z } from 'zod';
import { composeStatementPnl, type StatementPnlFacts, type StatementPnlOwner, type StatementPnlResult } from './statement-pnl.js';
import { handleStatementPnlFromBook, refuseInventedCostBasis, statementPnlBookInputSchema } from './statement-pnl-book.js';

const decimalString = z.string({
  error: (issue) => (issue.input === undefined ? undefined : 'JS number refused — amounts are decimal strings'),
});

const closedLotSchema = z.object({
  assetId: z.string().min(1),
  costBasis: decimalString.nullable(),
  proceeds: decimalString.nullable(),
});

const openLotSchema = z.object({
  assetId: z.string().min(1),
  qtyRemaining: decimalString,
  costBasis: decimalString.nullable(),
});

export const statementPnlReproduceInputSchema = statementPnlBookInputSchema.extend({
  lots: z
    .object({
      closed: z.array(closedLotSchema),
      open: z.array(openLotSchema),
    })
    .optional(),
  marks: z.record(z.string(), decimalString).optional(),
  navInputs: z.object({ cashReporting: decimalString }).optional(),
});

export function factsWhenLotsExist(input: {
  readonly lots?: {
    readonly closed: readonly { assetId: string; costBasis: string | null; proceeds: string | null }[];
    readonly open: readonly { assetId: string; qtyRemaining: string; costBasis: string | null }[];
  };
  readonly marks?: Readonly<Record<string, string>>;
  readonly navInputs?: { readonly cashReporting: string };
}): StatementPnlFacts | null {
  if (input.lots === undefined) return null;
  return {
    lots: { status: 'present', value: input.lots },
    marks: input.marks !== undefined ? { status: 'present', value: input.marks } : { status: 'absent' },
    navInputs: input.navInputs !== undefined ? { status: 'present', value: input.navInputs } : { status: 'absent' },
  };
}

/** Same lots in, same statement out. Mill compose — no invented basis. */
export function reproduceStatementPnl(owner: StatementPnlOwner, facts: StatementPnlFacts): StatementPnlResult {
  return composeStatementPnl(owner, facts);
}

export async function handleStatementPnlHappyOrRefuse(
  ledger: {
    balances(ownerType: StatementPnlOwner['ownerType'], ownerId: string): Promise<readonly Balance[]>;
  },
  body: unknown,
): Promise<StatementPnlResult> {
  const input = statementPnlReproduceInputSchema.parse(body);
  const owner: StatementPnlOwner = {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    reportingAssetId: input.reportingAssetId,
  };
  const invented = refuseInventedCostBasis(owner, input);
  if (invented) return invented;

  const facts = factsWhenLotsExist(input);
  if (!facts) return handleStatementPnlFromBook(ledger, body);

  return reproduceStatementPnl(owner, facts);
}
