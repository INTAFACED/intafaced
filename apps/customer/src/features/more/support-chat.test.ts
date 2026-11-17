import { describe, expect, it } from 'vitest';
import { supportChatOpenKeySchema, type SupportChatMessage } from '@intafaced/contracts/support-chat';
import { chatRefusalCode, mergeMessages, newChatKey } from './support-chat';

const message = (seq: number, body = `m${seq}`): SupportChatMessage => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  sessionId: '00000000-0000-4000-8000-000000000000',
  seq,
  author: 'customer',
  clientMessageId: `k${seq}`,
  body,
  createdAt: '2026-11-07T08:00:00.000Z',
});

describe('support chat helpers (SP-chat-01)', () => {
  it('makes 256-bit keys the open contract accepts, a new one each time', () => {
    const a = newChatKey();
    expect(supportChatOpenKeySchema.safeParse(a).success).toBe(true);
    expect(newChatKey()).not.toBe(a);
  });

  it('a re-read never shows a message twice and keeps the stored order', () => {
    const merged = mergeMessages([message(1), message(3)], [message(2), message(3), message(4)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it('reads the service code from a refusal, or vendor.email', () => {
    expect(chatRefusalCode('support.chat_closed this chat is closed')).toBe('support.chat_closed');
    expect(chatRefusalCode('needs vendor.email')).toBe('vendor.email');
    expect(chatRefusalCode('nothing named', 'NOT_FOUND')).toBe('NOT_FOUND');
  });
});
