/**
 * Pay yourself from your trading (J-bank-31), the arithmetic Home shows. Every figure is its own source's, with that
 * source's time: the partner's balance as the partner reports it, the venue's withdrawable and locked figures as the
 * venue reports them, the wallet's stablecoins as the chain holds them at one block. Nothing here is a figure of ours.
 * Amounts are exact decimal strings, added as scaled bigints, never a `number`.
 */
import { z } from 'zod';
import { formatAmount, parseAmount } from '../../shared/money';

/**
 * The coins Home counts as spendable today: a dollar stablecoin, or dollars. TESTUSD is the stack's TEST chain stand-in
 * for a dollar stablecoin (services/svc-protocol/scripts/seed-test-chain.ts), held only on test stacks.
 */
export const SPENDABLE_ASSETS: readonly string[] = ['USDC', 'USD', 'TESTUSD'];
/** The asset a pay yourself move withdraws and the partner credits. */
export const PAY_ASSET = 'USDC';

export interface SourceFigure {
  readonly id: 'partner' | 'venue' | 'wallet';
  /** Read: the amount in spendable coins, and the source's own time for it. */
  readonly state: 'read' | 'reading' | 'unread' | 'none';
  readonly amount: string | null;
  readonly asOf: string | null;
}

export interface Spendable {
  readonly parts: readonly SourceFigure[];
  /** The sum of every part read; null while any part is reading or unread (no total is made of a gap). */
  readonly total: string | null;
}

const sumOf = (rows: readonly { asset: string; amount: string }[]): string =>
  formatAmount(rows.filter((r) => SPENDABLE_ASSETS.includes(r.asset)).reduce((sum, r) => sum + parseAmount(r.amount), 0n));

/** One source's spendable figure from its rows (asset, amount) and its time. */
export function sourceFigure(
  id: SourceFigure['id'],
  read: { state: 'read'; asOf: string; rows: readonly { asset: string; amount: string }[] } | { state: 'reading' | 'unread' | 'none' },
): SourceFigure {
  if (read.state !== 'read') return { id, state: read.state, amount: null, asOf: null };
  return { id, state: 'read', amount: sumOf(read.rows), asOf: read.asOf };
}

/** "Spendable now": the partner balance, the venue's withdrawable figure and wallet stablecoins. */
export function spendableNow(parts: readonly SourceFigure[]): Spendable {
  const shown = parts.filter((p) => p.state !== 'none');
  const total = shown.every((p) => p.state === 'read')
    ? formatAmount(shown.reduce((sum, p) => sum + parseAmount(p.amount ?? '0'), 0n))
    : null;
  return { parts: shown, total };
}

/** The venue's figures for the pay asset: what can be withdrawn (free) and what is locked in trades. */
export function venueFigures(rows: readonly { asset: string; free: string; locked: string }[]): { withdrawable: string; locked: string } {
  const row = rows.find((r) => r.asset === PAY_ASSET);
  return { withdrawable: row?.free ?? '0', locked: row?.locked ?? '0' };
}

/** Locked in trades: every spendable coin the venue holds as margin or behind an open order, apart from Spendable now. */
export function lockedInTrades(rows: readonly { asset: string; locked: string }[]): string {
  return formatAmount(rows.filter((r) => SPENDABLE_ASSETS.includes(r.asset)).reduce((sum, r) => sum + parseAmount(r.locked), 0n));
}

/** Why an amount can't be paid, or null when it can: not a positive amount, or above what the venue reports withdrawable. */
export function payRefusal(amount: string, withdrawable: string, fee: string | null): 'amount' | 'above_withdrawable' | null {
  let asked: bigint;
  try {
    asked = parseAmount(amount.trim());
  } catch {
    return 'amount';
  }
  if (asked <= 0n) return 'amount';
  // The venue takes its own fee from the same free balance, so the withdrawable figure must cover both.
  const needed = asked + (fee ? parseAmount(fee) : 0n);
  return needed > parseAmount(withdrawable) ? 'above_withdrawable' : null;
}

/** A pay yourself move's business key: one per move the person asks for, kept until the venue answers definitely. */
export function manualMoveKey(owner: string, askedAt: number): string {
  return `pay-yourself:manual:${owner.toLowerCase()}:${askedAt}`;
}

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** svc-bank `payYourself.summary` (services/svc-bank/src/pay-yourself/pay-yourself.router.ts). */
export const payYourselfSummarySchema = z.object({
  payIn: z.union([
    z.object({
      label: z.literal('TEST'),
      chainId: z.number().int(),
      token: z.string(),
      tokenDecimals: z.number().int(),
      address: z.string(),
      asset: z.string(),
      confirmations: z.number().int(),
    }),
    z.object({ unset: z.string() }),
  ]),
  partnerFee: decimal.nullable(),
  realised: z.union([
    z.object({ since: z.string(), asOf: z.string(), amount: decimal, owner: z.string().nullable() }),
    z.object({ unread: z.string() }),
  ]),
  moves: z.array(
    z.object({
      id: z.string(),
      moveKey: z.string(),
      source: z.enum(['manual', 'rule']),
      assetId: z.string(),
      amount: decimal,
      status: z.enum(['prepared', 'sent']),
      owner: z.string().nullable(),
      venueNonce: z.string().nullable(),
      windowFrom: z.string().nullable(),
      windowTo: z.string().nullable(),
      preparedAt: z.string(),
      sentAt: z.string().nullable(),
    }),
  ),
  credits: z.array(
    z.object({
      key: z.string(),
      txHash: z.string(),
      amount: decimal,
      status: z.enum(['pending', 'available']),
      held: z.boolean(),
      confirmations: z.number().int(),
      required: z.number().int(),
      seenAt: z.string(),
      availableAt: z.string().nullable(),
    }),
  ),
  rule: z
    .object({
      id: z.string(),
      weekday: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
      assetId: z.string(),
      cap: decimal,
      lastRunAt: z.string().nullable(),
      nextRunAt: z.string(),
    })
    .nullable(),
});
export type PayYourselfSummary = z.infer<typeof payYourselfSummarySchema>;
export type PayInCredit = PayYourselfSummary['credits'][number];
export type PayMove = PayYourselfSummary['moves'][number];

/** The pending pay-ins the partner has seen and not credited: on their way, never counted in Spendable now. */
export function onItsWay(credits: readonly PayInCredit[]): PayInCredit[] {
  return credits.filter((c) => c.status === 'pending');
}

/** The partner's pay-in for a done venue withdrawal, matched by the chain transaction that paid it. */
export function creditFor(credits: readonly PayInCredit[], txHash: string | undefined): PayInCredit | null {
  if (!txHash) return null;
  return credits.find((c) => c.txHash === txHash.toLowerCase()) ?? null;
}
