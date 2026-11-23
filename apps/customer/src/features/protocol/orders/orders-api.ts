import {
  DEX_AUTH_CHALLENGE,
  DEX_AUTH_LOGOUT,
  DEX_AUTH_REFRESH,
  DEX_AUTH_VERIFY,
  DEX_ORDERS_COUNT,
} from '@intafaced/contracts/dex-procedures';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import type { DexAuthChallenge, DexAuthSession } from '@intafaced/contracts/protocol-dex-orders';
import type { ApiClient, AppProcedure } from '../../../shared/api';

export type OrderChallenge = DexAuthChallenge;
export type OrderSession = DexAuthSession;

/**
 * svc-dex's wallet orders (D-limit-dca-01 to -04), each called by its record. Every call is a POST: the order session's
 * tokens go in the body, never in a URL. An order-session refusal is this call's own answer, never proof that the exchange
 * sign-in ended, so none of the refusals its record lists signs the person out of their account.
 */
export function createOrdersApi(api: ApiClient) {
  const call = <R extends AppProcedure>(record: R, input: ProcedureInput<R>) =>
    api.call(record, input, { keepSessionFor: Object.keys(record.refusals) });
  return {
    challenge: (input: { address: string; chainId: number }) => call(DEX_AUTH_CHALLENGE, input),
    verify: (input: { challenge: string; signature: string }) => call(DEX_AUTH_VERIFY, input),
    refresh: (refreshToken: string) => call(DEX_AUTH_REFRESH, { refreshToken }),
    logout: (accessToken: string) => call(DEX_AUTH_LOGOUT, { accessToken }),
    /** How many orders the wallet has: a count only, no terms (public). */
    count: (wallet: string) => call(DEX_ORDERS_COUNT, { wallet }),
  };
}
export type OrdersApi = ReturnType<typeof createOrdersApi>;

/**
 * Order sessions in memory only, one per wallet, so moving between rooms asks the wallet once. Never in browser
 * storage: a reload asks again.
 */
const sessions = new Map<string, OrderSession>();
export const rememberedSession = (address: string): OrderSession | undefined => {
  const known = sessions.get(address.toLowerCase());
  return known && Date.parse(known.accessExpiresAt) > Date.now() ? known : undefined;
};
export const rememberSession = (session: OrderSession): void => void sessions.set(session.wallet.toLowerCase(), session);
export const forgetSession = (address: string): void => void sessions.delete(address.toLowerCase());
