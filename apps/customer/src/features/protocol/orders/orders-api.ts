import {
  DEX_AUTH_REFUSALS,
  dexAuthChallengeOutputSchema,
  dexAuthLogoutOutputSchema,
  dexAuthSessionOutputSchema,
  dexOrdersCountOutputSchema,
  type DexAuthChallenge,
  type DexAuthSession,
} from '@intafaced/contracts/protocol-dex-orders';
import type { z } from 'zod';
import type { ApiClient } from '../../../shared/api';

export type OrderChallenge = DexAuthChallenge;
export type OrderSession = DexAuthSession;

/**
 * svc-dex's wallet orders (D-limit-dca-01 to -04). Every call is a POST: the order session's tokens go in the body, never
 * in a URL. An order-session refusal is this call's own answer, never proof that the exchange sign-in ended, so none of
 * them signs the person out of their account.
 */
const keepSessionFor = DEX_AUTH_REFUSALS;

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
