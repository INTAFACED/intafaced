import { z } from 'zod';
import {
  router,
  scopedProcedure,
  serviceProcedureFor,
  BANK_OWN_SPACES_CALLERS,
  bankOwnSpacesInputSchema,
  bankOwnSpacesSchema,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { accountForSpace, lockEnd, type SpaceRecord } from '../spaces/space-service.js';
import { assertSelf } from '../assert-self.js';
import { amountString, spaceOutput } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

/**
 * A pot's goal and lock as the customer sees them now (BK-pots-02). An early unlock that has taken effect shows no lock;
 * one still waiting shows the lock date and when it opens.
 */
function potState(space: SpaceRecord, now: Date) {
  const end = lockEnd(space, now);
  const waiting = end !== null && space.unlocksAt !== null;
  return {
    goalTarget: space.goalTarget === null ? null : formatAmount(space.goalTarget),
    lockedUntil: space.unlocksAt && !waiting ? null : (space.lockedUntil?.toISOString() ?? null),
    unlocksAt: waiting ? space.unlocksAt!.toISOString() : null,
    unlockRequestedAt: waiting ? space.unlockRequestedAt!.toISOString() : null,
  };
}

const potStateOutput = z.object({
  id: z.string(),
  goalTarget: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  unlocksAt: z.string().nullable(),
  unlockRequestedAt: z.string().nullable(),
});

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
          const now = new Date();
          return views.map((v) => ({
            id: v.id,
            assetId: v.assetId,
            kind: v.kind,
            name: v.name,
            ...potState(v, now),
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

    /** Set, change or clear the goal of one of the caller's pots (BK-pots-02). A target, never a holding: nothing moves. */
    setGoal: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid(), goalTarget: amountString.nullable() }))
      .output(potStateOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const pot = await bank.spaces.setGoal(
            input.spaceId,
            ctx.principal.userId,
            input.goalTarget === null ? null : parseAmount(input.goalTarget),
          );
          return { id: pot.id, ...potState(pot, new Date()) };
        }),
      ),

    /**
     * Lock one of the caller's pots until a later date, or keep it locked for longer (BK-pots-02). Debits from a locked
     * pot refuse `bank.space_locked`. An earlier date refuses `bank.space_change_invalid`: that is an early unlock.
     */
    setLock: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid(), lockedUntil: z.string().datetime({ offset: true }) }))
      .output(potStateOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const now = new Date();
          const pot = await bank.spaces.setLock(input.spaceId, ctx.principal.userId, new Date(input.lockedUntil), now);
          return { id: pot.id, ...potState(pot, now) };
        }),
      ),

    /**
     * The owner confirms they want a locked pot opened before its date (BK-pots-02). It opens after the owner-set wait
     * (`BANK_SPACE_UNLOCK_WAIT_HOURS`, blank refuses `bank.space_unlock_rule_unset`); until then debits still refuse.
     * Asking again while one waits returns the same opening time.
     */
    requestUnlock: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid() }))
      .output(potStateOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const now = new Date();
          const pot = await bank.spaces.requestUnlock(input.spaceId, ctx.principal.userId, now);
          return { id: pot.id, ...potState(pot, now) };
        }),
      ),

    /** Withdraw an early unlock still waiting; the pot stays locked to its date (BK-pots-02). */
    cancelUnlock: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid() }))
      .output(potStateOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const now = new Date();
          const pot = await bank.spaces.cancelUnlock(input.spaceId, ctx.principal.userId, now);
          return { id: pot.id, ...potState(pot, now) };
        }),
      ),

    /**
     * Every named space this customer ever owned, archived ones too, so svc-tax can follow the customer's own coins between
     * their main account and their spaces (PF-cost-basis-02, LB-6). Service-only: `serviceProcedureFor` proves the caller is
     * svc-tax before the input is parsed. Names and ids, never a balance. A read; a POST only because the caller signs the body.
     */
    ownedAccounts: serviceProcedureFor(BANK_OWN_SPACES_CALLERS)
      .input(bankOwnSpacesInputSchema)
      .output(bankOwnSpacesSchema)
      .mutation(async ({ input }) =>
        guard(async () => ({
          spaces: (await bank.spaces.allNamedSpaces(input.userId)).map((s) => ({
            spaceId: s.id,
            assetId: s.assetId,
            name: s.name,
            archived: s.archivedAt !== null,
          })),
        })),
      ),
  });
}
