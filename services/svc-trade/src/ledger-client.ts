import { createHttpLedgerClient, type LedgerClient } from '@intafaced/ledger-client';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { installPreTradeCredit } from './futures/pretrade-credit.js';
import { installPositionMode } from './futures/position-mode.js';
import { installCollateralHaircut } from './futures/collateral-haircut.js';
import { installOverload } from './futures/overload.js';

/** CARD F5 — index.ts loads this client at boot; mill wraps place/open before hold/lock. */
installPreTradeCredit();
/** CARD F6 — explicit one_way / hedge before futuresMarginLock. */
installPositionMode();
/** CARD F8 — owner haircuts; yield/staked refuse; posted margin is not a loan. */
installCollateralHaircut();
/** Overload refuses new risk. Reduce-only and close-position stay. Unset switch is off. */
installOverload();

/**
 * HTTP client for svc-ledger: the one shared client (`createHttpLedgerClient`), signed per attempt over the exact
 * bytes sent (L2-6), with the booked entries on every receipt and a parsed, never cast, acknowledgement.
 *
 * §2: services never touch another service's tables. Every hold, every fill and every release this service performs
 * goes over this client into svc-ledger, which owns the balance graph. It implements the same `LedgerClient`
 * interface the in-memory reference implements, so the money paths in `spot/trade-service.ts` are written once.
 *
 * 25s is the caller deadline inside HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS (hold-outcome.ts), so one call, retries
 * included, never outlasts it. A timeout has no cause.code, so classifyHoldPostError returns unknown and the order
 * stays. A timeout is never a refusal. A retried post is safe: the ledger answers a reused key with the original.
 */
export const LEDGER_CALL_DEADLINE_MS = 25_000;

export function createLedgerClient(baseUrl: string, internalSecret: string): LedgerClient {
  return createHttpLedgerClient({
    baseUrl,
    sign: (payload) => serviceAuthHeadersForBody('svc-trade', internalSecret, payload),
    timeoutMs: LEDGER_CALL_DEADLINE_MS,
    deadlineMs: LEDGER_CALL_DEADLINE_MS,
  });
}
