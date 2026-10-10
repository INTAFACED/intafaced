/**
 * Portfolio view — a VIEW over the ledger book plus an indexer half. Not a second book.
 *
 * Law §25:723 / D-S-18: a holding the platform cannot read is ABSENT AND NAMED,
 * never zero. Indexer `positions` is public tRPC keyed by 0x address, not ledger
 * owner UUID. No wallet map lives here, so the chain half is present only when a
 * caller supplies both a usable INDEXER_URL and a 0x `chainAccount` and the
 * fetch returns decimal strings. Anything else is `indexer.portfolio_positions_unwired`.
 * Empty present list is empty, not zero money.
 */
import { z } from 'zod';
import { formatAmount, parseAmount, type Balance, type OwnerType } from '@intafaced/ledger-client';

export const PORTFOLIO_INDEXER_UNWIRED = 'indexer.portfolio_positions_unwired' as const;

export const INDEXER_ABSENT = {
  status: 'absent',
  reason: PORTFOLIO_INDEXER_UNWIRED,
} as const;

export type IndexerAbsent = typeof INDEXER_ABSENT;

export const CHAIN_ACCOUNT_RE = /^0x[0-9a-fA-F]{40}$/;

/** parseAmount, not a second decimal regex. Blank and non-decimals fail. JSON numbers never reach it. */
function isDecimalString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseAmount(value);
    return true;
  } catch {
    return false;
  }
}

export const indexerAbsentSchema = z.object({
  status: z.literal('absent'),
  reason: z.literal(PORTFOLIO_INDEXER_UNWIRED),
});

export const indexerPositionSchema = z.object({
  market: z.string().min(1).max(64),
  /** Signed decimal string — negative is short. Never a JSON number. */
  size: z.string().refine(isDecimalString),
  /** Decimal string. Never a JSON number. */
  entryPrice: z.string().refine(isDecimalString),
});

export const indexerPresentSchema = z.object({
  status: z.literal('present'),
  positions: z.array(indexerPositionSchema),
});

export const indexerHalfSchema = z.union([indexerAbsentSchema, indexerPresentSchema]);

export const custodialHoldingSchema = z.object({
  accountId: z.string(),
  assetId: z.string(),
  kind: z.string(),
  purpose: z.string(),
  /** Decimal string. Money never crosses as a `number`. */
  amount: z.string().refine(isDecimalString),
});

export const portfolioViewSchema = z.object({
  ownerType: z.enum(['user', 'subaccount', 'module', 'house', 'treasury']),
  ownerId: z.string(),
  custodial: z.array(custodialHoldingSchema),
  indexer: indexerHalfSchema,
});

export type CustodialHolding = z.infer<typeof custodialHoldingSchema>;
export type IndexerPosition = z.infer<typeof indexerPositionSchema>;
export type IndexerPresent = z.infer<typeof indexerPresentSchema>;
export type IndexerHalf = z.infer<typeof indexerHalfSchema>;
export type PortfolioView = z.infer<typeof portfolioViewSchema>;

export interface PortfolioViewInput {
  readonly ownerType: OwnerType;
  readonly ownerId: string;
  readonly balances: readonly Balance[];
  /** When omitted, the chain half is named unwired — never a fabricated zero. */
  readonly indexer?: IndexerHalf;
}

/**
 * Map existing ledger balances into a portfolio view. Read-only: does not post.
 * Does not invent chain amounts. Does not fill an empty custodial book.
 * A caller-supplied indexer is parsed with indexerHalfSchema. Omitted or
 * rejected is named absent — never copied, never a zero amount.
 */
export function portfolioViewFromLedgerBalances(input: PortfolioViewInput): PortfolioView {
  const supplied = input.indexer === undefined ? undefined : indexerHalfSchema.safeParse(input.indexer);
  return {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    custodial: input.balances.map((b) => ({
      accountId: b.accountId,
      assetId: b.account.assetId,
      kind: b.account.kind,
      purpose: b.account.purpose ?? '',
      amount: formatAmount(b.amount),
    })),
    indexer: supplied === undefined || !supplied.success ? INDEXER_ABSENT : supplied.data,
  };
}

export interface ResolveIndexerHalfInput {
  readonly url?: string | undefined;
  readonly chainAccount?: string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Trim and accept only http(s) URLs. Garbage env is unwired, not a boot crash. */
export function indexerUrlOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return trimmed.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function positionsFromWire(raw: unknown): IndexerPosition[] | null {
  if (!Array.isArray(raw)) return null;
  const out: IndexerPosition[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    const rec = row as Record<string, unknown>;
    if (typeof rec.market !== 'string' || rec.market.length === 0 || rec.market.length > 64) return null;
    if (!isDecimalString(rec.size) || !isDecimalString(rec.entryPrice)) return null;
    out.push({ market: rec.market, size: rec.size, entryPrice: rec.entryPrice });
  }
  return out;
}

/**
 * HTTP/tRPC to svc-indexer `positions`. Never invents an address. Never coerces
 * a JSON number into a size. Unreachable / malformed / unset → named unwired.
 */
export async function resolveIndexerHalf(input: ResolveIndexerHalfInput): Promise<IndexerHalf> {
  const url = indexerUrlOf(input.url);
  const account = input.chainAccount;
  if (!url || account === undefined || !CHAIN_ACCOUNT_RE.test(account)) return INDEXER_ABSENT;

  const doFetch = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 3_000;
  const target = `${url}/trpc/positions?input=${encodeURIComponent(JSON.stringify({ account }))}`;

  try {
    const response = await doFetch(target, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return INDEXER_ABSENT;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return INDEXER_ABSENT;
    const envelope = body as { error?: unknown; result?: { data?: unknown } };
    if (envelope.error !== undefined && envelope.error !== null) return INDEXER_ABSENT;
    const positions = positionsFromWire(envelope.result?.data);
    if (positions === null) return INDEXER_ABSENT;
    return { status: 'present', positions };
  } catch {
    return INDEXER_ABSENT;
  }
}

export type ComposePortfolioViewInput = PortfolioViewInput & ResolveIndexerHalfInput;

/**
 * Custodial from ledger balances; chain half from an already-resolved indexer
 * payload, or from HTTP when URL + 0x account are both usable.
 */
export async function composePortfolioView(input: ComposePortfolioViewInput): Promise<PortfolioView> {
  const indexer = input.indexer ?? (await resolveIndexerHalf(input));
  return portfolioViewFromLedgerBalances({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    balances: input.balances,
    indexer,
  });
}
