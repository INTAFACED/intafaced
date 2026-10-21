import { describe, expect, it } from 'vitest';
import { CATEGORY_VALUES, ticketSchema } from './support-schemas';

describe('a phishing report in the request list', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    category: 'phishing',
    subject: 'Odd message',
    body: 'It asked me to sign in.',
    messageHeaders: 'Received: from example',
    status: 'open',
    assigneeId: null,
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
  };

  it('parses, so one report does not break the whole list', () => {
    expect(ticketSchema.safeParse(row).success).toBe(true);
  });

  it('parses a request that is on hold', () => {
    expect(ticketSchema.safeParse({ ...row, status: 'on_hold' }).success).toBe(true);
  });

  it('is offered as a topic', () => {
    expect(CATEGORY_VALUES).toContain('phishing');
  });
});
