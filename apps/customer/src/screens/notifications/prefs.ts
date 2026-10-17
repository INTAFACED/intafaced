/**
 * What the Notifications centre knows and decides, as plain functions: which kind of update belongs to which topic, whether
 * a way of reaching someone can work right now and why not, how a delivery is described, and what an address must look like.
 * No React and no network, so each rule has a test.
 *
 * Topic names come from the kinds svc-notify really writes (`services/svc-notify/src/events.ts`): trade.*, p2p.*, identity.*,
 * bank.*, token.* and agents.*. Per-topic delivery choices do not exist on the service (it stores one mute switch per channel),
 * so the topic table shows what each channel will do and never offers a switch the service would ignore.
 */

export const CATEGORIES = ['trading', 'p2p', 'account', 'money', 'token', 'agents'] as const;
export type Category = (typeof CATEGORIES)[number];

const PREFIX_TO_CATEGORY: Readonly<Record<string, Category>> = {
  trade: 'trading',
  p2p: 'p2p',
  identity: 'account',
  bank: 'money',
  token: 'token',
  agents: 'agents',
};

/** The topic of a notification kind ("trade.fill" is trading). A kind the list does not know has no topic. */
export function categoryOf(kind: string): Category | null {
  const prefix = kind.split('.')[0] ?? '';
  return PREFIX_TO_CATEGORY[prefix] ?? null;
}

export const OUT_OF_APP = ['email', 'push', 'sms'] as const;
export type OutOfApp = (typeof OUT_OF_APP)[number];
export type AnyChannel = 'inapp' | OutOfApp;

export interface ChannelFacts {
  /** The platform has what it needs to send on this channel. */
  ready: boolean;
  /** The person's mute switch for this channel; null when the service did not return one. */
  muted: boolean | null;
  /** The address or device on file, if any. */
  target: { verified: boolean } | null;
}

export type ChannelState = 'always' | 'platformOff' | 'noTarget' | 'unverified' | 'muted' | 'on';

/** What an ordinary (not urgent) update will do on this channel today, and the first thing in the way if it will not go. */
export function channelState(channel: AnyChannel, facts: ChannelFacts): ChannelState {
  if (channel === 'inapp') return 'always';
  if (!facts.ready) return 'platformOff';
  if (!facts.target) return 'noTarget';
  if (!facts.target.verified) return 'unverified';
  if (facts.muted) return 'muted';
  return 'on';
}

/** The mute switch works only for a channel the platform can send on, and only when the service returned a preference for it. */
export function canToggleMute(facts: ChannelFacts): boolean {
  return facts.ready && facts.muted !== null;
}

export function addressAction(channel: OutOfApp, facts: ChannelFacts): 'add' | 'verify' | 'none' {
  if (channel === 'push') return 'none';
  if (!facts.ready) return 'none';
  if (!facts.target) return 'add';
  return facts.target.verified ? 'none' : 'verify';
}

// Addresses -------------------------------------------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

export type AddressProblem = 'invalidEmail' | 'invalidSms';

/** The same shallow checks the service makes (it confirms the real mailbox or phone with a code). */
export function addressProblem(channel: 'email' | 'sms', value: string): AddressProblem | null {
  const text = value.trim();
  if (channel === 'email') return EMAIL.test(text) && text.length <= 320 ? null : 'invalidEmail';
  return E164.test(text) ? null : 'invalidSms';
}

export const isSixDigits = (value: string) => /^\d{6}$/.test(value.trim());

// Refusals, in plain words ---------------------------------------------------------------------------------------------

/** The refusal codes svc-notify can record (`channels/channel.ts`), each mapped to the copy key that explains it. */
export const REFUSAL_COPY = {
  'channel.not_configured': 'refusalNotConfigured',
  'channel.no_target': 'refusalNoTarget',
  'channel.target_unverified': 'refusalUnverified',
  'channel.target_unroutable': 'refusalUnroutable',
  'channel.disabled': 'refusalDisabled',
  'channel.muted': 'refusalMuted',
  'channel.attempts_exhausted': 'refusalExhausted',
  'channel.transport_rejected': 'refusalRejected',
  'channel.delivery_stuck': 'refusalStuck',
  'channel.register_rate_limited': 'refusalRegisterLimited',
  'channel.verify_rate_limited': 'refusalVerifyLimited',
  'channel.unprobed': 'refusalUnprobed',
} as const;
export type RefusalCopyKey = (typeof REFUSAL_COPY)[keyof typeof REFUSAL_COPY];

/** The copy key for a refusal code; a code this list has not seen maps to a generic line, never to the raw code. */
export function refusalKey(code: string | null): RefusalCopyKey | 'refusalUnknown' {
  if (code === null) return 'refusalUnknown';
  return (REFUSAL_COPY as Record<string, RefusalCopyKey>)[code] ?? 'refusalUnknown';
}

// Deliveries ------------------------------------------------------------------------------------------------------------

export interface DeliveryRow {
  channel: AnyChannel;
  status: 'pending' | 'accepted' | 'refused' | 'failed' | 'abandoned';
  attempts: number;
  attemptedAt: string | null;
  acceptedAt: string | null;
  refusalCode: string | null;
}

export type DeliveryWords =
  'deliveryPending' | 'deliveryInbox' | 'deliveryHandedOff' | 'deliveryRefused' | 'deliveryFailed' | 'deliveryAbandoned';

/**
 * One line for a delivery. "Accepted" on an outside channel means a provider took it for delivery, nothing more: the service
 * never learns whether it arrived, so the line says exactly that and no "delivered".
 */
export function deliveryWords(row: Pick<DeliveryRow, 'channel' | 'status'>): DeliveryWords {
  switch (row.status) {
    case 'pending':
      return 'deliveryPending';
    case 'accepted':
      return row.channel === 'inapp' ? 'deliveryInbox' : 'deliveryHandedOff';
    case 'refused':
      return 'deliveryRefused';
    case 'failed':
      return 'deliveryFailed';
    case 'abandoned':
      return 'deliveryAbandoned';
  }
}

const CHANNEL_ORDER: Record<AnyChannel, number> = { inapp: 0, email: 1, push: 2, sms: 3 };
/** In-app first, then email, phone, text; a repeated channel keeps its order from the service. */
export function sortDeliveries<T extends Pick<DeliveryRow, 'channel'>>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => CHANNEL_ORDER[a.row.channel] - CHANNEL_ORDER[b.row.channel] || a.index - b.index)
    .map(({ row }) => row);
}

// Registering and confirming ------------------------------------------------------------------------------------------

export type RegisterNote = 'codeSent' | 'sendRefused' | 'sendFailed';
export function registerNote(status: 'sent' | 'refused' | 'failed'): RegisterNote {
  return status === 'sent' ? 'codeSent' : status === 'refused' ? 'sendRefused' : 'sendFailed';
}

export type VerifyNote = 'verifiedNow' | 'codeWrong' | 'verifyLimited';
export function verifyNote(result: { verified: boolean; code: string | null }): VerifyNote {
  if (result.verified) return 'verifiedNow';
  return result.code !== null ? 'verifyLimited' : 'codeWrong';
}
