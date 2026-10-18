import { decimalSchema, parseAmount } from '../../shared/money';

/** What the card service says its programme is. A card can only be ordered or changed on a live programme. */
export type ProgrammeInfo = { id: string; simulated: boolean } | null;

/** The channels the card service lets a customer switch on or off, card by card. */
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

export type CardType = 'virtual' | 'physical';

/** What the customer types for a delivery address. Blank optional lines are left out of the request. */
export type AddressDraft = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};
export const EMPTY_ADDRESS: AddressDraft = { name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '' };
export const REQUIRED_ADDRESS_LINES = ['name', 'line1', 'city', 'postalCode', 'country'] as const;

/** Which delivery lines are missing or wrong. The country is a two-letter code, as the card service requires. */
export function addressProblems(draft: AddressDraft): Partial<Record<keyof AddressDraft, 'required' | 'country'>> {
  const problems: Partial<Record<keyof AddressDraft, 'required' | 'country'>> = {};
  for (const key of REQUIRED_ADDRESS_LINES) if (draft[key].trim() === '') problems[key] = 'required';
  if (!problems.country && !/^[A-Za-z]{2}$/.test(draft.country.trim())) problems.country = 'country';
  return problems;
}

/** The delivery address exactly as the card service stores it: trimmed, the country in capitals, blank lines left out. */
export function wireAddress(draft: AddressDraft) {
  const line2 = draft.line2.trim();
  const region = draft.region.trim();
  return {
    name: draft.name.trim(),
    line1: draft.line1.trim(),
    ...(line2 ? { line2 } : {}),
    city: draft.city.trim(),
    ...(region ? { region } : {}),
    postalCode: draft.postalCode.trim(),
    country: draft.country.trim().toUpperCase(),
  };
}

/** The exact request for `cards.issue`. The request id doubles as the card id so a retry is the same card. */
export function buildIssueInput(
  requestId: string,
  values: { assetId?: string; perAuthorizationLimit?: string; cardType?: CardType; address?: AddressDraft },
) {
  return {
    cardId: requestId,
    assetId: (values.assetId ?? '').trim(),
    perAuthorizationLimit: (values.perAuthorizationLimit ?? '').trim(),
    ...(values.cardType === 'physical' && values.address
      ? { cardType: 'physical' as const, shippingAddress: wireAddress(values.address) }
      : {}),
  };
}

function sameAddress(returned: unknown, sent: unknown): boolean {
  if (!returned || typeof returned !== 'object' || !sent || typeof sent !== 'object') return false;
  const a = returned as Record<string, unknown>;
  const b = sent as Record<string, unknown>;
  return (
    (['name', 'line1', 'city', 'postalCode', 'country'] as const).every((key) => a[key] === b[key]) &&
    (a.line2 ?? null) === (b.line2 ?? null) &&
    (a.region ?? null) === (b.region ?? null)
  );
}

/** The reply to an order must be the one card that was asked for, with the asked-for asset, limit and delivery address to the digit. */
export function issuedMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const card = data as Record<string, unknown>;
  const physical = input.cardType === 'physical';
  return (
    typeof card.id === 'string' &&
    typeof input.cardId === 'string' &&
    card.id.toLowerCase() === input.cardId.toLowerCase() &&
    card.assetId === input.assetId &&
    card.status === 'active' &&
    typeof card.perAuthorizationLimit === 'string' &&
    typeof input.perAuthorizationLimit === 'string' &&
    decimalSchema.safeParse(card.perAuthorizationLimit).success &&
    parseAmount(card.perAuthorizationLimit) === parseAmount(input.perAuthorizationLimit) &&
    (physical ? card.cardType === 'physical' && sameAddress(card.shippingAddress, input.shippingAddress) : card.cardType !== 'physical')
  );
}
