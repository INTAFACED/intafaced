import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { accountForSpace } from '../spaces/space-service.js';
import { assertSelf } from '../assert-self.js';
import { amountString, spaceOutput } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createSpacesRouter(c: BankRouterContext) {
  const { bank } = c;
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16).optional(),
          /**
           * Page size. Optional so omit reaches `bank.spaces_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(z.array(spaceOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          const views = await bank.spaces.overview(userId, input.assetId, input.limit);
          return views.map((v) => ({
            id: v.id,
            assetId: v.assetId,
            kind: v.kind,
            name: v.name,
            goalTarget: v.goalTarget === null ? null : formatAmount(v.goalTarget),
            lockedUntil: v.lockedUntil?.toISOString() ?? null,
            balance: v.balance,
            ledgerAccount: accountForSpace(v),
          }));
        }),
      ),

    /** Assets the user holds with no space yet — sourced from the ledger, not this table. */
    unnamed: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(z.object({ assetId: z.string(), balance: amountString })))
      .query(async ({ ctx }) => guard(async () => bank.spaces.unnamedAssets(ctx.principal.userId))),

    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          name: z.string().min(1).max(64),
          goalTarget: amountString.optional(),
          lockedUntil: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(z.object({ id: z.string(), name: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // Inside the owner's limit on live named spaces; blank refuses `bank.space_limit_unset` (BK-pots-01) before
          // any row, the primary included, is written.
          const space = await bank.spaces.createWithinLimit({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            name: input.name,
            goalTarget: input.goalTarget ? parseAmount(input.goalTarget) : null,
            lockedUntil: input.lockedUntil ? new Date(input.lockedUntil) : null,
          });
          return { id: space.id, name: space.name };
        }),
      ),

    archive: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid() }))
      .output(z.object({ archived: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const space = await bank.spaces.get(input.spaceId);
          assertSelf(ctx.principal.userId, space.userId);
          await bank.spaces.archive(input.spaceId);
          return { archived: true as const };
        }),
      ),

    unarchive: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid() }))
      .output(z.object({ archived: z.literal(false) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const space = await bank.spaces.get(input.spaceId);
          assertSelf(ctx.principal.userId, space.userId);
          await bank.spaces.unarchiveWithinLimit(input.spaceId);
          return { archived: false as const };
        }),
      ),
  });
}
