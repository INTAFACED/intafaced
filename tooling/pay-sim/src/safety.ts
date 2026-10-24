export interface Options {
  readonly iterations: number;
  readonly timeoutMs: number;
  readonly databaseUrl: string;
}

/**
 * How long dropping a run's own TEST database may take once its connection is open (database.ts). DROP DATABASE waits
 * for a forced checkpoint, which on a busy shared test server (a CI shard dropping many databases) is slow.
 */
export const CLEANUP_DROP_MS = 9_000;
/** The cleanup connection's own connect wait, inside the cleanup budget. */
export const CLEANUP_CONNECT_S = 3;
/** The CLI watchdog's margin past the deadline: startup (module import), the cleanup connect and the drop. */
export const WATCHDOG_MARGIN_MS = 5_000 + CLEANUP_CONNECT_S * 1000 + CLEANUP_DROP_MS;

/** Cancels SQL clients on expiry; checks surround every effect, including cleanup-bound setup. */
export class Deadline {
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private expired = false;

  constructor(
    timeoutMs: number,
    private readonly close: () => Promise<void>,
  ) {
    this.expiresAt = Date.now() + timeoutMs;
    this.timer = setTimeout(() => {
      this.cancel();
    }, timeoutMs);
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.expired) return;
    this.expired = true;
    void this.close().catch(() => undefined);
  }

  check(): void {
    if (this.expired || Date.now() >= this.expiresAt) throw new Error('pay-sim deadline exceeded; stopping TEST DATA work');
  }

  async step<T>(effect: () => Promise<T>): Promise<T> {
    this.check();
    const result = await effect();
    this.check();
    return result;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** No live connections, implicit environment, or unbounded runs. Values are TEST VALUES. */
export function parseOptions(args: readonly string[], env: Record<string, string | undefined>): Options {
  if (env.APP_ENV !== 'test') throw new Error('pay-sim requires explicit APP_ENV=test');
  const databaseUrl = env.TEST_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(databaseUrl ?? '');
  } catch {
    throw new Error('pay-sim requires local PostgreSQL database ending _test');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error('pay-sim requires local PostgreSQL database ending _test (no connection overrides)');
  }
  let iterations = 1;
  let timeoutMs = 60_000;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!['--iterations', '--timeout-ms'].includes(key) || seen.has(key) || !value || !/^\d+$/.test(value)) {
      throw new Error('Invalid, unknown or repeated simulator option');
    }
    seen.add(key);
    const n = Number(value);
    const max = key === '--iterations' ? 100 : 120_000;
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${key} must be between 1 and ${max}`);
    if (key === '--iterations') iterations = n;
    else timeoutMs = n;
  }
  return { iterations, timeoutMs, databaseUrl: databaseUrl! };
}

interface Entry {
  readonly assetId: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: bigint;
}
export function assertLedgerBalanced(journal: readonly { readonly entries: readonly Entry[] }[]): void {
  for (const tx of journal) {
    const totals = new Map<string, bigint>();
    for (const e of tx.entries) totals.set(e.assetId, (totals.get(e.assetId) ?? 0n) + (e.direction === 'credit' ? e.amount : -e.amount));
    for (const [asset, net] of totals) if (net !== 0n) throw new Error(`Ledger unbalanced for ${asset}: ${net}`);
  }
}

export interface Outbound {
  readonly idempotencyKey: string;
  readonly assetId: string;
  readonly amount: bigint;
  readonly to: string;
}
export function assertOutbound(actual: readonly Outbound[], expected: readonly Outbound[]): void {
  const byKey = new Map(actual.map((t) => [t.idempotencyKey, t]));
  if (actual.length !== expected.length || byKey.size !== actual.length) throw new Error('Missing, extra or duplicate outbound transfer');
  for (const want of expected) {
    const got = byKey.get(want.idempotencyKey);
    if (!got || got.amount !== want.amount || got.assetId !== want.assetId || got.to !== want.to) {
      throw new Error(`Wrong outbound transfer: ${want.idempotencyKey}`);
    }
  }
}
