import {
  dexRecurringCancelOutputSchema,
  dexRecurringListOutputSchema,
  dexRecurringOptionsOutputSchema,
  dexRecurringPrepareOutputSchema,
  DEX_AUTH_REFUSALS,
  DEX_ORDER_REFUSALS,
  DEX_RECURRING_REFUSALS,
  dexAuthChallengeOutputSchema,
  dexAuthLogoutOutputSchema,
  dexAuthSessionOutputSchema,
  dexCallsOutputSchema,
  dexOrderCancelOutputSchema,
  dexOrderCreateOutputSchema,
  dexOrderEditPreparedSchema,
  dexOrderHistoryOutputSchema,
  dexOrderListOutputSchema,
  dexOrderPrepareOutputSchema,
  dexOrderViewSchema,
  dexOrdersCountOutputSchema,
  dexSweepOutputSchema,
  dexVaultOutputSchema,
  dexWithdrawOutputSchema,
  type DexAuthChallenge,
  type DexAuthSession,
  type DexOrderState,
} from '@intafaced/contracts/protocol-dex-orders';
import type { z } from 'zod';
import type { ApiClient } from '../../../shared/api';

export type OrderChallenge = DexAuthChallenge;
export type OrderSession = DexAuthSession;

/**
 * svc-dex's wallet orders (D-limit-dca-01 to -04). Every call is a POST: the order session's tokens go in the body, never
 * in a URL. An order-session or order refusal is this call's own answer, never proof that the exchange sign-in ended, so
 * none of them signs the person out of their account.
 */
const keepSessionFor = [...DEX_AUTH_REFUSALS, ...DEX_ORDER_REFUSALS, ...DEX_RECURRING_REFUSALS];

export interface PlaceInput {
  kind: 'sell_above' | 'sell_below' | 'buy_above' | 'buy_below' | 'take_profit_and_stop' | 'bracket' | 'trailing_stop';
  side: 'buy' | 'sell';
  amount: string;
  trigger?: string;
  takeProfit?: string;
  stop?: string;
  trailPercent?: string;
  expiryHours?: string;
}

export function createOrdersApi(api: ApiClient) {
  const call = <T>(procedure: string, input: unknown, schema: z.ZodType<T>) =>
    api.mutate('dex', procedure, input, schema, { keepSessionFor });
  return {
    challenge: (input: { address: string; chainId: number }) => call('auth.challenge', input, dexAuthChallengeOutputSchema),
    verify: (input: { challenge: string; signature: string }) => call('auth.verify', input, dexAuthSessionOutputSchema),
    refresh: (refreshToken: string) => call('auth.refresh', { refreshToken }, dexAuthSessionOutputSchema),
    logout: (accessToken: string) => call('auth.logout', { accessToken }, dexAuthLogoutOutputSchema),
    /** How many orders the wallet has: a count only, no terms (public). */
    count: (wallet: string) => call('orders.count', { wallet }, dexOrdersCountOutputSchema),
    vault: (wallet: string, token?: string) => call('orders.vault', { wallet, ...(token ? { token } : {}) }, dexVaultOutputSchema),
    deposit: (wallet: string, token: string, amount: string) => call('orders.deposit', { wallet, token, amount }, dexCallsOutputSchema),
    withdraw: (wallet: string, token?: string) => call('orders.withdraw', { wallet, ...(token ? { token } : {}) }, dexWithdrawOutputSchema),
    sweep: (accessToken: string, token?: string) =>
      call('orders.sweep', { accessToken, ...(token ? { token } : {}) }, dexSweepOutputSchema),
    prepare: (accessToken: string, input: PlaceInput) => call('orders.prepare', { accessToken, ...input }, dexOrderPrepareOutputSchema),
    create: (accessToken: string, draftId: string, signatures: string[]) =>
      call('orders.create', { accessToken, draftId, signatures }, dexOrderCreateOutputSchema),
    list: (accessToken: string, input: { state?: DexOrderState; cursor?: string }) =>
      call('orders.list', { accessToken, ...input }, dexOrderListOutputSchema),
    history: (accessToken: string, id: string) => call('orders.history', { accessToken, id }, dexOrderHistoryOutputSchema),
    prepareEdit: (accessToken: string, id: string, trigger: string) =>
      call('orders.prepareEdit', { accessToken, id, trigger }, dexOrderEditPreparedSchema),
    update: (accessToken: string, draftId: string, signature: string) =>
      call('orders.update', { accessToken, draftId, signature }, dexOrderViewSchema),
    cancel: (accessToken: string, id: string) => call('orders.cancel', { accessToken, id }, dexOrderCancelOutputSchema),
    recurring: {
      options: (wallet: string) => call('recurring.options', { wallet }, dexRecurringOptionsOutputSchema),
      prepare: (accessToken: string, input: RecurringInput) =>
        call('recurring.prepare', { accessToken, ...input }, dexRecurringPrepareOutputSchema),
      list: (wallet: string, fresh: boolean) => call('recurring.list', { wallet, fresh }, dexRecurringListOutputSchema),
      // Edit and pause always refuse (a plan's terms are fixed on chain): their answer is the refusal, never a parsed body.
      edit: (wallet: string, id: string) => call('recurring.edit', { wallet, id }, dexRecurringCancelOutputSchema),
      pause: (wallet: string, id: string) => call('recurring.pause', { wallet, id }, dexRecurringCancelOutputSchema),
      cancel: (wallet: string, id: string) => call('recurring.cancel', { wallet, id }, dexRecurringCancelOutputSchema),
    },
  };
}
export type OrdersApi = ReturnType<typeof createOrdersApi>;

/** What starting a recurring buy asks for (D-limit-dca-05). */
export interface RecurringInput {
  readonly spend: string;
  readonly buy: string;
  readonly amountEachRound: string;
  readonly rounds: number;
  readonly every: 'hour' | 'day' | 'week';
  readonly lowestPrice?: string;
  readonly highestPrice?: string;
}

/**
 * The order session, one per wallet, kept for this browser tab only (sessionStorage), so moving between steps and
 * reloading the room does not ask the wallet again. It grants placing, changing and cancelling orders within its cap; it
 * cannot move funds. Signing out, or closing the tab, ends it here.
 */
const KEY = 'intafaced.dex.order-session.v1';
function store(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}
function readAll(): Record<string, OrderSession> {
  try {
    const raw = JSON.parse(store()?.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, OrderSession> = {};
    for (const [k, v] of Object.entries(raw)) {
      try {
        out[k] = dexAuthSessionOutputSchema.parse(v);
      } catch {
        // a stored entry of another shape is dropped
      }
    }
    return out;
  } catch {
    return {};
  }
}
function writeAll(all: Record<string, OrderSession>): void {
  try {
    store()?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage refused: the session lasts for this page only.
  }
}
export const rememberedSession = (address: string): OrderSession | undefined => {
  const known = readAll()[address.toLowerCase()];
  return known && Date.parse(known.accessExpiresAt) > Date.now() ? known : undefined;
};
export const rememberSession = (session: OrderSession): void => writeAll({ ...readAll(), [session.wallet.toLowerCase()]: session });
export const forgetSession = (address: string): void => {
  const all = readAll();
  delete all[address.toLowerCase()];
  writeAll(all);
};
