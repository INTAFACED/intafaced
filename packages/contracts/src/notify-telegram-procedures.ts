import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * svc-notify's read-only Telegram desk alerts, as the app's account settings reach them: the link state, a one-time code
 * the person sends to the bot to link one chat, unlinking, and the weekly profit target the profit-lock alert fires at.
 * The bot itself answers only `/positions` and `/pnl`; it can never trade, cancel or move money.
 *
 * With no bot token on the deployment the channel is off, and every call says so with `notify.telegram_token_unset`.
 */

const base = { service: 'svc-notify', module: 'notify', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'notify:read', module: 'notify' } as const;
const WRITE = { caller: 'scope', scope: 'notify:write', module: 'notify' } as const;

/** Why the channel is off. `notify.out_of_app_off`: the operator's switch for everything that leaves the platform (`NOTIFY_OUT_OF_APP_ENABLED`) is off. */
export const NOTIFY_TELEGRAM_OFF_REASON = z.enum(['notify.telegram_token_unset', 'notify.out_of_app_off']);

const decimal = z.string().regex(/^\d+(\.\d+)?$/);

export const notifyTelegramStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('off'), reason: NOTIFY_TELEGRAM_OFF_REASON }).strict(),
  z.object({ state: z.literal('unlinked'), profitTarget: decimal.nullable() }).strict(),
  z.object({ state: z.literal('linked'), linkedAt: z.string().datetime(), profitTarget: decimal.nullable() }).strict(),
]);
export type NotifyTelegramStatus = z.infer<typeof notifyTelegramStatusSchema>;

const OFF = { 'notify.telegram_token_unset': 'PRECONDITION_FAILED', 'notify.out_of_app_off': 'PRECONDITION_FAILED' } as const;

export const NOTIFY_TELEGRAM_STATUS = defineProcedure({
  ...base,
  name: 'notify.telegram.status',
  kind: 'query',
  path: 'telegram.status',
  access: READ,
  refusals: {},
  input: NO_INPUT,
  output: notifyTelegramStatusSchema,
  samples: [{ verdict: 'accept' }],
});

/**
 * A new one-time link code: the person sends `command` to the bot from the chat they want linked. It works once, until
 * `expiresAt`, and a newer code replaces it. Only its digest is stored.
 */
export const NOTIFY_TELEGRAM_LINK_CODE = defineProcedure({
  ...base,
  name: 'notify.telegram.linkCode',
  kind: 'mutation',
  path: 'telegram.linkCode',
  access: WRITE,
  refusals: { ...OFF, 'notify.verify_ttl_unset': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: z.object({ code: z.string().min(16), command: z.string(), expiresAt: z.string().datetime() }).strict(),
  samples: [{ verdict: 'accept' }],
});

/** Unlinks the person's chat: no alert goes to it and it gets no figures. Unlinking with none linked is a no-op. */
export const NOTIFY_TELEGRAM_UNLINK = defineProcedure({
  ...base,
  name: 'notify.telegram.unlink',
  kind: 'mutation',
  path: 'telegram.unlink',
  access: WRITE,
  refusals: {},
  input: NO_INPUT,
  output: z.object({ unlinked: z.boolean() }).strict(),
  samples: [{ verdict: 'accept' }],
});

/**
 * The week's realised profit, in the perpetual account's collateral asset, at which the profit-lock alert fires once that
 * week; `null` turns it off. A positive decimal.
 */
export const NOTIFY_TELEGRAM_SET_PROFIT_TARGET = defineProcedure({
  ...base,
  name: 'notify.telegram.setProfitTarget',
  kind: 'mutation',
  path: 'telegram.setProfitTarget',
  access: WRITE,
  refusals: { 'notify.telegram_target_invalid': 'BAD_REQUEST' },
  input: z.object({ target: z.string().max(40).nullable() }).strict(),
  output: z.object({ profitTarget: decimal.nullable() }).strict(),
  samples: [
    { verdict: 'accept', input: { target: '250' } },
    { verdict: 'accept', input: { target: null } },
    { verdict: 'refuse', input: { target: 250 } },
  ],
});
