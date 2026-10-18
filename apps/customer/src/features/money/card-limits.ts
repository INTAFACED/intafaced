import { decimalSchema, parseAmount } from '../../shared/money';

/** The four spending ceilings a card carries. A blank ceiling is `null`: no cap of that kind, never zero. */
export const LIMIT_KEYS = ['perAuthorizationLimit', 'dailyLimit', 'monthlyLimit', 'cashLimit'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export const CHANNEL_KEYS = ['online', 'contactless', 'atm', 'abroad'] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export type CardLimits = {
  perAuthorizationLimit: string;
  dailyLimit: string | null;
  monthlyLimit: string | null;
  cashLimit: string | null;
};
export type CardChannels = Record<ChannelKey, boolean>;

/** A limit the customer typed: an exact decimal above zero. A blank optional limit means "no cap". */
export function limitValueProblem(value: string | undefined, optional: boolean): 'invalid' | 'zero' | null {
  const text = (value ?? '').trim();
  if (text === '') return optional ? null : 'invalid';
  if (!decimalSchema.safeParse(text).success) return 'invalid';
  return parseAmount(text) > 0n ? null : 'zero';
}

const clean = (value: string | undefined): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};

/** The exact request for `cards.setLimits`. The command id is the request id, so a resend is the same change. */
export function buildLimitsInput(cardId: string, commandId: string, values: Partial<Record<LimitKey, string>>) {
  return {
    cardId,
    commandId,
    perAuthorizationLimit: (values.perAuthorizationLimit ?? '').trim(),
    dailyLimit: clean(values.dailyLimit),
    monthlyLimit: clean(values.monthlyLimit),
    cashLimit: clean(values.cashLimit),
  };
}

export type LimitMove = 'same' | 'lower' | 'higher' | 'added' | 'removed';
/** How one ceiling moves. Raising or removing a cap loosens the card; adding or lowering one tightens it. */
export function limitMove(current: string | null, next: string | null): LimitMove {
  if (current === null && next === null) return 'same';
  if (current === null) return 'added';
  if (next === null) return 'removed';
  const a = parseAmount(current);
  const b = parseAmount(next);
  return b === a ? 'same' : b > a ? 'higher' : 'lower';
}

export function limitMoves(card: CardLimits, next: CardLimits): Record<LimitKey, LimitMove> {
  return {
    perAuthorizationLimit: limitMove(card.perAuthorizationLimit, next.perAuthorizationLimit),
    dailyLimit: limitMove(card.dailyLimit, next.dailyLimit),
    monthlyLimit: limitMove(card.monthlyLimit, next.monthlyLimit),
    cashLimit: limitMove(card.cashLimit, next.cashLimit),
  };
}

/** True when any ceiling goes up or comes off. The bank may ask for an extra security confirmation then. */
export function loosensCard(card: CardLimits, next: CardLimits): boolean {
  return Object.values(limitMoves(card, next)).some((move) => move === 'higher' || move === 'removed');
}

export function limitsUnchanged(card: CardLimits, next: CardLimits): boolean {
  return Object.values(limitMoves(card, next)).every((move) => move === 'same');
}

const same = (a: string | null, b: string | null) => limitMove(a, b) === 'same';

/** The reply to a limits change must be the one card that was asked about, with every ceiling as reviewed to the digit. */
export function limitsMatch(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const card = data as Record<string, unknown>;
  const text = (value: unknown): value is string => typeof value === 'string' && decimalSchema.safeParse(value).success;
  const slot = (value: unknown): string | null | undefined => (value === null ? null : text(value) ? value : undefined);
  const returned = LIMIT_KEYS.map((key) => [slot(card[key]), slot(input[key])] as const);
  return (
    typeof card.id === 'string' &&
    typeof input.cardId === 'string' &&
    card.id.toLowerCase() === input.cardId.toLowerCase() &&
    returned.every(([a, b]) => a !== undefined && b !== undefined && same(a, b)) &&
    text(card.perAuthorizationLimit)
  );
}

/** Reads the limits off a card record. */
export function limitsOf(card: CardLimits): CardLimits {
  return {
    perAuthorizationLimit: card.perAuthorizationLimit,
    dailyLimit: card.dailyLimit,
    monthlyLimit: card.monthlyLimit,
    cashLimit: card.cashLimit,
  };
}

/** The exact request for `cards.setChannels`: all four switches, with the one the customer flipped changed. */
export function buildChannelsInput(cardId: string, commandId: string, channels: CardChannels, flipped: ChannelKey, on: boolean) {
  return { cardId, commandId, ...channels, [flipped]: on } as { cardId: string; commandId: string } & CardChannels;
}

export function channelsOf(card: CardChannels): CardChannels {
  return { online: card.online, contactless: card.contactless, atm: card.atm, abroad: card.abroad };
}

export function channelsMatch(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const card = data as Record<string, unknown>;
  return (
    typeof card.id === 'string' &&
    typeof input.cardId === 'string' &&
    card.id.toLowerCase() === input.cardId.toLowerCase() &&
    CHANNEL_KEYS.every((key) => typeof card[key] === 'boolean' && card[key] === input[key])
  );
}

/**
 * Has the card changed since the customer looked at it? A channel change sends all four switches, so one made in
 * another tab would be overwritten by a stale screen. The check reads the card again just before sending.
 */
export function sameSettings(
  fresh: (CardLimits & CardChannels) | undefined,
  seen: (CardLimits & CardChannels) | undefined,
  keys: readonly (LimitKey | ChannelKey)[],
): boolean {
  if (!fresh || !seen) return false;
  return keys.every((key) =>
    typeof fresh[key] === 'boolean' || typeof seen[key] === 'boolean'
      ? fresh[key] === seen[key]
      : same(fresh[key as LimitKey], seen[key as LimitKey]),
  );
}
