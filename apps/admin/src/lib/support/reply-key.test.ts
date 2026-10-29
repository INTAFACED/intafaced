import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { noteKey, replyKey } = await import('./server');

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

describe('the reply key', () => {
  it('is the same for the same request, row and text, so a retry after an unknown outcome is answered, not sent twice', () => {
    expect(replyKey(T, A, 7, 0, 'TEST answer')).toBe(replyKey(T, A, 7, 0, 'TEST answer'));
    expect(replyKey(T, A, 7, 0, 'TEST answer')).toMatch(new RegExp(`^admin-reply:${T}:${A}:7:0:[0-9a-f]{32}$`));
  });
  it('changes with the row read and with the text, so a re-send after reading the changes is a new reply', () => {
    expect(replyKey(T, A, 8, 0, 'TEST answer')).not.toBe(replyKey(T, A, 7, 0, 'TEST answer'));
    expect(replyKey(T, A, 7, 0, 'TEST other answer')).not.toBe(replyKey(T, A, 7, 0, 'TEST answer'));
  });
  it('is new for the next reply sent from the same view, and for another agent', () => {
    expect(replyKey(T, A, 7, 1, 'TEST answer')).not.toBe(replyKey(T, A, 7, 0, 'TEST answer'));
    expect(replyKey(T, B, 7, 0, 'TEST answer')).not.toBe(replyKey(T, A, 7, 0, 'TEST answer'));
  });
});

describe('the note key', () => {
  it('is its own key: a retry is the same note, and a reply with the same text is never answered by it', () => {
    expect(noteKey(T, A, 7, 0, 'TEST note')).toBe(noteKey(T, A, 7, 0, 'TEST note'));
    expect(noteKey(T, A, 7, 0, 'TEST note')).toMatch(new RegExp(`^admin-note:${T}:${A}:7:0:[0-9a-f]{32}$`));
    expect(noteKey(T, A, 7, 0, 'TEST note')).not.toBe(replyKey(T, A, 7, 0, 'TEST note'));
  });
  it('is new for the next note, another text and another agent', () => {
    expect(noteKey(T, A, 7, 1, 'TEST note')).not.toBe(noteKey(T, A, 7, 0, 'TEST note'));
    expect(noteKey(T, A, 7, 0, 'TEST other')).not.toBe(noteKey(T, A, 7, 0, 'TEST note'));
    expect(noteKey(T, B, 7, 0, 'TEST note')).not.toBe(noteKey(T, A, 7, 0, 'TEST note'));
  });
});
