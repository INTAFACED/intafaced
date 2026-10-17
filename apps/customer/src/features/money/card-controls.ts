import { decimalSchema, parseAmount } from '../../shared/money';

/** What the card service says its programme is. A card can only be ordered or changed on a live programme. */
export type ProgrammeInfo = { id: string; simulated: boolean } | null;

/** The channels a customer expects to switch per card. The card service has no procedure for them yet. */
export const CARD_CHANNELS = ['online', 'contactless', 'atm', 'abroad'] as const;
export type CardChannel = (typeof CARD_CHANNELS)[number];

/** True only for a real issuer: `none` means no issuer, `simulated` means no real card exists anywhere. */
export function cardsLive(programme: ProgrammeInfo): boolean {
  return programme !== null && !programme.simulated && programme.id !== 'none';
}

export type OrderBlock = 'loading' | 'none' | 'simulated' | 'noAssets' | null;
/** Why ordering is not possible right now, or null when it is. Order of the checks is the order of what to fix. */
export function orderBlock(programme: ProgrammeInfo | undefined, heldAssetCount: number | undefined): OrderBlock {
  if (programme === undefined || heldAssetCount === undefined) return 'loading';
  if (programme === null || programme.id === 'none') return 'none';
  if (programme.simulated) return 'simulated';
  if (heldAssetCount === 0) return 'noAssets';
  return null;
}

/** "•••• 1234" for a four-digit tail, and nothing invented for anything else. */
export function maskedPan(panTail: string): string {
  return /^\d{4}$/.test(panTail) ? `•••• ${panTail}` : '••••';
}

export function limitProblem(value: string): 'invalid' | 'zero' | null {
  if (!decimalSchema.safeParse(value).success) return 'invalid';
  return parseAmount(value) > 0n ? null : 'zero';
}

/** The exact request for `cards.issue`. The request id doubles as the card id so a retry is the same card. */
export function buildIssueInput(requestId: string, values: { assetId?: string; perAuthorizationLimit?: string }) {
  return {
    cardId: requestId,
    assetId: (values.assetId ?? '').trim(),
    perAuthorizationLimit: (values.perAuthorizationLimit ?? '').trim(),
  };
}

/** The reply to an order must be the one card that was asked for, with the asked-for asset and limit to the digit. */
export function issuedMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const card = data as Record<string, unknown>;
  return (
    typeof card.id === 'string' &&
    typeof input.cardId === 'string' &&
    card.id.toLowerCase() === input.cardId.toLowerCase() &&
    card.assetId === input.assetId &&
    card.status === 'active' &&
    typeof card.perAuthorizationLimit === 'string' &&
    typeof input.perAuthorizationLimit === 'string' &&
    decimalSchema.safeParse(card.perAuthorizationLimit).success &&
    parseAmount(card.perAuthorizationLimit) === parseAmount(input.perAuthorizationLimit)
  );
}
