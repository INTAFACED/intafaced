import { z } from 'zod';
import { formatAmount, parseAmount } from './money.js';
import { rehydrateLedgerHttpError } from './http-errors.js';
import type { LedgerClient } from './client.js';
import type { AccountRef, Balance, LedgerTx, PostRequest, PostedEntry } from './types.js';

/**
 * THE ONE HTTP CLIENT FOR svc-ledger.
 *
 * Nine services each carried their own copy of this file, and the copies had drifted: only svc-p2p had a timeout, only
 * svc-p2p checked what the ledger acknowledged, and none returned the booked entries, so the receipt checks downstream
 * (svc-pay's `postPayLedger`) compared nothing. Every service now builds its client from here:
 *
 *   - body-bound service credentials, signed per attempt over the exact bytes sent (a retry re-signs: fresh timestamp);
 *   - a timeout on every call (a hung ledger must not hold a DB connection forever);
 *   - bounded retries on a network failure, a timeout or a 502/503/504 only. A post is safe to retry because the ledger
 *     answers a reused key with the original transaction, or refuses a different body (`ledger.idempotency_conflict`).
 *     A 4xx or a ledger refusal is never retried;
 *   - the acknowledgement is parsed, not cast: a malformed one is "outcome unknown", never a success;
 *   - the booked `entries` come back on the receipt, so receipt checks compare real accounts and amounts.
 *
 * `sign` is injected (callers pass `serviceAuthHeadersForBody(<service>, secret, payload)`), which keeps this package
 * free of a dependency on `@intafaced/contracts`.
 */

export interface HttpLedgerOptions {
  readonly baseUrl: string;
  /** Headers proving who is calling, for exactly this payload string. */
  readonly sign: (payload: string) => Record<string, string>;
  /** Per-attempt transport budget. Default 15s. */
  readonly timeoutMs?: number;
  /** Extra attempts after the first, for network errors, timeouts and 502/503/504. Default 2, max 5. */
  readonly retries?: number;
  /** First retry delay; doubles each time. Default 150ms. */
  readonly retryBaseDelayMs?: number;
  /** Turn a ledger HTTP refusal into the caller's own error (for example a typed funds refusal). */
  readonly mapError?: (error: Error, failure: { path: string; status: number; detail: string; body: unknown }) => Promise<Error> | Error;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type LedgerTransport = <T>(path: string, body: unknown) => Promise<T>;

const MAX_TIMEOUT_MS = 2_147_483_647;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export const LEDGER_ACK_INVALID_MESSAGE = 'svc-ledger invalid post acknowledgement; outcome unknown';

function assertOptions(options: HttpLedgerOptions): { timeoutMs: number; retries: number; retryBaseDelayMs: number } {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('ledger HTTP timeoutMs must be a positive integer at most 2147483647');
  }
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new RangeError('ledger HTTP retries must be an integer from 0 to 5');
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 150;
  if (!Number.isInteger(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > 60_000) {
    throw new RangeError('ledger HTTP retryBaseDelayMs must be an integer from 0 to 60000');
  }
  return { timeoutMs, retries, retryBaseDelayMs };
}

/** Signed, timed, retried POST of a JSON body to one svc-ledger path. Callers add their own typed endpoints on top. */
export function createLedgerTransport(options: HttpLedgerOptions): LedgerTransport {
  const { timeoutMs, retries, retryBaseDelayMs } = assertOptions(options);
  const url = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async function call<T>(path: string, body: unknown): Promise<T> {
    // Serialised ONCE: the same string is signed and sent. Signing JSON.stringify(body) and letting fetch re-serialise
    // would digest bytes the server never sees (a 401 that reproduces only under some key orders).
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= retries;
      let response: Response;
      try {
        response = await doFetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.sign(payload) },
          body: payload,
          // Stays armed while the body is read below.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (last) throw error;
        await sleep(retryBaseDelayMs * 2 ** attempt);
        continue;
      }

      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch (error) {
          if (last) throw error;
          await sleep(retryBaseDelayMs * 2 ** attempt);
          continue;
        }
      }

      const detail = await response.text().catch(() => '');
      if (RETRYABLE_STATUS.has(response.status) && !last) {
        await sleep(retryBaseDelayMs * 2 ** attempt);
        continue;
      }
      // Keep the ledger's own error: 'ledger.insufficient_funds', 'ledger.frozen' and 'ledger.idempotency_conflict' mean
      // different things to a caller, and "request failed" would make all of them unactionable.
      const error = rehydrateLedgerHttpError(path, response.status, detail);
      throw options.mapError ? await options.mapError(error, { path, status: response.status, detail, body }) : error;
    }
  };
}

const postedEntryWire = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  txId: z.string().min(1),
  accountId: z.string().min(1),
  assetId: z.string().min(1),
  direction: z.enum(['debit', 'credit']),
  amount: z.string().min(1),
  balanceAfter: z.string().min(1),
});

const postAckWire = z.object({
  txId: z.string().refine((s) => s.trim() !== '', 'txId'),
  hash: z.string().refine((s) => s.trim() !== '', 'hash'),
  postedAt: z.string(),
  // Absent from an older svc-ledger: the receipt then carries no entries, as before.
  entries: z.array(postedEntryWire).optional(),
});

const balanceWire = z.object({ accountId: z.string(), amount: z.string() });
const balancesWire = z.array(z.object({ accountId: z.string(), assetId: z.string(), kind: z.string(), amount: z.string() }));

/** What `post` sends: amounts as decimal strings, never JS numbers and never bigint. */
export function ledgerPostWire(request: PostRequest) {
  return {
    idempotencyKey: request.idempotencyKey,
    module: request.module,
    reason: request.reason,
    meta: request.meta ?? {},
    correlationId: request.correlationId,
    entries: request.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
  };
}

/** Parse an acknowledgement; a malformed one is an unknown outcome, never a success. */
export function parseLedgerPostAck(request: PostRequest, raw: unknown): LedgerTx {
  const parsed = postAckWire.safeParse(raw);
  if (!parsed.success) throw new Error(LEDGER_ACK_INVALID_MESSAGE);
  const ack = parsed.data;
  // handleS2sPost publishes Date.toISOString(): reject normalised impossible dates and arbitrary Date.parse strings.
  const postedAt = new Date(ack.postedAt);
  if (!Number.isFinite(postedAt.getTime()) || postedAt.toISOString() !== ack.postedAt) throw new Error(LEDGER_ACK_INVALID_MESSAGE);
  let entries: PostedEntry[];
  try {
    entries = (ack.entries ?? []).map((e) => ({
      id: e.id,
      txId: e.txId,
      accountId: e.accountId,
      assetId: e.assetId,
      direction: e.direction,
      amount: parseAmount(e.amount),
      balanceAfter: parseAmount(e.balanceAfter),
    }));
  } catch {
    throw new Error(LEDGER_ACK_INVALID_MESSAGE);
  }
  return {
    id: ack.txId,
    idempotencyKey: request.idempotencyKey,
    module: request.module,
    reason: request.reason,
    meta: request.meta ?? {},
    postedAt,
    hash: ack.hash,
    previousHash: null,
    entries,
  };
}

/** The `LedgerClient` every service uses to reach svc-ledger. `getTx` and `getTxByKey` are not exposed over the S2S door. */
export function createHttpLedgerClient(options: HttpLedgerOptions): LedgerClient {
  const call = createLedgerTransport(options);
  return {
    async post(request: PostRequest): Promise<LedgerTx> {
      return parseLedgerPostAck(request, await call<unknown>('/trpc/post', ledgerPostWire(request)));
    },

    async balance(ref: AccountRef): Promise<Balance> {
      const result = balanceWire.parse(await call<unknown>('/trpc/balance', ref));
      return { account: ref, accountId: result.accountId, amount: parseAmount(result.amount) };
    },

    async balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]> {
      const result = balancesWire.parse(await call<unknown>('/trpc/balances', { ownerType, ownerId }));
      return result.map((b) => ({
        account: { ownerType, ownerId, assetId: b.assetId, kind: b.kind as AccountRef['kind'] },
        accountId: b.accountId,
        amount: parseAmount(b.amount),
      }));
    },

    async getTx(): Promise<LedgerTx | null> {
      throw new Error('getTx is not exposed over the internal ledger API — query svc-ledger directly');
    },

    async getTxByKey(): Promise<LedgerTx | null> {
      throw new Error('getTxByKey is not exposed over the internal ledger API — re-drive the idempotent recipe instead');
    },
  };
}
