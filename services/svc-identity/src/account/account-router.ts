/**
 * `account.email.*` and `account.phone.*`. Customer sessions only.
 */
import { z } from 'zod';
import { protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { ContactError, type ContactDeps, type ContactLog } from './contact-common.js';
import { EmailChange } from './email-change.js';
import { PhoneChange } from './phone-change.js';

const accepted = z.object({ accepted: z.literal(true) });
const ok = z.object({ ok: z.literal(true) });

export class AccountChange {
  readonly email: EmailChange;
  readonly phone: PhoneChange;
  private readonly deps: ContactDeps;

  constructor(deps: ContactDeps) {
    this.deps = deps;
    this.email = new EmailChange(deps);
    this.phone = new PhoneChange(deps);
  }

  useLog(log: ContactLog): void {
    this.deps.log = log;
  }
}

function delegated(principal: { kid?: string | null; sub_account?: string | null }): boolean {
  return Boolean(principal.kid || principal.sub_account);
}

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof ContactError) {
    const code =
      err.code === 'auth.session_invalid'
        ? 'UNAUTHORIZED'
        : err.code === 'auth.change_unwired' ||
            err.code === 'identity.account_unwired' ||
            err.code === 'identity.phone_missing' ||
            err.code.startsWith('identity.step_up_')
          ? 'PRECONDITION_FAILED'
          : err.code === 'identity.delegated_refused'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST';
    const message = err.code === 'auth.change_unwired' ? err.message : userCopy(err.code);
    throw new TRPCError({ code, message, cause: err });
  }
  throw err;
}

export function createAccountRouter(account: AccountChange | undefined) {
  const email = (): EmailChange => {
    if (!account) throw new ContactError('identity.account_unwired');
    return account.email;
  };
  const phone = (): PhoneChange => {
    if (!account) throw new ContactError('identity.account_unwired');
    return account.phone;
  };

  return router({
    email: router({
      begin: protectedProcedure
        .input(z.object({ newEmail: z.string().max(320), stepUpApprovalId: z.string().guid() }).strict())
        .output(accepted)
        .mutation(async ({ ctx, input }) => {
          try {
            if (delegated(ctx.principal)) throw new ContactError('identity.delegated_refused');
            return await email().begin({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              newEmail: input.newEmail,
              stepUpApprovalId: input.stepUpApprovalId,
            });
          } catch (err) {
            toTrpc(err);
          }
        }),
      confirm: protectedProcedure
        .input(z.object({ code: z.string().min(1).max(200) }).strict())
        .output(ok)
        .mutation(async ({ ctx, input }) => {
          try {
            if (delegated(ctx.principal)) throw new ContactError('identity.delegated_refused');
            return await email().confirm({ userId: ctx.principal.userId, sessionId: ctx.principal.sid, code: input.code });
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
    phone: router({
      begin: protectedProcedure
        .input(z.object({ newPhone: z.string().max(32), stepUpApprovalId: z.string().guid() }).strict())
        .output(accepted)
        .mutation(async ({ ctx, input }) => {
          try {
            if (delegated(ctx.principal)) throw new ContactError('identity.delegated_refused');
            return await phone().begin({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              newPhone: input.newPhone,
              stepUpApprovalId: input.stepUpApprovalId,
            });
          } catch (err) {
            toTrpc(err);
          }
        }),
      confirm: protectedProcedure
        .input(z.object({ code: z.string().min(1).max(200) }).strict())
        .output(ok)
        .mutation(async ({ ctx, input }) => {
          try {
            if (delegated(ctx.principal)) throw new ContactError('identity.delegated_refused');
            return await phone().confirm({ userId: ctx.principal.userId, sessionId: ctx.principal.sid, code: input.code });
          } catch (err) {
            toTrpc(err);
          }
        }),
      remove: protectedProcedure
        .input(z.object({ stepUpApprovalId: z.string().guid() }).strict())
        .output(ok)
        .mutation(async ({ ctx, input }) => {
          try {
            if (delegated(ctx.principal)) throw new ContactError('identity.delegated_refused');
            return await phone().remove({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              stepUpApprovalId: input.stepUpApprovalId,
            });
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
