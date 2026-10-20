import { describe, expect, it } from 'vitest';
import { supportAwaitingMineSchema } from './support-awaiting.js';

const ID = '11111111-1111-4111-8111-111111111111';
const SINCE = '2026-10-20T01:00:00.000Z';

describe('supportAwaitingMineSchema', () => {
  it('accepts nobody waiting and one or more waiting', () => {
    expect(supportAwaitingMineSchema.safeParse({ count: 0, longestWaiting: null }).success).toBe(true);
    expect(supportAwaitingMineSchema.safeParse({ count: 1, longestWaiting: { ticketId: ID, since: SINCE } }).success).toBe(true);
    expect(supportAwaitingMineSchema.safeParse({ count: 7, longestWaiting: { ticketId: ID, since: SINCE } }).success).toBe(true);
  });
  it('refuses a count and a pointer that disagree', () => {
    expect(supportAwaitingMineSchema.safeParse({ count: 2, longestWaiting: null }).success).toBe(false);
    expect(supportAwaitingMineSchema.safeParse({ count: 0, longestWaiting: { ticketId: ID, since: SINCE } }).success).toBe(false);
  });
  it('refuses a negative or fractional count, a bad id or time, and any extra field', () => {
    expect(supportAwaitingMineSchema.safeParse({ count: -1, longestWaiting: null }).success).toBe(false);
    expect(supportAwaitingMineSchema.safeParse({ count: 1.5, longestWaiting: { ticketId: ID, since: SINCE } }).success).toBe(false);
    expect(supportAwaitingMineSchema.safeParse({ count: 1, longestWaiting: { ticketId: 'x', since: SINCE } }).success).toBe(false);
    expect(supportAwaitingMineSchema.safeParse({ count: 1, longestWaiting: { ticketId: ID, since: 'soon' } }).success).toBe(false);
    expect(supportAwaitingMineSchema.safeParse({ count: 0, longestWaiting: null, subject: 'x' }).success).toBe(false);
    expect(supportAwaitingMineSchema.safeParse({ count: 1, longestWaiting: { ticketId: ID, since: SINCE, status: 'open' } }).success).toBe(
      false,
    );
  });
});
