import {
  supportChatAvailabilitySchema,
  supportChatEmailResultSchema,
  supportChatMessageSchema,
  supportChatOpenInputSchema,
  supportChatOpenResultSchema,
  supportChatPollInputSchema,
  supportChatPollSchema,
  supportChatSendInputSchema,
  supportChatSessionInputSchema,
  supportChatSessionSchema,
  type SupportChatMessage,
} from '@intafaced/contracts/support-chat';
import { contractProcedure } from '../../shared/contract-call';

/** Live chat (SP-chat-01): public calls, so a guest can chat. Keys and tokens go in the POST body, never in an address. */
export const chatAvailability = contractProcedure('support', 'chatAvailability', { output: supportChatAvailabilitySchema });
export const chatOpen = contractProcedure('support', 'chatOpen', {
  input: supportChatOpenInputSchema,
  output: supportChatOpenResultSchema,
});
export const chatSend = contractProcedure('support', 'chatSend', { input: supportChatSendInputSchema, output: supportChatMessageSchema });
export const chatPoll = contractProcedure('support', 'chatPoll', { input: supportChatPollInputSchema, output: supportChatPollSchema });
export const chatClose = contractProcedure('support', 'chatClose', {
  input: supportChatSessionInputSchema,
  output: supportChatSessionSchema,
});
export const chatContinueByEmail = contractProcedure('support', 'chatContinueByEmail', {
  input: supportChatSessionInputSchema,
  output: supportChatEmailResultSchema,
});

/** A 256-bit key as 43 base64url characters: one per chat, or one per message. */
export function newChatKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Messages merged by sequence: a re-read never shows one twice, and they stay in the order they were stored. */
export function mergeMessages(held: readonly SupportChatMessage[], read: readonly SupportChatMessage[]): SupportChatMessage[] {
  const bySeq = new Map(held.map((m) => [m.seq, m]));
  for (const m of read) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The code a refusal names: the service's dotted code, or `vendor.email`. */
export function chatRefusalCode(message: string, code?: string): string | null {
  return /\bsupport(?:\.[a-z0-9_]+)+|\bvendor\.email\b/.exec(message)?.[0] ?? code ?? null;
}

/** Where the open chat is kept in this tab, so a reload comes back to it (best effort). */
export const CHAT_SLOT = 'intafaced.support.chat.v1';
export type KeptChat = { clientKey: string; sessionId: string; accessToken: string };
export function readKeptChat(): KeptChat | null {
  try {
    const raw = sessionStorage.getItem(CHAT_SLOT);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<KeptChat>;
    return typeof value.clientKey === 'string' && typeof value.sessionId === 'string' && typeof value.accessToken === 'string'
      ? (value as KeptChat)
      : null;
  } catch {
    return null;
  }
}
export function keepChat(chat: KeptChat | null): void {
  try {
    if (chat) sessionStorage.setItem(CHAT_SLOT, JSON.stringify(chat));
    else sessionStorage.removeItem(CHAT_SLOT);
  } catch {
    // Storage may be off; the chat still works until the tab reloads.
  }
}
