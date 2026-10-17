import { renderToStaticMarkup } from 'react-dom/server';
import type { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  // Balances hidden: the payroll review must still show exact figures.
  return {
    ...real,
    usePreferences: () => real.currentPreferences(),
    currentPreferences: () => ({ ...real.currentPreferences(), hideBalances: true }),
  };
});
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  return { ...real, useSession: () => ({ api: { canWrite: () => true, query: async () => ({ ok: false }) }, userId: 'user-1' }) as never };
});
import { businessCopy } from './business-copy';
import { ApprovalRow } from './BusinessBank';
import { PayrollRun, payrollSpec } from './BusinessPayroll';
import { PayPerson, personPaymentSpec, TeamList } from './BusinessPeople';
import type { pendingApprovalSchema } from './contracts';
import { refusal, sendReviewed, wire } from './write-flow';

const copy = businessCopy.forLocale('en');
const account = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Studio',
  assetId: 'USDT',
  spendThreshold: '1000',
  status: 'active' as const,
  createdAt: '2026-10-01T00:00:00Z',
};
const source = { id: '11111111-1111-4111-8111-111111111111', name: 'Main', assetId: 'USDT', balance: '5000.25' };
const lines = [
  { handle: 'ada', toSpaceId: '22222222-2222-4222-8222-222222222222', amount: '100.50' },
  { handle: 'bob', toSpaceId: '33333333-3333-4333-8333-333333333333', amount: '200' },
];
const requestId = '0c1f0a52-5c7f-4c1c-8e7b-6f2d3b9a1e44';
const ready = { status: 'ready' as const, data: { role: 'maker' as const } };
const open = () => undefined;

describe('the team list', () => {
  it('names every member with their role and what it can do, and marks you', () => {
    const html = renderToStaticMarkup(
      <TeamList
        me="User-1"
        members={[
          { userId: 'user-1', handle: 'ada', role: 'admin' },
          { userId: 'user-2', handle: 'bob', role: 'maker' },
          { userId: 'user-3', handle: 'cy', role: 'checker' },
        ]}
      />,
    );
    expect(html).toContain('3 on this team');
    for (const word of [
      '@ada',
      '@bob',
      '@cy',
      'Administrator',
      'Maker',
      'Checker',
      'Approves or rejects payments.',
      'Sends payments and runs payroll.',
    ])
      expect(html).toContain(word);
    expect(html.match(/>You</g)).toHaveLength(1);
  });
  it('says so when nobody is listed, rather than showing an empty box', () => {
    expect(renderToStaticMarkup(<TeamList me={null} members={[]} />)).toContain('Nobody is listed on this team.');
  });
});

describe('paying a person by handle or email', () => {
  const person = { handle: 'zed', spaceId: '55555555-5555-4555-8555-555555555555' };
  const own = [source];
  const spec = personPaymentSpec(copy, account, own, person);
  it('shows who gets it and sends to the account the bank found', () => {
    expect(spec.facts?.[0]).toEqual(['Recipient', '@zed · main USDT account']);
    expect(spec.input({ fromSpaceId: source.id, amount: '12.5' }, requestId)).toEqual({
      accountId: account.id,
      fromSpaceId: source.id,
      toSpaceId: person.spaceId,
      amount: '12.5',
      clientId: requestId,
    });
  });
  it('sends the same request for the same payment, so the bank posts it once', async () => {
    const bodies: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return wire({ kind: 'posted', transferId: requestId, ledgerTxId: 'tx-1' });
    };
    const first = await sendReviewed(spec, { fromSpaceId: source.id, amount: '12.5' }, requestId, fetcher);
    await sendReviewed(spec, { fromSpaceId: source.id, amount: '12.5' }, requestId, fetcher);
    expect(first.outcome.ok).toBe(true);
    expect(bodies[0]).toBe(bodies[1]);
  });
  it('turns a recipient who cannot receive into plain words', async () => {
    const done = await sendReviewed(spec, { fromSpaceId: source.id, amount: '12.5' }, requestId, async () =>
      refusal(400, 'bank.recipient_cannot_receive'),
    );
    expect(done.refusedFirst).toBe(true);
    expect(done.outcome).toMatchObject({ ok: false, message: 'That person cannot receive this right now. Nothing was sent.' });
  });
  it('is off for a checker, and says why', () => {
    const html = renderToStaticMarkup(
      <PayPerson account={account} own={own} role={{ status: 'ready', data: { role: 'checker' } }} open={open} />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send money<\/button>/);
    expect(html).toContain('Checkers approve payments. Sending money needs an administrator or maker role.');
  });
  it('asks for a handle or email before anything is sent', () => {
    const html = renderToStaticMarkup(<PayPerson account={account} own={own} role={ready} open={open} />);
    expect(html).toContain('Handle or email');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send money<\/button>/);
    expect(html).toContain('main USDT account');
  });
});

describe('payroll', () => {
  const spec = payrollSpec(copy, account, source, lines, 30050n * 10n ** 16n);
  it('shows the source, every person with the exact amount, the total and the limit before anything is sent', () => {
    expect(spec.procedure).toBe('business.runPayroll');
    expect(spec.fields).toBeUndefined();
    expect(spec.facts).toEqual([
      ['Pay from', 'Main · 5,000.25 USDT'],
      ['@ada', '100.50 USDT'],
      ['@bob', '200 USDT'],
      ['Total', '300.5 USDT'],
      ['Approval limit', '1,000 USDT'],
    ]);
    // Balances are hidden in this test's preferences, yet the review still reads in exact figures.
    expect(spec.facts!.flat().join(' ')).not.toContain('••••');
  });
  it('tells the person it goes out in one step and that a repeat is recognised', () => {
    expect(spec.notes).toContain('This moves money out of the source account in one step. Check every person and amount.');
    expect(spec.notes.join(' ')).toContain('If the same payroll is sent again it is recognised and not paid twice.');
  });
  it('uses the request id as the payroll id and builds the same request each time', () => {
    const first = spec.input({}, requestId);
    expect(first).toEqual({
      payrollId: requestId,
      accountId: account.id,
      fromSpaceId: source.id,
      recipients: [
        { toSpaceId: lines[0]!.toSpaceId, amount: '100.50' },
        { toSpaceId: lines[1]!.toSpaceId, amount: '200' },
      ],
    });
    expect(spec.input({}, requestId)).toEqual(first);
  });
  const run = (recipients: Array<{ toSpaceId: string; amount: string }>) => ({
    payrollId: requestId,
    accountId: account.id,
    fromSpaceId: source.id,
    assetId: 'USDT',
    ledgerTxId: 'tx-9',
    recipients,
    createdAt: '2026-10-18T00:00:00Z',
  });
  const paid = [
    { toSpaceId: lines[0]!.toSpaceId, amount: '100.5' },
    { toSpaceId: lines[1]!.toSpaceId, amount: '200' },
  ];
  it('sends the same bytes on a resend and confirms only the payroll that was reviewed', async () => {
    const bodies: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return wire(run(paid));
    };
    const first = await sendReviewed(spec, {}, requestId, fetcher);
    await sendReviewed(spec, {}, requestId, fetcher);
    expect(first.outcome.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ payrollId: requestId });
    const short = await sendReviewed(spec, {}, requestId, async () => wire(run(paid.slice(0, 1))));
    expect(short.outcome).toMatchObject({ ok: false, reason: 'uncertain' });
    const other = await sendReviewed(spec, {}, requestId, async () => wire(run([{ ...paid[0]!, amount: '100.51' }, paid[1]!])));
    expect(other.outcome).toMatchObject({ ok: false, reason: 'uncertain' });
  });
  it('describes the confirmed payroll person by person', () => {
    expect(spec.describeOutcome?.(run(paid), {})).toEqual([
      ['Result', 'Payroll sent'],
      ['@ada', '100.5 USDT'],
      ['@bob', '200 USDT'],
      ['Total', '300.5 USDT'],
    ]);
  });
  it('maps the bank’s payroll refusals to plain words, each one a definite no', async () => {
    const cases: Array<[number, string, string]> = [
      [400, 'bank.business_self_approve', 'second person must decide'],
      [400, 'bank.business_payroll_rate_unset', 'same currency'],
      [409, 'bank.business_payroll_conflict', 'different people or amounts'],
      [400, 'bank.business_payroll_empty', 'Add at least one person'],
      [409, 'bank.business_request_conflict', 'different details'],
      [400, 'bank.business_role_forbidden', 'does not allow that'],
      [400, 'bank.business_not_member', 'not a member'],
      [400, 'bank.same_space', 'cannot go to the account it comes from'],
      [400, 'ledger.insufficient_funds', 'not enough available'],
    ];
    for (const [status, code, words] of cases) {
      const done = await sendReviewed(spec, {}, requestId, async () => refusal(status, code));
      expect(done.refusedFirst, code).toBe(true);
      expect((done.outcome as { message: string }).message, code).toContain(words);
    }
  });
  it('treats a lost ledger answer as unconfirmed, never as a refusal that can be resent', async () => {
    const done = await sendReviewed(spec, {}, requestId, async () => refusal(503, 'bank.ledger_outcome_unknown'));
    expect(done.refusedFirst).toBe(false);
    expect(done.outcome).toMatchObject({ ok: false, reason: 'uncertain' });
  });

  it('is off for a checker, with the real reason', () => {
    const html = renderToStaticMarkup(
      <PayrollRun account={account} own={[source]} role={{ status: 'ready', data: { role: 'checker' } }} open={open} />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Review payroll<\/button>/);
    expect(html).toContain('Checkers approve payments. Running payroll needs an administrator or maker role.');
  });
  it('is off with no account to pay from, and on a closed team', () => {
    const none = renderToStaticMarkup(<PayrollRun account={account} own={[]} role={ready} open={open} />);
    expect(none).toContain('You need an account in USDT to pay from.');
    const closed = renderToStaticMarkup(<PayrollRun account={{ ...account, status: 'closed' }} own={[source]} role={ready} open={open} />);
    expect(closed).toMatch(/<button[^>]*disabled[^>]*>Review payroll<\/button>/);
  });
  it('starts empty, shows the limit and the available balance exactly, and asks for the first person', () => {
    const html = renderToStaticMarkup(<PayrollRun account={account} own={[source]} role={ready} open={open} />);
    expect(html).toContain('No one is on this payroll.');
    expect(html).toContain('1,000 USDT');
    expect(html).toContain('5,000.25 USDT');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Review payroll<\/button>/);
    expect(html).toContain('Add at least one person to pay.');
    expect(html).toContain('Handle or email');
  });
  it('keeps going while the role is unreadable, and says the bank decides', () => {
    const html = renderToStaticMarkup(
      <PayrollRun
        account={account}
        own={[source]}
        role={{ status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'x' } }}
        open={open}
      />,
    );
    expect(html).toContain('Your role on this team could not be read, so the actions that depend on it are off.');
  });
});

describe('a payment waiting for approval', () => {
  const waiting: z.infer<typeof pendingApprovalSchema> = {
    id: '66666666-6666-4666-8666-666666666666',
    accountId: account.id,
    makerUserId: 'user-2',
    checkerUserId: null,
    fromSpaceId: source.id,
    toSpaceId: '77777777-7777-4777-8777-777777777777',
    assetId: 'USDT',
    amount: '1200.5',
    status: 'pending',
    transferId: null,
    holdLedgerTxId: 'hold-1',
    ledgerTxId: null,
    createdAt: '2026-10-18T00:00:00Z',
    makerHandle: 'bob',
    makerHandleReason: null,
    receiverOwnerHandle: 'zed',
    receiverOwnerHandleReason: null,
    receiverOwnerName: 'Zed Zimmer',
  };
  const render = (approval: z.infer<typeof pendingApprovalSchema>, role: 'admin' | 'maker' | 'checker' | null) =>
    renderToStaticMarkup(<ApprovalRow approval={approval} me="user-1" myHandle="ada" role={role} spaces={[]} open={open} />);
  it('names who proposed it and who owns the receiving account, as the bank reports them', () => {
    const html = render(waiting, 'checker');
    expect(html).toContain('@bob');
    expect(html).toContain('Zed Zimmer (@zed)');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Approve<\/button>/);
  });
  it('keeps approving off when the bank could not name the owner of the receiving account, and says why', () => {
    const html = render(
      { ...waiting, receiverOwnerHandle: null, receiverOwnerHandleReason: 'handle_unresolved', receiverOwnerName: null },
      'checker',
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve<\/button>/);
    expect(html).toContain('The owner of the receiving account could not be identified, so approving is turned off to protect you.');
  });
  it('offers only what the person’s role allows once the bank has said what it is', () => {
    expect(render(waiting, 'checker')).not.toContain('Cancel (administrator)');
    expect(render(waiting, 'checker')).toContain('>Reject<');
    expect(render(waiting, 'admin')).toContain('Cancel (administrator)');
    const maker = render(waiting, 'maker');
    expect(maker).not.toContain('>Approve<');
    expect(maker).not.toContain('>Reject<');
  });
  it('falls back to a reference only when no handle is known', () => {
    const html = render({ ...waiting, makerHandle: null, makerHandleReason: 'handle_unresolved' }, 'checker');
    expect(html).toContain('A teammate · ref user');
  });
});
