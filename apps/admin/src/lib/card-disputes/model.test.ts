import { describe, expect, it } from 'vitest';
import { refusalCode, lossWords, parseCase, parseQueue, parseQueuePage, procedureFor, readDisputeAction, readStateFilter } from './model';

const ID = '5a3b9c10-1111-4222-8333-444455556666';
const base = {
  id: ID,
  caseKey: 'k',
  cardId: '11111111-1111-4111-8111-111111111111',
  userId: 'u',
  authorizationRef: 'auth-1',
  assetId: 'USDC',
  amount: '50',
  reason: 'TEST',
  state: 'closed',
  test: true,
  provisionalCredit: { state: 'credited', amount: '50', partnerRef: 'TEST-card-sim-credit-abc', at: '2026-11-09T00:00:00.000Z' },
  createdAt: '2026-11-09T00:00:00.000Z',
};
const decision = (over: Record<string, unknown>) => ({
  outcome: 'cardholder',
  lossStatus: 'not_known',
  lossBearer: null,
  lossTerms: null,
  creditSettlement: 'final',
  creditSettlementPartnerRef: 'TEST-card-sim-final-abc',
  closedAt: '2026-11-09T00:00:00.000Z',
  ...over,
});

describe('card disputes model (J-bank-27)', () => {
  it('reads "not known" for a loss the partner has not reported, never the partner', () => {
    const [row] = parseQueue([{ ...base, decision: decision({}) }])!;
    expect(lossWords(row!.decision!)).toBe('not known');
    const [reported] = parseQueue([
      { ...base, decision: decision({ lossStatus: 'reported', lossBearer: 'programme', lossTerms: 'TEST terms' }) },
    ])!;
    expect(lossWords(reported!.decision!)).toBe('The programme (INTAFACED), under the partner’s terms: TEST terms');
  });

  it('refuses a drifting answer: a reported loss with no bearer, a "not known" with one, a number for an amount', () => {
    expect(parseQueue([{ ...base, decision: decision({ lossStatus: 'reported' }) }])).toBeNull();
    expect(parseQueue([{ ...base, decision: decision({ lossBearer: 'partner' }) }])).toBeNull();
    expect(parseQueue([{ ...base, amount: 50, decision: null }])).toBeNull();
    expect(parseQueuePage({ rows: [{ ...base, decision: null }], more: true })?.more).toBe(true);
    expect(parseQueuePage([{ ...base, decision: null }])).toBeNull();
    expect(parseCase({ ...base, decision: null, cap: null, events: [{ sequence: 1 }] })).toBeNull();
    expect(parseCase({ ...base, decision: null, cap: '100', events: [] })?.cap).toBe('100');
  });

  it('reads only the steps it knows, each with exactly its fields', () => {
    expect(readDisputeAction({ action: 'credit', disputeId: ID })).toEqual({ action: 'credit', disputeId: ID });
    expect(readDisputeAction({ action: 'credit', disputeId: ID, amount: '50' })).toBeNull();
    expect(readDisputeAction({ action: 'decide', disputeId: ID, outcome: 'partner' })).toBeNull();
    expect(readDisputeAction({ action: 'evidence', disputeId: ID, stepKey: 'short', description: 'x' })).toBeNull();
    const ev = readDisputeAction({ action: 'evidence', disputeId: ID, stepKey: 'console-dispute-1234', description: ' receipt ' });
    expect(ev).toEqual({ action: 'evidence', disputeId: ID, stepKey: 'console-dispute-1234', description: 'receipt' });
    expect(procedureFor(ev!)).toEqual({
      procedure: 'ops.cardDisputeEvidence',
      body: { disputeId: ID, stepKey: 'console-dispute-1234', description: 'receipt' },
    });
    expect(readStateFilter('arbitration')).toBe('arbitration');
    expect(readStateFilter('nope')).toBeNull();
    expect(readStateFilter(['opened'])).toBeNull();
  });

  it("finds the typed refusal at the end of svc-bank's message when the wire carries no cause", () => {
    expect(refusalCode(null, 'The disputed 250 USDC is above the dispute cap of 100.00 USDC (bank.card_dispute_cap_exceeded)')).toBe(
      'bank.card_dispute_cap_exceeded',
    );
    expect(refusalCode('bank.x', 'anything')).toBe('bank.x');
    expect(refusalCode(null, 'no code here')).toBeNull();
  });
});
