import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { replyKey } = await import('./server');

const T = '11111111-1111-4111-8111-111111111111';

describe('the reply key', () => {
  it('is the same for the same request, row and text, so a retry after an unknown outcome is answered, not sent twice', () => {
    expect(replyKey(T, 7, 'TEST answer')).toBe(replyKey(T, 7, 'TEST answer'));
    expect(replyKey(T, 7, 'TEST answer')).toMatch(new RegExp(`^admin-reply:${T}:7:[0-9a-f]{32}$`));
  });
  it('changes with the row read and with the text, so a re-send after reading the changes is a new reply', () => {
    expect(replyKey(T, 8, 'TEST answer')).not.toBe(replyKey(T, 7, 'TEST answer'));
    expect(replyKey(T, 7, 'TEST other answer')).not.toBe(replyKey(T, 7, 'TEST answer'));
  });
});
