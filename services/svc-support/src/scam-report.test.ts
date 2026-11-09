import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { BankScamTransferInput, BankScamTransferResult, Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { MemorySafetyBook, SafetyCases } from './safety-cases.js';
import { SupportService } from './support-service.js';

/**
 * A scam report through the router (BK-safe-02, J-bank-18 #3): a request in the scam category with a case note naming
 * the amount and the transfer, once per key; a transfer the person did not send refused; a bank that cannot be asked
 * leaves the report untaken; the general form refuses the category.
 */

const authConfig = {
  secret: 'a-support-scam-report-test-secret-long-enough-xxxx',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const ANN = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-09T08:00:00.000Z');
const ANNS_TRANSFER = 'tr-ann-00000001';

async function ctx(userId: string): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: ['support:read', 'support:write'], tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-scam' };
}

function desk(bank: 'answers' | 'down' = 'answers', policy: string | null = null) {
  const asked: BankScamTransferInput[] = [];
  const transfers = {
    check: async (input: BankScamTransferInput): Promise<BankScamTransferResult> => {
      asked.push(input);
      if (bank === 'down') return { state: 'unavailable' };
      return { state: 'answered', sent: input.userId === ANN && input.transferId === ANNS_TRANSFER };
    },
  };
  const support = new SupportService();
  const safety = new SafetyCases(new MemorySafetyBook(), support, null, () => NOW, transfers, policy);
  const router = createSupportRouter(
    support,
    undefined,
    undefined,
    support,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    null,
    safety,
  );
  return { support, asked, as: async (userId: string) => router.createCaller(await ctx(userId)) };
}

const REPORT = {
  when: 'after_sending',
  amount: '25.5',
  assetId: 'USDT',
  transferId: ANNS_TRANSFER,
  contactedBy: 'phone_call',
  details: 'TEST someone said they were from the bank and asked me to move my money to a safe account.',
} as const;

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
  }
};

describe('a scam report (J-bank-18 #3)', () => {
  it('makes one request in the scam category with a case note naming the amount, the transfer and the contact', async () => {
    const { support, asked, as } = desk();
    const ann = await as(ANN);
    const ack = await ann.safety.reportScam(REPORT);
    expect(ack).toMatchObject({ kind: 'scam', responseDeadline: null, acknowledgedAt: NOW.toISOString() });
    expect(ack.reference).toMatch(/^SC-[0-9A-F]{8}$/);
    expect(ack.caseNote).toContain('25.5 USDT on transfer tr-ann-00000001, which the bank confirms was sent from this account');
    expect(ack.caseNote).not.toMatch(/freeze|desk/i);
    expect(ack.caseNote).toContain('Contacted by a phone call.');
    expect(asked).toEqual([{ userId: ANN, transferId: ANNS_TRANSFER }]);
    const tickets = await support.listMyTickets({ userId: ANN, limit: 50 });
    expect(tickets.map((t) => [t.id, t.category, t.subject])).toEqual([[ack.ticketId, 'scam', 'Scam report']]);
    expect(tickets[0]!.body).toContain('Amount: 25.5 USDT');
    expect(tickets[0]!.body).toContain(`Transfer: ${ANNS_TRANSFER}`);
    // Once: the same key answers with the same acknowledgement, without asking the bank again or making a second request.
    expect(await ann.safety.reportScam(REPORT)).toEqual(ack);
    expect(asked).toHaveLength(1);
    expect(await support.listMyTickets({ userId: ANN, limit: 50 })).toHaveLength(1);
    expect((await ann.safety.mine()).acknowledgements).toEqual([ack]);
    // One report per transfer (BK-safe-02's key): the same transfer reported again, in other words, answers with the first.
    expect(await ann.safety.reportScam({ ...REPORT, amount: '30', contactedBy: 'email' })).toEqual(ack);
    expect(await support.listMyTickets({ userId: ANN, limit: 50 })).toHaveLength(1);
  });

  it("refuses a transfer the person did not send, and takes nothing while the bank can't be asked", async () => {
    const { support, as } = desk();
    expect(await codeOf((await as(BOB)).safety.reportScam(REPORT))).toBe('support.scam_transfer_not_yours');
    expect(await codeOf((await as(ANN)).safety.reportScam({ ...REPORT, transferId: 'tr-someone-else' }))).toBe(
      'support.scam_transfer_not_yours',
    );
    expect(await support.listMyTickets({ userId: BOB, limit: 50 })).toEqual([]);
    const down = desk('down');
    expect(await codeOf((await down.as(ANN)).safety.reportScam(REPORT))).toBe('support.scam_transfer_unchecked');
    expect(await down.support.listMyTickets({ userId: ANN, limit: 50 })).toEqual([]);
  });

  it('takes a report before any money moved, with no transfer and no bank check, once per set of words', async () => {
    const { support, asked, as } = desk('down');
    const ann = await as(ANN);
    const before = { when: 'before_sending', amount: '900', assetId: 'USDT', contactedBy: 'messaging_app' } as const;
    const ack = await ann.safety.reportScam(before);
    expect(ack.reference).toMatch(/^SC-[0-9A-F]{8}$/);
    expect(ack.caseNote).toBe(
      'Scam report before sending any money: 900 USDT asked for, and no transfer made. Contacted by a messaging app. Next: the support team reviews the report and contacts you.',
    );
    expect(asked).toEqual([]);
    expect(await ann.safety.reportScam(before)).toEqual(ack);
    expect((await support.listMyTickets({ userId: ANN, limit: 50 })).map((t) => t.body.includes('Transfer:'))).toEqual([false]);
    // A transfer only after sending; after sending, always one.
    expect(await codeOf(ann.safety.reportScam({ ...before, transferId: ANNS_TRANSFER }))).toBe('BAD_REQUEST');
    const { transferId: _drop, ...noTransfer } = REPORT;
    expect(await codeOf(ann.safety.reportScam(noTransfer))).toBe('BAD_REQUEST');
  });

  it('refuses the scam category on the general request form, and a zero amount', async () => {
    const { as } = desk();
    const ann = await as(ANN);
    expect(await codeOf(ann.create({ category: 'scam', subject: 'TEST', body: 'TEST' }))).toBe('support.category_guided');
    expect(await codeOf(ann.safety.reportScam({ ...REPORT, amount: '0' }))).toBe('BAD_REQUEST');
  });

  it("reads the owner's mule policy, or that none is published, never words of ours", async () => {
    expect(await (await desk().as(ANN)).safety.mulePolicy()).toEqual({ published: false });
    expect(await (await desk('answers', '   ').as(ANN)).safety.mulePolicy()).toEqual({ published: false });
    expect(await (await desk('answers', ' TEST policy words ').as(ANN)).safety.mulePolicy()).toEqual({
      published: true,
      text: 'TEST policy words',
    });
  });
});
