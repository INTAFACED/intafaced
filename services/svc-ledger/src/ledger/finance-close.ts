/**
 * G-finance (PTX-M23-R03, PTX-M23-R07).
 * Client vs corporate assets distinct. Finance close refuses incomplete recipes.
 * No misleading PoR. Do not invent a reserve. svc-trade is not recut.
 */

import { z } from 'zod';

export const FINANCE_KINDS = ['segregation', 'close', 'por'] as const;
export type FinanceKind = (typeof FINANCE_KINDS)[number];

export const CLIENT_CORPORATE_COMMINGLED = 'ledger.finance.client_corporate_commingled' as const;
export const OWNERS_UNNAMED = 'ledger.finance.owners_unnamed' as const;
export const RECIPES_INCOMPLETE = 'ledger.finance.recipes_incomplete' as const;
export const POR_MISLEADING = 'ledger.finance.por_misleading' as const;
export const RESERVE_INVENTED = 'ledger.finance.reserve_invented' as const;

export type FinanceRefuseReason =
  typeof CLIENT_CORPORATE_COMMINGLED | typeof OWNERS_UNNAMED | typeof RECIPES_INCOMPLETE | typeof POR_MISLEADING | typeof RESERVE_INVENTED;

export type FinanceRefusal = {
  readonly ok: false;
  readonly reason: FinanceRefuseReason;
  readonly kind: FinanceKind;
  readonly missing: readonly string[];
  readonly included: readonly string[];
  readonly detail: string;
};

export type FinanceOk = {
  readonly ok: true;
  readonly kind: FinanceKind;
  readonly complete: boolean;
  readonly clientOwnerId: string;
  readonly corporateOwnerId: string;
  readonly included: readonly string[];
};

export type FinanceResult = FinanceOk | FinanceRefusal;

const CLOSE_RECIPES = ['clientBalances', 'corporateBalances'] as const;

export const financeCloseInputSchema = z.object({
  kind: z.enum(FINANCE_KINDS),
  complete: z.boolean().optional(),
  clientOwnerId: z.string().optional(),
  corporateOwnerId: z.string().optional(),
  commingle: z.boolean().optional(),
  periodId: z.string().optional(),
  recipes: z.array(z.string()).optional(),
  inventReserve: z.boolean().optional(),
  reserveAmount: z.string().nullable().optional(),
  reserveRecipeId: z.string().optional(),
  claimFullyReserved: z.boolean().optional(),
});

function text(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

function refuse(
  kind: FinanceKind,
  reason: FinanceRefuseReason,
  missing: readonly string[],
  included: readonly string[],
  detail: string,
): FinanceRefusal {
  return { ok: false, reason, kind, missing, included, detail };
}

function present(input: z.infer<typeof financeCloseInputSchema>): string[] {
  const included: string[] = [];
  if (text(input.clientOwnerId)) included.push('clientOwnerId');
  if (text(input.corporateOwnerId)) included.push('corporateOwnerId');
  if (text(input.periodId)) included.push('periodId');
  if (text(input.reserveRecipeId)) included.push('reserveRecipeId');
  for (const recipe of input.recipes ?? []) {
    if (text(recipe) && !included.includes(recipe)) included.push(recipe);
  }
  return included;
}

export function refuseIncompleteFinance(input: z.infer<typeof financeCloseInputSchema>): FinanceResult {
  const included = present(input);
  const client = text(input.clientOwnerId);
  const corporate = text(input.corporateOwnerId);

  if (input.inventReserve === true || (input.reserveAmount !== undefined && input.reserveAmount !== null && !text(input.reserveRecipeId))) {
    return refuse(input.kind, RESERVE_INVENTED, ['reserveRecipeId'], included, 'finance will not invent a reserve');
  }

  if (input.commingle === true || (client !== null && corporate !== null && client === corporate)) {
    return refuse(input.kind, CLIENT_CORPORATE_COMMINGLED, [], included, 'client and corporate assets stay distinct');
  }

  const claiming = input.complete === true || input.kind === 'close' || input.kind === 'por' || input.claimFullyReserved === true;

  if (input.kind === 'segregation' && (!client || !corporate)) {
    return refuse(
      input.kind,
      OWNERS_UNNAMED,
      [!client ? 'clientOwnerId' : '', !corporate ? 'corporateOwnerId' : ''].filter((id) => id.length > 0),
      included,
      'client and corporate owners were not named',
    );
  }

  if (claiming) {
    const missing: string[] = [];
    if (!client) missing.push('clientOwnerId');
    if (!corporate) missing.push('corporateOwnerId');
    if (input.kind !== 'segregation' && !text(input.periodId)) missing.push('periodId');
    const recipes = new Set((input.recipes ?? []).map((r) => r.trim()).filter((r) => r.length > 0));
    for (const recipe of CLOSE_RECIPES) {
      if (!recipes.has(recipe)) missing.push(recipe);
    }
    if (missing.length > 0) {
      return refuse(input.kind, RECIPES_INCOMPLETE, missing, included, `finance ${input.kind} refuses — recipes incomplete`);
    }
  }

  if (input.kind === 'por' && input.claimFullyReserved === true) {
    return refuse(
      'por',
      POR_MISLEADING,
      ['reserveRecipeId'],
      included,
      'PoR will not claim fully reserved without an owner reserve recipe',
    );
  }

  if (!client || !corporate) {
    return refuse(
      input.kind,
      OWNERS_UNNAMED,
      [!client ? 'clientOwnerId' : '', !corporate ? 'corporateOwnerId' : ''].filter((id) => id.length > 0),
      included,
      'client and corporate owners were not named',
    );
  }

  return {
    ok: true,
    kind: input.kind,
    complete: input.complete === true,
    clientOwnerId: client,
    corporateOwnerId: corporate,
    included,
  };
}

export function handleFinanceClose(body: unknown): FinanceResult {
  return refuseIncompleteFinance(financeCloseInputSchema.parse(body));
}
