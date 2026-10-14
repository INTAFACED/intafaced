import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerText, allFacts, investorSignals, keyFacts, otherSignal } from './answers';
import {
  commitmentInput,
  declineEvidence,
  declineInput,
  dispositionOf,
  handOverInput,
  markRepliedInput,
  nextStepInput,
  otherFounder,
  quickDue,
  stageInput,
  tierOf,
} from './actions';
import { addDecimal, formatMoney, formatMoneyCompact, groupedDecimal, parseTypedAmount, shareTenths, tenthsText } from './format';
import { DECLINE_REASONS, LIMITS, RAISE_TARGET_EUR, REPLY_TARGET_BUSINESS_DAYS } from './policy';
import { businessMsBetween, emptyQueueNote, sectionOf, sectionQueue, tabCounts, tabRows, waitSeverity, waitingText } from './queue';
import { investorStageCounts, openEnquiries, otherCurrencies, raiseBar } from './raise';
import { DRAFT_HEADER, declineDraft, mailtoHref, replyDraft } from './templates';
import { buildTimeline, describeActivity } from './timeline';
import { crmUrl, parseCrmUrl } from './url-state';

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

// Wednesday 14 Oct 2026, 10:00 UTC.
const NOW = Date.parse('2026-10-14T10:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const daysFromNow = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

type Audience = 'investor' | 'trader' | 'merchant' | 'academy' | 'partner';
type Row = Parameters<typeof sectionOf>[0] & { waitingSince: string | null; audience: Audience; ownerUserId: string };
const row = (over: Partial<Row> = {}): Row => ({
  nextAction: { description: 'Review enquiry', dueAt: daysFromNow(2) },
  firstReplyAt: null,
  waitingSince: hoursAgo(5),
  audience: 'investor',
  ownerUserId: UUID_A,
  ...over,
});

describe('inbox sections', () => {
  it('puts a next action due before today in Overdue, whether or not anyone replied', () => {
    const yesterday = new Date(NOW - 86_400_000).toISOString();
    expect(sectionOf(row({ nextAction: { description: 'x', dueAt: yesterday } }), NOW)).toBe('overdue');
    expect(sectionOf(row({ firstReplyAt: hoursAgo(30), nextAction: { description: 'x', dueAt: yesterday } }), NOW)).toBe('overdue');
  });
  it('puts an unreplied enquiry whose next action is not yet due in No reply yet', () => {
    expect(sectionOf(row(), NOW)).toBe('no_reply');
  });
  it('puts a replied enquiry whose next action fell due earlier today in Due today', () => {
    const earlier = new Date(NOW - 3_600_000).toISOString();
    expect(sectionOf(row({ firstReplyAt: hoursAgo(30), nextAction: { description: 'x', dueAt: earlier } }), NOW)).toBe('due_today');
  });
  it('orders the sections Overdue, No reply yet, Due today, each oldest first, and drops empty ones', () => {
    const yesterday = new Date(NOW - 86_400_000).toISOString();
    const entries = [
      {
        id: 'due-today',
        row: row({ firstReplyAt: hoursAgo(9), waitingSince: hoursAgo(1), nextAction: { description: 'x', dueAt: hoursAgo(1) } }),
      },
      { id: 'new-late', row: row({ waitingSince: hoursAgo(2) }) },
      { id: 'new-early', row: row({ waitingSince: hoursAgo(48) }) },
      { id: 'overdue', row: row({ waitingSince: hoursAgo(80), nextAction: { description: 'x', dueAt: yesterday } }) },
    ];
    const groups = sectionQueue(entries, NOW);
    expect(groups.map((group) => group.title)).toEqual(['Overdue', 'No reply yet', 'Due today']);
    expect(groups.map((group) => group.entries.map((entry) => entry.id))).toEqual([['overdue'], ['new-early', 'new-late'], ['due-today']]);
    expect(sectionQueue([entries[1]!], NOW).map((group) => group.title)).toEqual(['No reply yet']);
    expect(sectionQueue([], NOW)).toEqual([]);
  });
});

describe('inbox tabs', () => {
  const entries = [
    { row: row({ audience: 'investor', ownerUserId: UUID_A }) },
    { row: row({ audience: 'investor', ownerUserId: UUID_B }) },
    { row: row({ audience: 'merchant', ownerUserId: UUID_A }) },
    { row: row({ audience: 'trader', ownerUserId: UUID_B }) },
    { row: row({ audience: 'partner', ownerUserId: UUID_B }) },
  ];
  it('counts and filters Investors, Everyone else, Mine and All', () => {
    expect(tabCounts(entries, UUID_A)).toEqual({ investors: 2, others: 3, mine: 2, all: 5 });
    expect(tabRows('investors', entries, UUID_A).every((entry) => entry.row.audience === 'investor')).toBe(true);
    expect(tabRows('others', entries, UUID_A).some((entry) => entry.row.audience === 'investor')).toBe(false);
    expect(tabRows('mine', entries, UUID_A).every((entry) => entry.row.ownerUserId === UUID_A)).toBe(true);
    expect(tabRows('all', entries, UUID_A)).toHaveLength(5);
  });
  it('says how many enquiries are open when nobody is waiting', () => {
    expect(emptyQueueNote(12)).toBe('12 open enquiries in total.');
    expect(emptyQueueNote(1)).toBe('1 open enquiry in total.');
    expect(emptyQueueNote(null)).toBe('');
  });
});

describe('waiting time', () => {
  it('words the wait as minutes, hours or days', () => {
    expect(waitingText(new Date(NOW - 30_000).toISOString(), NOW)).toBe('<1m');
    expect(waitingText(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12m');
    expect(waitingText(hoursAgo(5), NOW)).toBe('5h');
    expect(waitingText(hoursAgo(24 * 3 + 2), NOW)).toBe('3d');
    expect(waitingText(null, NOW)).toBe('—');
  });
  it('does not count Saturday and Sunday', () => {
    // Friday 09 Oct 18:00 to Monday 12 Oct 09:00 is 15 hours of weekday time, not 63.
    const friday = Date.parse('2026-10-09T18:00:00Z');
    const monday = Date.parse('2026-10-12T09:00:00Z');
    expect(businessMsBetween(friday, monday)).toBe(15 * 3_600_000);
    expect(businessMsBetween(monday, friday)).toBe(0);
  });
  it('turns amber past the reply target and red past twice the target (investor: 1 business day, others: 3)', () => {
    expect(REPLY_TARGET_BUSINESS_DAYS).toEqual({ investor: 1, other: 3 });
    // NOW is a Wednesday.
    expect(waitSeverity('investor', hoursAgo(20), NOW)).toBe('ok');
    expect(waitSeverity('investor', hoursAgo(30), NOW)).toBe('late');
    expect(waitSeverity('investor', hoursAgo(49), NOW)).toBe('very_late');
    expect(waitSeverity('merchant', hoursAgo(49), NOW)).toBe('ok');
    // 80 hours back is Saturday 02:00: only 58 hours of weekday time, still inside the 3-day target.
    expect(waitSeverity('merchant', hoursAgo(80), NOW)).toBe('ok');
    // Six days back (last Thursday) is 96 weekday hours: past 3 business days, not yet past 6.
    expect(waitSeverity('merchant', hoursAgo(24 * 6), NOW)).toBe('late');
    expect(waitSeverity('merchant', hoursAgo(24 * 14), NOW)).toBe('very_late');
    expect(waitSeverity('trader', null, NOW)).toBe('ok');
  });
  it('does not turn a weekend wait red', () => {
    const mondayMorning = Date.parse('2026-10-12T09:00:00Z');
    const fridayEvening = '2026-10-09T17:00:00Z';
    expect(waitSeverity('investor', fridayEvening, mondayMorning)).toBe('ok');
  });
});

describe('money display', () => {
  it('formats exact decimals without rounding or Number', () => {
    expect(formatMoney('250000', 'EUR')).toBe('€250,000');
    expect(formatMoney('12345678901234567890.123456789', 'EUR')).toBe('€12,345,678,901,234,567,890.123456789');
    expect(formatMoney('1200.50', 'CHF')).toBe('CHF 1,200.5');
    expect(formatMoney('50000', 'USD')).toBe('$50,000');
    expect(groupedDecimal('0.10')).toBe('0.1');
  });
  it('shortens only when nothing is lost', () => {
    expect(formatMoneyCompact('250000', 'EUR')).toBe('€250k');
    expect(formatMoneyCompact('250500', 'EUR')).toBe('€250.5k');
    expect(formatMoneyCompact('250550', 'EUR')).toBe('€250,550');
    expect(formatMoneyCompact('5000000', 'EUR')).toBe('€5M');
    expect(formatMoneyCompact('12500000', 'EUR')).toBe('€12.5M');
    expect(formatMoneyCompact('1234000', 'EUR')).toBe('€1,234,000');
    expect(formatMoneyCompact('250000.5', 'EUR')).toBe('€250,000.5');
    expect(formatMoneyCompact('900', 'EUR')).toBe('€900');
  });
  it('adds and divides decimal strings exactly', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(addDecimal('99999999999999999999', '1')).toBe('100000000000000000000');
    expect(addDecimal('100000', '250000.50')).toBe('350000.5');
    expect(shareTenths('100000', '5000000')).toBe(20);
    expect(tenthsText(20)).toBe('2.0%');
    expect(tenthsText(82)).toBe('8.2%');
    expect(shareTenths('7000000', '5000000')).toBe(1000);
    expect(shareTenths('1', '0')).toBe(0);
  });
  it('reads a typed amount as an exact decimal, or refuses it', () => {
    expect(parseTypedAmount('250,000')).toBe('250000');
    expect(parseTypedAmount(' 1 200.50 ')).toBe('1200.50');
    expect(parseTypedAmount('0')).toBeNull();
    expect(parseTypedAmount('-5')).toBeNull();
    expect(parseTypedAmount('1e6')).toBeNull();
    expect(parseTypedAmount('12.')).toBeNull();
    expect(parseTypedAmount('')).toBeNull();
  });
});

describe('raise figures', () => {
  const raise = {
    indicated: [
      { currency: 'EUR', amount: '1500000' },
      { currency: 'USD', amount: '50000' },
    ],
    softCircled: [{ currency: 'EUR', amount: '250000' }],
    committed: [
      { currency: 'EUR', amount: '100000' },
      { currency: 'GBP', amount: '20000' },
    ],
    counts: { indicated: 3, softCircled: 1, committed: 2, undecided: 1 },
  };
  it('fills the bar with committed euros only, then a ghost for soft-circled and a dotted end for indicated', () => {
    expect(RAISE_TARGET_EUR).toBe('5000000');
    const bar = raiseBar(raise);
    expect(bar.committedTenths).toBe(20);
    expect(bar.softTenths).toBe(50);
    expect(bar.indicatedTenths).toBe(300);
    expect([bar.fillEnd, bar.ghostEnd, bar.dottedEnd]).toEqual([20, 70, 370]);
  });
  it('caps the layers at the full bar and shows zero for a missing euro tier', () => {
    expect(raiseBar({ indicated: [], softCircled: [], committed: [{ currency: 'EUR', amount: '9000000' }] }).fillEnd).toBe(1000);
    const empty = raiseBar({ indicated: [], softCircled: [], committed: [] });
    expect(empty).toMatchObject({ committed: '0', softCircled: '0', indicated: '0', fillEnd: 0, dottedEnd: 0 });
  });
  it('lists the other currencies on their own, never added to euros', () => {
    expect(otherCurrencies(raise)).toEqual([
      { currency: 'GBP', indicated: '0', softCircled: '0', committed: '20000' },
      { currency: 'USD', indicated: '50000', softCircled: '0', committed: '0' },
    ]);
    expect(raiseBar(raise).committed).toBe('100000');
  });
  it('counts investors per stage in stage order and open enquiries across audiences', () => {
    const byStage = [
      { audience: 'investor', stage: 'qualified', count: 3 },
      { audience: 'investor', stage: 'new', count: 2 },
      { audience: 'investor', stage: 'closed', count: 1 },
      { audience: 'trader', stage: 'new', count: 4 },
      { audience: 'trader', stage: 'closed', count: 5 },
    ] as Parameters<typeof investorStageCounts>[0];
    expect(investorStageCounts(byStage)).toEqual([
      { stage: 'new', count: 2 },
      { stage: 'qualified', count: 3 },
      { stage: 'diligence', count: 0 },
      { stage: 'terms', count: 0 },
      { stage: 'closed', count: 1 },
    ]);
    expect(openEnquiries(byStage)).toBe(9);
  });
});

describe('answers in plain words', () => {
  it('rewords every enum and never prints a raw snake_case value', () => {
    expect(answerText('investorType', 'family_office')).toBe('Family office');
    expect(answerText('timing', 'within_three_months')).toBe('Within 3 months');
    expect(answerText('decisionRole', 'decision_maker')).toBe('Decision maker');
    expect(answerText('participation', 'both')).toBe('Direct and introductions');
    expect(answerText('markets', ['spot', 'copy_trading'])).toBe('Spot, Copy trading');
    expect(answerText('services', ['payment_acceptance'])).toBe('Payment acceptance');
    expect(answerText('relationship', 'partnership')).toBe('Partnership');
    expect(answerText('operatingCountries', ['SG'])).toMatch(/Singapore|SG/);
    expect(answerText('indicativeContribution', { status: 'stated', amount: '250000', currency: 'EUR' })).toBe('€250,000');
    expect(answerText('indicativeContribution', { status: 'undecided' })).toBe('Undecided');
    expect(answerText('processingVolume', { status: 'stated', amount: '40000', currency: 'EUR', period: 'monthly' })).toBe(
      '€40,000 a month',
    );
  });
  it('lists an investor’s key answers first, with the amount marked self-reported', () => {
    const facts = keyFacts('investor', {
      investorType: 'fund',
      participation: 'direct',
      decisionRole: 'adviser',
      indicativeContribution: { status: 'stated', amount: '2500000', currency: 'USD' },
      timing: 'later',
      message: 'Hello',
    });
    expect(facts.map((fact) => fact.label)).toEqual(['Indicated amount', 'Investor type', 'Role', 'Takes part', 'Timing']);
    expect(facts[0]).toMatchObject({ value: '$2,500,000', selfReported: true });
    expect(allFacts({ message: 'x', timing: 'later' }).map((fact) => fact.key)).toEqual(['timing']);
  });
  it('picks one signal per audience for the Everyone else rows', () => {
    expect(otherSignal('merchant', { processingVolume: { status: 'stated', amount: '40000', currency: 'EUR', period: 'monthly' } })).toBe(
      '€40,000 a month',
    );
    expect(otherSignal('trader', { role: 'community' })).toBe('Community leader');
    expect(otherSignal('partner', { relationship: 'collaboration' })).toBe('Collaboration');
    expect(otherSignal('academy', { format: 'self_paced' })).toBe('Self-paced');
    expect(otherSignal('trader', null)).toBeNull();
    expect(investorSignals({ investorType: 'individual', decisionRole: 'introducer', timing: 'within_three_months' })).toEqual({
      type: 'Individual',
      role: 'Introducer',
      timing: '≤ 3 months',
    });
  });
});

describe('reply and decline templates', () => {
  const investor = {
    audience: 'investor',
    name: 'Amara Okafor',
    founder: 'Nitro',
    answers: {
      investorType: 'family_office',
      timing: 'within_three_months',
      indicativeContribution: { status: 'stated', amount: '250000', currency: 'EUR' },
    },
  };
  it('prefills an investor reply from their answers and signs it with the founder', () => {
    const draft = replyDraft(investor);
    expect(draft.body).toContain('Hi Amara,');
    expect(draft.body).toContain('€250,000');
    expect(draft.body).toContain('indicative only');
    expect(draft.body).toContain('family office');
    expect(draft.body).toContain('within 3 months');
    expect(draft.body.trim().endsWith('INTAFACED')).toBe(true);
    expect(draft.body).toContain('Nitro');
    expect(draft.subject).toBe('Your INTAFACED enquiry');
  });
  it('has its own reply per audience and never promises a return or a date', () => {
    for (const audience of ['investor', 'trader', 'merchant', 'academy', 'partner']) {
      const draft = replyDraft({ audience, name: 'Sam Lee', founder: null, answers: null });
      expect(draft.body).toContain('Hi Sam,');
      expect(draft.body).toContain('The INTAFACED team');
      expect(draft.body).not.toMatch(/return|guarantee|profit|yield/i);
    }
    expect(replyDraft({ audience: 'trader', name: 'Sam', founder: 'Phantom', answers: null }).body).not.toBe(
      replyDraft({ audience: 'merchant', name: 'Sam', founder: 'Phantom', answers: null }).body,
    );
  });
  it('writes a polite decline for every reason chip', () => {
    for (const { label } of DECLINE_REASONS) {
      const draft = declineDraft(label, { name: 'Amara Okafor', founder: 'Phantom' });
      expect(draft.body).toContain('Hi Amara,');
      expect(draft.body).toContain('Phantom');
      expect(draft.body.length).toBeGreaterThan(150);
    }
    expect(declineDraft('Waitlist', { name: 'A B', founder: null }).body).toContain('waiting list');
  });
  it('builds a mailto link to the original address with the subject and text encoded', () => {
    const href = mailtoHref('amara@example.invalid', { subject: 'Your INTAFACED enquiry', body: 'Hi Amara,\n\nThanks & regards' });
    expect(href.startsWith('mailto:amara@example.invalid?subject=Your%20INTAFACED%20enquiry&body=')).toBe(true);
    expect(href).toContain('Hi%20Amara%2C%0D%0A%0D%0AThanks%20%26%20regards');
    expect(DRAFT_HEADER).toBe("DRAFT: awaiting Nitro's approval of wording");
  });
});

describe('what each action sends', () => {
  it('Mark replied needs no typing: now, "Replied by email", then "Wait for their reply" due in 5 days at 09:00', () => {
    const result = markRepliedInput({ opportunityId: UUID_A, expectedRevision: 3, now: NOW });
    expect(result).toEqual({
      ok: true,
      input: {
        opportunityId: UUID_A,
        expectedRevision: 3,
        kind: 'reply_sent',
        occurredAt: '2026-10-14T10:00:00.000Z',
        nextAction: { description: 'Wait for their reply', dueAt: '2026-10-19T09:00:00.000Z' },
        reason: 'Replied by email',
      },
    });
  });
  it('lets chips change the reason, the next step and the due day, and refuses an empty or over-long one', () => {
    const changed = markRepliedInput({
      opportunityId: UUID_A,
      expectedRevision: 3,
      now: NOW,
      reason: 'Replied by phone',
      description: 'Schedule a call',
      days: 3,
    });
    expect(changed).toMatchObject({
      ok: true,
      input: { reason: 'Replied by phone', nextAction: { description: 'Schedule a call', dueAt: '2026-10-17T09:00:00.000Z' } },
    });
    expect(markRepliedInput({ opportunityId: UUID_A, expectedRevision: 3, description: ' ' }).ok).toBe(false);
    expect(markRepliedInput({ opportunityId: UUID_A, expectedRevision: 3, description: 'x'.repeat(161) }).ok).toBe(false);
  });
  it('Next step turns a chip and a due day into the contract input', () => {
    expect(quickDue(1, NOW)).toBe('2026-10-15T09:00');
    expect(nextStepInput({ opportunityId: UUID_A, expectedRevision: 2, description: ' Send follow-up ', due: quickDue(3, NOW) })).toEqual({
      ok: true,
      input: { opportunityId: UUID_A, expectedRevision: 2, description: 'Send follow-up', dueAt: '2026-10-17T09:00:00.000Z' },
    });
    expect(nextStepInput({ opportunityId: UUID_A, expectedRevision: 2, description: '', due: '2026-10-17T09:00' }).ok).toBe(false);
    expect(nextStepInput({ opportunityId: UUID_A, expectedRevision: 2, description: 'x', due: '' }).ok).toBe(false);
  });
  it('hands to the other founder, and to nobody when the founder names did not both load', () => {
    const owners = [
      { userId: UUID_A, displayName: 'Nitro' },
      { userId: UUID_B, displayName: 'Phantom' },
    ];
    expect(otherFounder(owners, UUID_A)?.displayName).toBe('Phantom');
    expect(otherFounder(owners.slice(0, 1), UUID_A)).toBeNull();
    expect(handOverInput({ opportunityId: UUID_A, expectedRevision: 4, ownerUserId: UUID_B })).toEqual({
      opportunityId: UUID_A,
      expectedRevision: 4,
      ownerUserId: UUID_B,
    });
  });
});

describe('Decline maps its reason chips to the closed outcome', () => {
  it('uses declined, declined, withdrawn and waitlisted', () => {
    expect(DECLINE_REASONS.map((entry) => [entry.label, dispositionOf(entry.label)])).toEqual([
      ['Not a fit now', 'declined'],
      ['Round full', 'declined'],
      ['Withdrawn by them', 'withdrawn'],
      ['Waitlist', 'waitlisted'],
    ]);
  });
  it('fills the evidence as "Decline reply sent by email on 14 Oct 2026 by Nitro" and stays inside the 256-character limit', () => {
    expect(declineEvidence({ now: NOW, founder: 'Nitro', sentByEmail: true })).toBe('Decline reply sent by email on 14 Oct 2026 by Nitro');
    expect(declineEvidence({ now: NOW, founder: 'Phantom', sentByEmail: false })).toBe('Closed without a reply on 14 Oct 2026 by Phantom');
    expect(declineEvidence({ now: NOW, founder: null, sentByEmail: true })).toBe('Decline reply sent by email on 14 Oct 2026 by a founder');
    expect(declineEvidence({ now: NOW, founder: 'N'.repeat(400), sentByEmail: true }).length).toBeLessThanOrEqual(LIMITS.closingEvidence);
  });
  it('closes with no next action, the outcome, the reason and the evidence the contract requires', () => {
    expect(
      declineInput({
        opportunityId: UUID_A,
        expectedRevision: 5,
        reason: 'Withdrawn by them',
        founder: 'Nitro',
        sentByEmail: true,
        now: NOW,
      }),
    ).toEqual({
      ok: true,
      input: {
        opportunityId: UUID_A,
        expectedRevision: 5,
        stage: 'closed',
        reason: 'Withdrawn by them',
        nextAction: null,
        closedDisposition: 'withdrawn',
        closingEvidenceRef: 'Decline reply sent by email on 14 Oct 2026 by Nitro',
      },
    });
  });
});

describe('Stage change with reason chips', () => {
  const base = {
    opportunityId: UUID_A,
    expectedRevision: 2,
    reason: 'Reviewed: fits',
    actionDescription: 'Schedule a call',
    actionDue: '2026-10-16T09:00',
    disposition: 'proceeded' as const,
    evidence: '',
  };
  it('needs a reason and, for an open stage, a next action', () => {
    expect(stageInput({ ...base, stage: 'qualified' })).toMatchObject({
      ok: true,
      input: {
        stage: 'qualified',
        reason: 'Reviewed: fits',
        nextAction: { description: 'Schedule a call', dueAt: '2026-10-16T09:00:00.000Z' },
        closedDisposition: null,
        closingEvidenceRef: null,
      },
    });
    expect(stageInput({ ...base, stage: 'qualified', reason: '  ' }).ok).toBe(false);
    expect(stageInput({ ...base, stage: 'qualified', actionDescription: '' }).ok).toBe(false);
    expect(stageInput({ ...base, stage: 'qualified', reason: 'x'.repeat(501) }).ok).toBe(false);
  });
  it('closing needs an outcome and evidence and carries no next action', () => {
    expect(stageInput({ ...base, stage: 'closed', disposition: 'duplicate', evidence: 'Duplicate of another enquiry' })).toMatchObject({
      ok: true,
      input: { stage: 'closed', nextAction: null, closedDisposition: 'duplicate', closingEvidenceRef: 'Duplicate of another enquiry' },
    });
    expect(stageInput({ ...base, stage: 'closed', evidence: '' }).ok).toBe(false);
    expect(stageInput({ ...base, stage: 'closed', evidence: 'x'.repeat(257) }).ok).toBe(false);
  });
});

describe('Commitment', () => {
  const base = { opportunityId: UUID_A, expectedRevision: 2, currency: 'EUR', evidence: '', reason: 'After the call' };
  it('records a soft-circled amount as an exact decimal string, in the currency chosen', () => {
    expect(commitmentInput({ ...base, tier: 'soft_circled', amount: '250,000', evidence: 'Call 14 Oct' })).toEqual({
      ok: true,
      input: {
        opportunityId: UUID_A,
        expectedRevision: 2,
        reason: 'After the call',
        commitment: { tier: 'soft_circled', amount: '250000', currency: 'EUR', evidenceRef: 'Call 14 Oct' },
      },
    });
    const large = commitmentInput({ ...base, tier: 'committed', amount: '12345678901234567890.123456789', currency: 'usd' });
    expect(large).toMatchObject({ ok: true, input: { commitment: { amount: '12345678901234567890.123456789', currency: 'USD' } } });
  });
  it('clears with Indicated and needs no amount', () => {
    expect(commitmentInput({ ...base, tier: 'indicated', amount: '' })).toMatchObject({ ok: true, input: { commitment: null } });
  });
  it('refuses a bad amount, currency, over-long note or missing reason', () => {
    expect(commitmentInput({ ...base, tier: 'committed', amount: '0' }).ok).toBe(false);
    expect(commitmentInput({ ...base, tier: 'committed', amount: 'abc' }).ok).toBe(false);
    expect(commitmentInput({ ...base, tier: 'committed', amount: '10', currency: 'EURO' }).ok).toBe(false);
    expect(commitmentInput({ ...base, tier: 'committed', amount: '10', evidence: 'x'.repeat(201) }).ok).toBe(false);
    expect(commitmentInput({ ...base, tier: 'committed', amount: '10', reason: '' }).ok).toBe(false);
  });
  it('reads a row’s tier from its commitment', () => {
    expect(tierOf({ audience: 'investor', commitment: { tier: 'committed' } })).toBe('committed');
    expect(tierOf({ audience: 'investor', commitment: null })).toBe('indicated');
    expect(tierOf({ audience: 'trader' })).toBe('indicated');
  });
});

describe('timeline', () => {
  const owners = [
    { userId: UUID_A, displayName: 'Nitro' },
    { userId: UUID_B, displayName: 'Phantom' },
  ];
  const activity = (over: Record<string, unknown>) =>
    ({
      id: String(over.id ?? 'a'),
      sequence: 1,
      kind: 'note',
      actor: { kind: 'operator', userId: UUID_A },
      note: null,
      referenceId: null,
      occurredAt: hoursAgo(1),
      ...over,
    }) as Parameters<typeof describeActivity>[0];

  it('reads a stage change as "New → Qualified" and keeps the reason as the line under it', () => {
    expect(
      describeActivity(activity({ kind: 'stage_changed', fromStage: 'new', toStage: 'qualified', note: 'Reviewed: fits' }), owners),
    ).toEqual({
      title: 'New → Qualified',
      detail: 'Reviewed: fits',
    });
  });
  it('keeps the older wording and the reason text for an entry written before from and to were recorded', () => {
    expect(describeActivity(activity({ kind: 'stage_changed', note: 'Moved the call' }), owners)).toEqual({
      title: 'Stage or next action updated',
      detail: 'Moved the call',
    });
  });
  it('words a commitment change with the amount, and a cleared one', () => {
    expect(
      describeActivity(
        activity({
          kind: 'commitment_changed',
          toCommitment: { tier: 'soft_circled', amount: '250000', currency: 'EUR' },
          fromCommitment: null,
          note: 'After the call',
        }),
        owners,
      ),
    ).toEqual({
      title: 'Commitment: Soft-circled €250,000',
      detail: 'After the call',
    });
    expect(
      describeActivity(
        activity({
          kind: 'commitment_changed',
          toCommitment: null,
          fromCommitment: { tier: 'committed', amount: '100000', currency: 'EUR' },
        }),
        owners,
      ).title,
    ).toBe('Commitment cleared');
  });
  it('merges activities and messages newest first, joining a message to its queued entry', () => {
    const items = buildTimeline({
      owners,
      activities: [
        activity({
          id: 'q',
          sequence: 1,
          kind: 'questionnaire_submitted',
          actor: { kind: 'prospect', submissionId: UUID_B },
          occurredAt: hoursAgo(10),
        }),
        activity({ id: 'n', sequence: 2, kind: 'note', note: 'Spoke to the assistant', occurredAt: hoursAgo(5) }),
        activity({
          id: 'e',
          sequence: 3,
          kind: 'email_status',
          note: 'Message queued: follow_up',
          referenceId: 'm1',
          occurredAt: hoursAgo(2),
        }),
      ],
      messages: [
        {
          id: 'm1',
          kind: 'follow_up',
          status: 'unconfigured',
          staffText: 'Just checking in.',
          actorUserId: UUID_A,
          createdAt: hoursAgo(2),
        },
        { id: 'm2', kind: 'information_request', status: 'pending', staffText: null, actorUserId: UUID_B, createdAt: hoursAgo(7) },
      ],
    });
    expect(items.map((item) => item.id)).toEqual(['e', 'n', 'message:m2', 'q']);
    expect(items[0]).toMatchObject({ title: 'Message queued: Follow-up', who: 'Nitro' });
    expect(items[0]!.detail).toContain('Just checking in.');
    expect(items[2]).toMatchObject({ kind: 'message', who: 'Phantom' });
    expect(items[3]!.who).toBe('Enquirer');
  });
});

describe('address state', () => {
  const ID = '0b7a6c2e-5a40-4a1f-9d1b-3a9a3c1f2b11';
  it('reads the view and the enquiry', () => {
    expect(parseCrmUrl(`?view=raise&enquiry=${ID}`)).toEqual({ view: 'raise', enquiry: ID });
    expect(parseCrmUrl('?view=people')).toEqual({ view: 'people', enquiry: null });
    expect(parseCrmUrl('')).toEqual({ view: 'inbox', enquiry: null });
  });
  it('still opens the old /crm?enquiry=<id> address in the Inbox', () => {
    expect(parseCrmUrl(`?enquiry=${ID}`)).toEqual({ view: 'inbox', enquiry: ID });
  });
  it('ignores an unknown view, an enquiry that is not an id, and an enquiry in a tool view', () => {
    expect(parseCrmUrl('?view=admin&enquiry=nope')).toEqual({ view: 'inbox', enquiry: null });
    expect(parseCrmUrl(`?view=exports&enquiry=${ID}`)).toEqual({ view: 'exports', enquiry: null });
    expect(parseCrmUrl(`?view=duplicates`).view).toBe('duplicates');
  });
  it('writes the address back with only the view and the enquiry', () => {
    expect(crmUrl({ view: 'inbox', enquiry: null })).toBe('/crm?view=inbox');
    expect(crmUrl({ view: 'raise', enquiry: ID })).toBe(`/crm?view=raise&enquiry=${ID}`);
    expect(crmUrl({ view: 'exports', enquiry: ID })).toBe('/crm?view=exports');
    expect(crmUrl({ view: 'people', enquiry: 'not-an-id' })).toBe('/crm?view=people');
  });
});
