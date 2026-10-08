import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { decimalSchema, parseAmount } from '../../shared/money';

export const spaceSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    kind: z.enum(['primary', 'named']),
    name: z.string(),
    goalTarget: decimalSchema.nullable(),
    lockedUntil: z.string().datetime({ offset: true }).nullable(),
    balance: decimalSchema,
    ledgerAccount: z.object({ ownerType: z.string(), ownerId: z.string(), assetId: z.string(), kind: z.string() }),
  })
  .refine(
    (space) => space.assetId === space.ledgerAccount.assetId && space.ledgerAccount.kind === 'available',
    'Space account must match its asset and available account',
  );
export type Space = z.infer<typeof spaceSchema>;
export type Holding = { assetId: string; available: string; held: string | null; quantity: string | null };
const balanceEntry = z
  .object({ free: decimalSchema, used: decimalSchema, total: decimalSchema })
  .refine(
    (row) => parseAmount(row.free) + parseAmount(row.used) === parseAmount(row.total),
    'Available and restricted must match the scoped quantity',
  );
const balancesSchema = z.object({
  timestamp: z.number().int(),
  datetime: z.string().datetime({ offset: true }),
  balances: z.record(balanceEntry),
});
const unnamedSchema = z.array(z.object({ assetId: z.string(), balance: decimalSchema }));
export type TransferDraft = { transferId: string; fromSpaceId: string; toSpaceId?: string; toUserId?: string; amount: string };
export function validateTransfer(spaces: Space[], input: TransferDraft): string | null {
  const from = spaces.find((space) => space.id === input.fromSpaceId);
  if (!from) return 'Choose one of your available spaces.';
  if (from.lockedUntil && Date.parse(from.lockedUntil) > Date.now()) return 'This space is locked. Choose an unlocked source.';
  const amount = decimalSchema.safeParse(input.amount);
  if (!amount.success || parseAmount(amount.data) <= 0n) return 'Enter an exact amount greater than zero.';
  if (parseAmount(input.amount) > parseAmount(from.balance)) return 'The amount exceeds the available quantity in this space.';
  if (input.toSpaceId) {
    if (input.toSpaceId === from.id) return 'Choose a different destination space.';
    const destination = spaces.find((space) => space.id === input.toSpaceId);
    if (destination && destination.assetId !== from.assetId) return 'Both spaces must use the same asset.';
    if (!z.string().uuid().safeParse(input.toSpaceId).success) return 'Enter a valid destination space ID.';
  } else if (!input.toUserId?.trim()) return 'Enter the recipient user ID.';
  if (!z.string().uuid().safeParse(input.fromSpaceId).success) return 'Choose a valid source space.';
  return null;
}
export function createMoneyClient(api: ApiClient) {
  return {
    spaces(limit: number, signal?: AbortSignal) {
      return api.query('bank', 'spaces.list', { limit }, z.array(spaceSchema), { signal });
    },
    balances(signal?: AbortSignal) {
      return api.rest('/account/balance', balancesSchema, { signal });
    },
    async overview(ownerId: string, limit: number, signal?: AbortSignal) {
      const [balances, spaces, unnamed] = await Promise.all([
        this.balances(signal),
        this.spaces(limit, signal),
        api.query('bank', 'spaces.unnamed', undefined, unnamedSchema, { signal }),
      ]);
      const projection = new Map<string, string>();
      const conflicts = new Set<string>();
      for (const space of spaces.ok ? spaces.data : []) {
        if (space.kind !== 'primary') continue;
        if (space.ledgerAccount.ownerType !== 'user' || space.ledgerAccount.ownerId !== ownerId) {
          conflicts.add(space.assetId);
          continue;
        }
        const old = projection.get(space.assetId);
        if (old !== undefined && parseAmount(old) !== parseAmount(space.balance)) conflicts.add(space.assetId);
        projection.set(space.assetId, space.balance);
      }
      for (const row of unnamed.ok ? unnamed.data : []) {
        const old = projection.get(row.assetId);
        if (old !== undefined && parseAmount(old) !== parseAmount(row.balance)) conflicts.add(row.assetId);
        else projection.set(row.assetId, row.balance);
      }
      const holdings: Holding[] = balances.ok
        ? Object.entries(balances.data.balances).map(([assetId, row]) => ({
            assetId,
            available: row.free,
            held: row.used,
            quantity: row.total,
          }))
        : [...projection]
            .filter(([assetId]) => !conflicts.has(assetId))
            .map(([assetId, available]) => ({ assetId, available, held: null, quantity: null }));
      return { coverage: 'partial' as const, balances, spaces, unnamed, holdings, conflicts: [...conflicts] };
    },
    transfer(spaces: Space[], input: TransferDraft): Promise<ApiResult<{ ledgerTxId: string; amount: string }>> {
      const message = validateTransfer(spaces, input);
      if (message) return Promise.resolve({ ok: false, reason: 'error', code: 'money.invalid_transfer', message });
      return api.mutate(
        'bank',
        input.toSpaceId ? 'transfers.create' : 'transfers.toUser',
        input,
        z.object({
          ledgerTxId: z.string().min(1),
          amount: decimalSchema.refine(
            (amount) => parseAmount(amount) === parseAmount(input.amount),
            'The settled amount must match the review',
          ),
        }),
      );
    },
  };
}
export type MoneyOverview = Awaited<ReturnType<ReturnType<typeof createMoneyClient>['overview']>>;
