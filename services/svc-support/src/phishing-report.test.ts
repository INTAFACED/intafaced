import { describe, expect, it } from 'vitest';
import { CATEGORY_WEIGHT } from './operator-queue.js';
import { SupportError, SupportService } from './support-service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REPORT = {
  category: 'phishing',
  subject: 'Fake sign-in email',
  body: 'Forwarded below',
  messageHeaders: 'Received: from mx',
} as const;

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (err) {
    return err instanceof SupportError ? err.code : 'other';
  }
}

describe('I-signin-sessions-27 phishing report', () => {
  it('a phishing report keeps its pasted headers and category', async () => {
    const svc = new SupportService();
    const ticket = await svc.createTicket({ userId: USER, ...REPORT });
    expect(ticket).toMatchObject({ category: 'phishing', messageHeaders: 'Received: from mx', status: 'open' });
    expect((await svc.getTicket({ userId: USER, ticketId: ticket.id })).messageHeaders).toBe('Received: from mx');
  });

  it('headers on any other category are refused and nothing is stored', async () => {
    const svc = new SupportService();
    const code = await codeOf(
      svc.createTicket({ userId: USER, category: 'account', subject: 's', body: 'b', messageHeaders: 'Received: x' }),
    );
    expect(code).toBe('support.headers_not_allowed');
    expect(await svc.listMyTickets({ userId: USER, limit: 10 })).toHaveLength(0);
  });

  it('the same client key twice is one ticket; a new key is a second report', async () => {
    const svc = new SupportService();
    const first = await svc.createTicket({ userId: USER, ...REPORT, clientRequestId: 'k1' });
    const replay = await svc.createTicket({ userId: USER, ...REPORT, clientRequestId: 'k1' });
    expect(replay.id).toBe(first.id);
    const second = await svc.createTicket({ userId: USER, ...REPORT, clientRequestId: 'k2' });
    expect(second.id).not.toBe(first.id);
    expect(await svc.listMyTickets({ userId: USER, limit: 10 })).toHaveLength(2);
  });

  it('the same key with different content is refused as an idempotency conflict', async () => {
    const svc = new SupportService();
    await svc.createTicket({ userId: USER, ...REPORT, clientRequestId: 'k1' });
    expect(await codeOf(svc.createTicket({ userId: USER, ...REPORT, body: 'Another message', clientRequestId: 'k1' }))).toBe(
      'support.idempotency_conflict',
    );
  });

  it('a key belongs to its caller', async () => {
    const svc = new SupportService();
    const mine = await svc.createTicket({ userId: USER, ...REPORT, clientRequestId: 'k1' });
    const theirs = await svc.createTicket({ userId: OTHER, ...REPORT, clientRequestId: 'k1' });
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.userId).toBe(OTHER);
  });

  it('a reported scam is raised in the agent queue above an ordinary question', async () => {
    expect(CATEGORY_WEIGHT.phishing).toBeGreaterThan(CATEGORY_WEIGHT.account!);
    expect(CATEGORY_WEIGHT.phishing).toBeGreaterThan(CATEGORY_WEIGHT.other!);
    const svc = new SupportService();
    await svc.createTicket({ userId: USER, category: 'other', subject: 'Question', body: 'b' });
    const report = await svc.createTicket({ userId: USER, ...REPORT });
    const queue = await svc.listOperatorQueue({ limit: 10 });
    expect(queue.status).toBe('ok');
    if (queue.status === 'ok') {
      expect(queue.entries[0]?.ticketId).toBe(report.id);
      expect(queue.entries[0]?.category).toBe('phishing');
    }
  });
});
