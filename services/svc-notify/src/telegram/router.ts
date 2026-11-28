import { TRPCError, router } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import {
  NOTIFY_TELEGRAM_LINK_CODE,
  NOTIFY_TELEGRAM_SET_PROFIT_TARGET,
  NOTIFY_TELEGRAM_STATUS,
  NOTIFY_TELEGRAM_UNLINK,
} from '@intafaced/contracts/notify-telegram-procedures';
import { notifyRefusal } from '../record-refusal.js';
import { TelegramDesk, TelegramDeskOffError, TelegramTargetInvalidError } from './desk.js';
import { MemoryTelegramStore } from './store.js';

/** The desk's own refusals, then svc-notify's (an unset link-code lifetime). */
const telegramRefusal: RefusalOf = (err) => {
  if (err instanceof TelegramDeskOffError)
    return { code: err.code, error: new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err }) };
  if (err instanceof TelegramTargetInvalidError)
    return { code: err.code, error: new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err }) };
  return notifyRefusal(err);
};

/** With no desk handed in, the channel is off: every call says `notify.telegram_token_unset`. */
const OFF_DESK = () =>
  new TelegramDesk({
    store: new MemoryTelegramStore(),
    transport: null,
    reader: { read: async () => ({ state: 'off' }) },
    linkCodeTtlMinutes: undefined,
  });

/** `telegram.*`: the account settings' side of the read-only Telegram desk alerts (telegram/desk.ts). */
export function telegramRouter(desk: TelegramDesk = OFF_DESK()) {
  return router({
    status: mountRecord(NOTIFY_TELEGRAM_STATUS, ({ ctx }) => desk.status(ctx.principal.userId), telegramRefusal),
    linkCode: mountRecord(NOTIFY_TELEGRAM_LINK_CODE, ({ ctx }) => desk.issueLinkCode(ctx.principal.userId), telegramRefusal),
    unlink: mountRecord(NOTIFY_TELEGRAM_UNLINK, ({ ctx }) => desk.unlink(ctx.principal.userId), telegramRefusal),
    setProfitTarget: mountRecord(
      NOTIFY_TELEGRAM_SET_PROFIT_TARGET,
      ({ ctx, input }) => desk.setProfitTarget(ctx.principal.userId, input.target),
      telegramRefusal,
    ),
  });
}
