/**
 * `receiveContacts.list`, `add`, `verify` and `remove` (PP-send-request-03, J-pay-03 #6): the extra email addresses and
 * phone numbers the signed-in owner can be paid by. The owner's own only: the user is the session's, a body never names
 * one. An API key or a sub-account is refused.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { SecurityLockError } from '../auth/security-lock.js';
import { ReceiveContactError, type ReceiveActor, type ReceiveContactService } from './receive-contacts.js';
import {
  IDENTITY_RECEIVE_CONTACTS_LIST,
  IDENTITY_RECEIVE_CONTACTS_ADD,
  IDENTITY_RECEIVE_CONTACTS_VERIFY,
  IDENTITY_RECEIVE_CONTACTS_REMOVE,
} from '@intafaced/contracts/identity-receive-contacts-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

type Principal = { userId: string; sid: string; kid?: string | null; sub_account?: string | null };

function actor(principal: Principal): ReceiveActor {
  return { userId: principal.userId, sessionId: principal.sid, apiKey: Boolean(principal.kid), subAccount: Boolean(principal.sub_account) };
}

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof SecurityLockError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `Your account is security locked [${err.code}]`, cause: err });
  }
  if (err instanceof ReceiveContactError) {
    const code =
      err.code === 'identity.delegated_refused' || err.code === 'auth.account_frozen'
        ? 'FORBIDDEN'
        : err.code === 'identity.session_not_live'
          ? 'UNAUTHORIZED'
          : err.code === 'auth.not_found'
            ? 'NOT_FOUND'
            : err.code === 'identity.receive_contact_unset' ||
                err.code === 'identity.receive_contact_cap_reached' ||
                err.code === 'identity.receive_contact_mail_off' ||
                err.code === 'identity.receive_contact_sms_off' ||
                err.code === 'identity.receive_contact_send_failed'
              ? 'PRECONDITION_FAILED'
              : err.code === 'identity.receive_contact_wait'
                ? 'TOO_MANY_REQUESTS'
                : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    toTrpc(err);
  }
}

export function createReceiveContactsRouter(service: ReceiveContactService) {
  return router({
    receiveContacts: router({
      /** The caller's own addresses to be paid by, proved or waiting for their code, and the published cap. */
      list: mountRecord(
        IDENTITY_RECEIVE_CONTACTS_LIST,
        ({ ctx }) => guarded(() => service.list(actor(ctx.principal as Principal))),
        codedRefusal,
      ),

      /** Add an email or phone and send its code. The sender being off refuses before anything is stored. */
      add: mountRecord(
        IDENTITY_RECEIVE_CONTACTS_ADD,
        ({ ctx, input }) => guarded(() => service.add(actor(ctx.principal as Principal), input)),
        codedRefusal,
      ),

      /** Prove an address with the code sent to it. */
      verify: mountRecord(
        IDENTITY_RECEIVE_CONTACTS_VERIFY,
        ({ ctx, input }) => guarded(() => service.verify(actor(ctx.principal as Principal), input)),
        codedRefusal,
      ),

      /** Stop receiving by an address. */
      remove: mountRecord(
        IDENTITY_RECEIVE_CONTACTS_REMOVE,
        ({ ctx, input }) => guarded(() => service.remove(actor(ctx.principal as Principal), input)),
        codedRefusal,
      ),
    }),
  });
}
