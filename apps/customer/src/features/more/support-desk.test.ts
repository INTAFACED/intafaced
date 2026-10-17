import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPPORT_EMAIL,
  REQUEST_ACTIONS,
  canReply,
  filterTickets,
  inKbCategory,
  kbCategory,
  kbCategoryCounts,
  matchesFilter,
  newestFirst,
  replyReopens,
  statusCounts,
  supportEmail,
  supportMailto,
  ticketReference,
  type TicketLike,
} from './support-desk';

const row = (over: Partial<TicketLike> & { id: string }): TicketLike => ({
  subject: 'Subject',
  body: 'Body',
  category: 'other',
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('status filters', () => {
  it('treats open and in-progress as active, and keeps resolved and closed apart', () => {
    expect(matchesFilter('open', 'active')).toBe(true);
    expect(matchesFilter('pending', 'active')).toBe(true);
    expect(matchesFilter('resolved', 'active')).toBe(false);
    expect(matchesFilter('closed', 'active')).toBe(false);
    expect(matchesFilter('closed', 'all')).toBe(true);
    expect(matchesFilter('resolved', 'resolved')).toBe(true);
  });

  it('counts every request in exactly one bucket', () => {
    const rows = [
      row({ id: 'a', status: 'open' }),
      row({ id: 'b', status: 'pending' }),
      row({ id: 'c', status: 'resolved' }),
      row({ id: 'd', status: 'closed' }),
    ];
    expect(statusCounts(rows)).toEqual({ all: 4, active: 2, resolved: 1, closed: 1 });
  });
});

describe('ordering and search', () => {
  it('puts the newest activity first and sinks an unreadable time', () => {
    const sorted = newestFirst([
      row({ id: 'old', updatedAt: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'bad', updatedAt: 'nope' }),
      row({ id: 'new', updatedAt: '2026-10-09T00:00:00.000Z' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['new', 'old', 'bad']);
  });

  it('searches subject, message and reference, ignoring case and accents', () => {
    const rows = [
      row({ id: '11111111-aaaa-bbbb-cccc-000000000001', subject: 'Retrait bloqué', body: 'cannot withdraw' }),
      row({ id: '22222222-aaaa-bbbb-cccc-000000000002', subject: 'Other', body: 'Login loop' }),
    ];
    expect(filterTickets(rows, 'all', 'RETRAIT').map((r) => r.subject)).toEqual(['Retrait bloqué']);
    expect(filterTickets(rows, 'all', 'retrait bloque')).toHaveLength(1);
    expect(filterTickets(rows, 'all', 'login')).toHaveLength(1);
    expect(filterTickets(rows, 'all', '#22222222')).toHaveLength(1);
    expect(filterTickets(rows, 'closed', '')).toHaveLength(0);
  });

  it('gives a short quotable reference without changing the id', () => {
    expect(ticketReference('a1b2c3d4-0000-0000-0000-000000000000')).toBe('#A1B2C3D4');
  });
});

describe('what a person can do to a request', () => {
  it('takes replies until the request is closed, and says a reply reopens a resolved one', () => {
    expect(canReply('open')).toBe(true);
    expect(canReply('resolved')).toBe(true);
    expect(canReply('closed')).toBe(false);
    expect(replyReopens('resolved')).toBe(true);
    expect(replyReopens('open')).toBe(false);
  });

  it('keeps close, rate and attach switched off with a named reason because the service has no procedure', () => {
    expect(REQUEST_ACTIONS.reply.available).toBe(true);
    for (const id of ['close', 'rate', 'attach'] as const) {
      expect(REQUEST_ACTIONS[id].available).toBe(false);
      expect(REQUEST_ACTIONS[id]).toHaveProperty('reason');
    }
  });
});

describe('help article groups', () => {
  it('groups the published articles and falls back to general', () => {
    expect(kbCategory('kb-account-access')).toBe('account');
    expect(kbCategory('kb-security-basics')).toBe('security');
    expect(kbCategory('kb-orders-status')).toBe('trading');
    expect(kbCategory('kb-deposit-withdraw-honest')).toBe('money');
    expect(kbCategory('kb-new-passkey-guide')).toBe('security');
    expect(kbCategory('kb-something-unseen')).toBe('general');
  });

  it('counts only groups that hold articles, and "all" always holds every one', () => {
    const counts = kbCategoryCounts(['kb-account-access', 'kb-security-basics', 'kb-orders-status', 'kb-paper-vs-live']);
    expect(counts).toEqual({ all: 4, account: 1, security: 1, trading: 2 });
    expect(inKbCategory('kb-orders-status', 'all')).toBe(true);
    expect(inKbCategory('kb-orders-status', 'trading')).toBe(true);
    expect(inKbCategory('kb-orders-status', 'money')).toBe(false);
  });
});

describe('contact address', () => {
  it('uses a configured address only when it is a plain address, else the recorded company address', () => {
    expect(supportEmail('help@example.org')).toBe('help@example.org');
    expect(supportEmail('  help@example.org ')).toBe('help@example.org');
    expect(supportEmail('not an address')).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(supportEmail(undefined)).toBe(DEFAULT_SUPPORT_EMAIL);
  });

  it('builds a mailto that carries only the text it was given, encoded', () => {
    const href = supportMailto('a@b.co', "Can't sign in", 'Hi & thanks');
    expect(href).toBe("mailto:a@b.co?subject=Can't%20sign%20in&body=Hi%20%26%20thanks");
  });
});
