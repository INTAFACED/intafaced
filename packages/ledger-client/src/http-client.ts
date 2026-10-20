import { z } from 'zod';
import { formatAmount, parseAmount } from './money.js';
import { rehydrateLedgerHttpError } from './http-errors.js';
import { stampPostAttempts } from './post-outcome.js';
import type { LedgerClient } from './client.js';
import type { AccountRef, Balance, LedgerTx, PostRequest, PostedEntry } from './types.js';

/**
 * THE ONE HTTP CLIENT FOR svc-ledger.
 *
 * Nine services each carried their own copy of this file, and the copies had drifted: only svc-p2p had a timeout, only
 * svc-p2p checked what the ledger acknowledged, and none returned the booked entries, so the receipt checks downstream
 * (svc-pay's `postPayLedger`) compared nothing. This is the one client services build from. Adoption is per service and
 * still in progress, so some services keep their own copy until they switch. A client built from here has:
 *
 *   - body-bound service credentials, signed per attempt over the exact bytes sent (a retry re-signs: fresh timestamp);
 *   - a timeout on every call (a hung ledger must not hold a DB connection forever);
 *   - bounded retries on a network failure, a timeout or a 502/503/504 only. A post is safe to retry because the ledger
 *     answers a reused key with the original transaction, or refuses a different body (`ledger.idempotency_conflict`).
 *     A 4xx or a ledger refusal is never retried;
 *   - the acknowledgement is parsed, not cast: a malformed one is "outcome unknown", never a success;
 *   - the booked `entries` come back on the receipt, so receipt checks compare real accounts and amounts;
 *   - `getTx` and `getTxByKey` through the read-only `txById` and `txByKey` doors, validated, never a guess.
 *
 * `sign` is injected (callers pass `serviceAuthHeadersForBody(<service>, secret, payload)`), which keeps this package
 * free of a dependency on `@intafaced/contracts`.
 */

export interface LedgerSignRequest {
  readonly method: 'POST';
  readonly url: URL;
  readonly contentType: 'application/json';
}

export interface HttpLedgerOptions {
  readonly baseUrl: string;
  /**
   * Headers proving who is calling, for exactly this payload string. The second argument says what is being sent
   * (method, the URL fetched, the content type), which a key-signed call covers. A callback that takes only the
   * payload keeps working.
   */
  readonly sign: (payload: string, request: LedgerSignRequest) => Record<string, string>;
  /** Per-attempt transport budget. Default 15s. */
  readonly timeoutMs?: number;
  /** Extra attempts after the first, for network errors, timeouts and 502/503/504. Default 2, max 5. */
  readonly retries?: number;
  /** First retry delay; doubles each time. Default 150ms. */
  readonly retryBaseDelayMs?: number;
  /**
   * Total budget in ms for ONE call across every attempt and backoff. Default none (only the per-attempt `timeoutMs`
   * and `retries` bound a call, so the worst case is roughly `(retries + 1) * timeoutMs` plus the backoffs).
   *
   * Callers that post while holding their own DB row locks should set it: an unbounded retry loop keeps those locks,
   * and the connection, held for as long as the ledger is unwell. Once the budget is spent the call stops retrying and
   * throws the last error; an attempt never runs with a timeout longer than what is left, and no attempt starts when
   * its backoff would already outlast the budget. Positive integer.
   */
  readonly deadlineMs?: number;
  /** Turn a ledger HTTP refusal into the caller's own error (for example a typed funds refusal). */
  readonly mapError?: (error: Error, failure: { path: string; status: number; detail: string; body: unknown }) => Promise<Error> | Error;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type LedgerTransport = <T>(path: string, body: unknown) => Promise<T>;

const MAX_TIMEOUT_MS = 2_147_483_647;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export const LEDGER_ACK_INVALID_MESSAGE = 'svc-ledger invalid post acknowledgement; outcome unknown';

function assertOptions(options: HttpLedgerOptions): {
  timeoutMs: number;
  retries: number;
  retryBaseDelayMs: number;
  deadlineMs: number | undefined;
} {
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
  const deadlineMs = options.deadlineMs;
  if (deadlineMs !== undefined && (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_TIMEOUT_MS)) {
    throw new RangeError('ledger HTTP deadlineMs must be a positive integer at most 2147483647');
  }
  return { timeoutMs, retries, retryBaseDelayMs, deadlineMs };
}

/** Signed, timed, retried POST of a JSON body to one svc-ledger path. Callers add their own typed endpoints on top. */
export function createLedgerTransport(options: HttpLedgerOptions): LedgerTransport {
  const { timeoutMs, retries, retryBaseDelayMs, deadlineMs } = assertOptions(options);
  const url = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async function call<T>(path: string, body: unknown): Promise<T> {
    // Serialised ONCE: the same string is signed and sent. Signing JSON.stringify(body) and letting fetch re-serialise
    // would digest bytes the server never sees (a 401 that reproduces only under some key orders).
    const payload = JSON.stringify(body);
    const startedAt = Date.now();
    const remainingMs = () => (deadlineMs === undefined ? Infinity : deadlineMs - (Date.now() - startedAt));
    // Back off before the next attempt, or give up with `error` when the attempt budget or the call's deadline says no.
    // `error` is lazy: the status path only builds its rehydrated error when it is actually thrown.
    const backoff = async (attempt: number, error: () => Promise<Error> | Error | unknown): Promise<void> => {
      const delay = retryBaseDelayMs * 2 ** attempt;
      // A retry after `delay` must still have time left to run; otherwise it cannot finish and only holds the caller.
      if (attempt >= retries || remainingMs() <= delay) throw await error();
      await sleep(delay);
      if (remainingMs() <= 0) throw await error();
    };

    // How many attempts had started when the call gave up. Stamped on the thrown error (`POST_ATTEMPTS_FIELD`) so
    // `classifyPostOutcome` can tell "the only attempt was refused" from "the last of several was".
    let attempts = 0;
    try {
      return await runAttempts();
    } catch (error) {
      stampPostAttempts(error, attempts);
      throw error;
    }

    async function runAttempts(): Promise<T> {
      for (let attempt = 0; ; attempt += 1) {
        attempts = attempt + 1;
        const attemptTimeoutMs = Math.min(timeoutMs, remainingMs());
        if (attemptTimeoutMs <= 0) throw new Error(`svc-ledger call to ${path} exceeded its ${deadlineMs}ms deadline`);
        let response: Response;
        try {
          const target = `${url}${path}`;
          response = await doFetch(target, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...options.sign(payload, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
            },
            body: payload,
            // Stays armed while the body is read below.
            signal: AbortSignal.timeout(attemptTimeoutMs),
          });
        } catch (error) {
          await backoff(attempt, () => error);
          continue;
        }

        if (response.ok) {
          try {
            return (await response.json()) as T;
          } catch (error) {
            await backoff(attempt, () => error);
            continue;
          }
        }

        const detail = await response.text().catch(() => '');
        const refusal = async () => {
          // Keep the ledger's own error: 'ledger.insufficient_funds', 'ledger.frozen' and 'ledger.idempotency_conflict' mean
          // different things to a caller, and "request failed" would make all of them unactionable.
          const error = rehydrateLedgerHttpError(path, response.status, detail);
          return options.mapError ? await options.mapError(error, { path, status: response.status, detail, body }) : error;
        };
        if (!RETRYABLE_STATUS.has(response.status)) throw await refusal();
        await backoff(attempt, refusal);
      }
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
const balancesWire = z.array(
  z.object({
    accountId: z.string(),
    assetId: z.string(),
    kind: z.string(),
    // Account identity (P0-3): dropping it would merge two holds the book keeps apart. '' means none. Optional so an
    // older ledger that predates the field still parses.
    purpose: z.string().optional(),
    amount: z.string(),
  }),
);

const nonBlank = (what: string) => z.string().refine((s) => s.trim() !== '', what);

const txByIdWire = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    txId: nonBlank('txId'),
    idempotencyKey: nonBlank('idempotencyKey'),
    hash: nonBlank('hash'),
    postedAt: z.string(),
    module: z.string(),
    reason: z.string(),
    entries: z
      .array(
        z.object({
          accountId: z.string().min(1),
          assetId: z.string().min(1),
          direction: z.enum(['debit', 'credit']),
          amount: z.string().min(1),
        }),
        // The ledger never books fewer than two legs (assertBalanced): fewer is a partial or legacy answer, and a caller
        // that skips its receipt check on an empty entry list would read it as a found, verified transaction.
      )
      .min(2),
  }),
]);

const txByKeyWire = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    txId: nonBlank('txId'),
    hash: nonBlank('hash'),
    postedAt: z.string(),
    module: z.string(),
    reason: z.string(),
  }),
]);

/** The ledger publishes `Date.toISOString()`: reject normalised impossible dates and arbitrary `Date.parse` strings. */
function parseIsoInstant(value: string): Date | null {
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.toISOString() === value ? at : null;
}

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

/**
 * Parse an acknowledgement; a malformed one is an unknown outcome, never a success.
 *
 * `entries` carry `balanceAfter` for EVERY account the transaction touched, counterparties included, so this receipt
 * is for internal service-to-service use only: never forward it to an end user or a partner.
 */
export function parseLedgerPostAck(request: PostRequest, raw: unknown): LedgerTx {
  const parsed = postAckWire.safeParse(raw);
  if (!parsed.success) throw new Error(LEDGER_ACK_INVALID_MESSAGE);
  const ack = parsed.data;
  const postedAt = parseIsoInstant(ack.postedAt);
  if (!postedAt) throw new Error(LEDGER_ACK_INVALID_MESSAGE);
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

const LOOKUP_INVALID_MESSAGE = 'svc-ledger answered a transaction lookup malformed';

/** `null` is only ever an explicit `{found:false}`: anything unreadable throws, because null would read as "never booked". */
function lookupError(path: string, detail: string): Error {
  return new Error(`${LOOKUP_INVALID_MESSAGE} (${path}: ${detail})`);
}

/** The `LedgerClient` services reach svc-ledger through (adoption is per service; see the header). */
export function createHttpLedgerClient(options: HttpLedgerOptions): LedgerClient {
  const call = createLedgerTransport(options);

  /** Lookup by id through `/trpc/txById`. Entries come back without `id` and `balanceAfter` (the door does not carry them). */
  async function getTx(txId: string): Promise<LedgerTx | null> {
    const parsed = txByIdWire.safeParse(await call<unknown>('/trpc/txById', { txId }));
    if (!parsed.success) throw lookupError('/trpc/txById', parsed.error.issues[0]?.message ?? 'invalid');
    const result = parsed.data;
    if (!result.found) return null;
    if (result.txId !== txId) throw lookupError('/trpc/txById', 'answered a different txId');
    const postedAt = parseIsoInstant(result.postedAt);
    if (!postedAt) throw lookupError('/trpc/txById', 'postedAt is not an ISO instant');
    let entries: PostedEntry[];
    try {
      entries = result.entries.map((e) => ({
        // Not carried by the door; no caller reads them.
        id: '',
        txId: result.txId,
        accountId: e.accountId,
        assetId: e.assetId,
        direction: e.direction,
        amount: parseAmount(e.amount),
        balanceAfter: 0n,
      }));
    } catch (error) {
      throw lookupError('/trpc/txById', error instanceof Error ? error.message : 'bad amount');
    }
    return {
      id: result.txId,
      idempotencyKey: result.idempotencyKey,
      module: result.module,
      reason: result.reason,
      meta: {},
      postedAt,
      hash: result.hash,
      previousHash: null,
      entries,
    };
  }

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
        account: {
          ownerType,
          ownerId,
          assetId: b.assetId,
          kind: b.kind as AccountRef['kind'],
          // '' (or absent, from an older ledger) means no purpose.
          ...(b.purpose ? { purpose: b.purpose } : {}),
        },
        accountId: b.accountId,
        amount: parseAmount(b.amount),
      }));
    },

    getTx,

    /**
     * Existence check by idempotency key. `/trpc/txByKey` answers only the identifying fields, so a hit is chained to
     * `/trpc/txById` and the result carries the real entries. Not booked is `null`; a ledger that finds the key and
     * then cannot find its transaction, or finds one under another key, is contradicting itself and throws.
     */
    async getTxByKey(idempotencyKey: string): Promise<LedgerTx | null> {
      const parsed = txByKeyWire.safeParse(await call<unknown>('/trpc/txByKey', { idempotencyKey }));
      if (!parsed.success) throw lookupError('/trpc/txByKey', parsed.error.issues[0]?.message ?? 'invalid');
      if (!parsed.data.found) return null;
      const tx = await getTx(parsed.data.txId);
      if (!tx) {
        throw new Error(`svc-ledger inconsistent: txByKey found ${parsed.data.txId} for the key but txById did not`);
      }
      if (tx.idempotencyKey !== idempotencyKey) {
        throw new Error(
          `svc-ledger inconsistent: txByKey found ${parsed.data.txId} for the key but txById says it was booked under another key`,
        );
      }
      return tx;
    },
  };
}
