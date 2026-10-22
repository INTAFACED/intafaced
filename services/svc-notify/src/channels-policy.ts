/**
 * ops.notifications channels policy — fan-out mountain vs §13 sockets (D26-P1-O5).
 */
import {
  CHANNEL_TO_SOCKET,
  FANOUT_MOUNTAIN_ID,
  HONEST_GAPS,
  NOTIFY_CHANNEL_SOCKET_IDS,
  mountainDoneForbiddenWhileAllOutOfAppRefuse,
  mountainVsSocketsBoardCard,
  mountainVsSocketsExportText,
  mountainVsSocketsStatusLine,
} from './channels/mountain-vs-sockets.js';
import { OUT_OF_APP_CHANNELS } from './channels/channel.js';
import { parsePushPublicKey } from './push-public-key.js';

export type ChannelsPolicySummary = ReturnType<typeof describeChannelsPolicy>;

/** The only push gateway value this public read may carry. The gateway token is never read here. */
export type ChannelsPolicyEnv = { readonly NOTIFY_PUSH_PUBLIC_KEY?: string | undefined };

let configured: ChannelsPolicyEnv = {};

/**
 * Boot wiring: index.ts passes the VALIDATED env (env.ts refuses a malformed key
 * at boot). Until it is called, the read reports "not configured" (null).
 */
export function configureChannelsPolicy(env: ChannelsPolicyEnv): void {
  configured = { NOTIFY_PUSH_PUBLIC_KEY: env.NOTIFY_PUSH_PUBLIC_KEY };
}

/** Blank or absent is "not configured" (null), not a refusal. A set value must be a valid public key. */
export function pushPublicKeyOf(env: ChannelsPolicyEnv): string | null {
  const key = env.NOTIFY_PUSH_PUBLIC_KEY?.trim();
  return key ? parsePushPublicKey(key) : null;
}

/** Public honesty board for ops.notifications channel split. */
export function describeChannelsPolicy(env: ChannelsPolicyEnv = configured) {
  const card = mountainVsSocketsBoardCard();
  return {
    /** Push gateway public application key for device subscription; null when the owner has not set it. */
    pushPublicKey: pushPublicKeyOf(env),
    mountainId: FANOUT_MOUNTAIN_ID,
    outOfAppChannels: [...OUT_OF_APP_CHANNELS],
    socketIds: [...NOTIFY_CHANNEL_SOCKET_IDS],
    channelToSocket: { ...CHANNEL_TO_SOCKET },
    honestGaps: [...HONEST_GAPS],
    mountain: card,
    statusLine: mountainVsSocketsStatusLine(),
    export: mountainVsSocketsExportText(),
    matrixComplete: card.matrixComplete,
    inappHasNoSocket: card.inappHasNoSocket,
    mountainDoneForbiddenWhileAllOutOfAppRefuse: mountainDoneForbiddenWhileAllOutOfAppRefuse(true),
    inventsProviders: false as const,
    acceptedIsNotDelivered: true as const,
  };
}
