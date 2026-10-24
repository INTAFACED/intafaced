import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  admitNewOrderWhileFrozen,
  createSqlTradeIdentityStore,
  fillsForOrderWhileFrozen,
  replaceRevokedSessionWithFrozenRead,
  requestAccountDeletion,
  setSubAccountFrozen,
  TradeIdentityAuthError,
  type CloseBook,
  type OwnFill,
} from './trade-identity-auth.js';

function toTradeTrpc(err: unknown): never {
  if (err instanceof TradeIdentityAuthError) {
    const code =
      err.code === 'auth.not_found' || err.code === 'auth.fill_not_found'
        ? 'NOT_FOUND'
        : err.code === 'auth.sub_account_frozen_param'
          ? 'BAD_REQUEST'
          : err.code === 'auth.close_book_unwired' || err.code === 'auth.frozen_fills_unwired'
            ? 'PRECONDITION_FAILED'
            : 'FORBIDDEN';
    throw new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err });
  }
  throw err instanceof Error ? err : new Error('Trade identity auth failed');
}

/**
 * Doors for the trade identity slice. The book and the fill reader are
 * optional on purpose: absent means the named refusal, never a flat book
 * or a made-up fill. svc-trade is not this module.
 */
export function createTradeIdentityAuthRouter(
  sql: Sql,
  deps: {
    tokens: TokenConfig;
    readBook?: (userId: string) => Promise<CloseBook>;
    readFill?: (userId: string, orderId: string) => Promise<OwnFill | null>;
  },
) {
  const store = createSqlTradeIdentityStore(sql);
  return router({
    subAccountFrozen: router({
      set: scopedProcedure('identity:write')
        .input(z.object({ subAccountId: z.string().guid(), frozen: z.union([z.literal(0), z.literal(1)]) }))
        .output(z.object({ id: z.string().guid(), frozen: z.union([z.literal(0), z.literal(1)]), changed: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          try {
            if (ctx.principal.sub_account) {
              throw new TradeIdentityAuthError('A freeze call needs the parent API key', 'auth.parent_key_required');
            }
            return await setSubAccountFrozen(store, {
              parentUserId: ctx.principal.userId,
              parentApiKeyId: ctx.principal.kid ?? null,
              subAccountId: input.subAccountId,
              frozen: input.frozen,
            });
          } catch (err) {
            toTradeTrpc(err);
          }
        }),
    }),
    accountClose: router({
      request: scopedProcedure('identity:write')
        .output(
          z.object({
            completed: z.boolean(),
            status: z.enum(['active', 'frozen', 'closed']),
            code: z.string().nullable(),
            blockedBy: z.string().nullable(),
            orderHold: z.string(),
            debited: z.literal(false),
            apiKeysRevoked: z.number().int(),
            makerKeyCanPlace: z.boolean(),
            repeated: z.boolean(),
          }),
        )
        .mutation(async ({ ctx }) => {
          try {
            const userId = ctx.principal.userId;
            const book = deps.readBook ? await deps.readBook(userId) : null;
            return await requestAccountDeletion(store, { userId, book });
          } catch (err) {
            toTradeTrpc(err);
          }
        }),
    }),
    frozenRead: router({
      open: scopedProcedure('trade:read')
        .input(z.object({ revokedSessionId: z.string().guid() }))
        .output(
          z.object({
            sessionId: z.string().guid(),
            accessToken: z.string(),
            expiresAt: z.string(),
            scopes: z.array(z.string()),
            readOnly: z.literal(true),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const opened = await replaceRevokedSessionWithFrozenRead(store, {
              userId: ctx.principal.userId,
              revokedSessionId: input.revokedSessionId,
            });
            const issued = await issueAccessToken(
              { userId: ctx.principal.userId, sessionId: opened.sessionId, scopes: opened.scopes, tier: 'none', mfa: false },
              deps.tokens,
            );
            return {
              sessionId: opened.sessionId,
              accessToken: issued.token,
              expiresAt: issued.expiresAt.toISOString(),
              scopes: [...opened.scopes],
              readOnly: true as const,
            };
          } catch (err) {
            toTradeTrpc(err);
          }
        }),
      fillsForOrder: scopedProcedure('trade:read')
        .input(z.object({ orderId: z.string().guid() }))
        .output(z.object({ id: z.string(), orderId: z.string().guid(), userId: z.string().guid(), qty: z.string() }))
        .query(async ({ ctx, input }) => {
          try {
            const user = await store.getUser(ctx.principal.userId);
            return await fillsForOrderWhileFrozen({
              userId: ctx.principal.userId,
              orderId: input.orderId,
              scopes: ctx.principal.scopes,
              accountStatus: user?.status ?? 'active',
              readFill: deps.readFill ?? null,
            });
          } catch (err) {
            toTradeTrpc(err);
          }
        }),
      place: scopedProcedure('trade:read')
        .output(z.object({ admitted: z.literal(false), code: z.literal('auth.account_frozen') }))
        .mutation(async ({ ctx }) => {
          try {
            const user = await store.getUser(ctx.principal.userId);
            return admitNewOrderWhileFrozen(user?.status ?? 'active');
          } catch (err) {
            toTradeTrpc(err);
          }
        }),
    }),
  });
}
