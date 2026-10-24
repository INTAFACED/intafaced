import { describe, expect, it } from 'vitest';
import {
  amountProblem,
  askedField,
  canRecall,
  canonicalCompliance,
  complianceMap,
  compareAmounts,
  destinationsFrom,
  hasLeft,
  lockDeadline,
  lockLeft,
  progressOf,
  proofProblem,
  recipientKey,
  sendInput,
  sendStepUpRequest,
  type Corridor,
  type SendDraft,
} from './global-model';
import { createGlobalApi } from './global-api';
import { refusalCopy } from '../../data/refusals';

const corridor: Corridor = {
  country: 'DE',
  currency: 'EUR',
  deliveryMethods: ['bank', 'wallet'],
  minAmount: '10',
  maxAmount: '1000.5',
  cutOffTime: '16:00',
  payoutMethods: ['bank'],
};
const draft: SendDraft = {
  idempotencyKey: 'global-send:abc-123',
  fromSpaceId: '11111111-1111-4111-8111-111111111111',
  assetId: 'USDT',
  amount: '25.50',
  toCurrency: 'EUR',
  recipientId: '22222222-2222-4222-8222-222222222222',
  country: 'DE',
  deliveryMethod: 'bank',
  compliance: {},
  quoteId: '33333333-3333-4333-8333-333333333333',
};

describe('destinations', () => {
  it('lists one row per delivery method, from the published corridors only', () => {
    expect(destinationsFrom([corridor]).map((row) => row.key)).toEqual(['DE|EUR|bank', 'DE|EUR|wallet']);
    // Only the methods a payout partner covers are paid out; the rest are listed and say so.
    expect(destinationsFrom([corridor]).map((row) => row.paysOut)).toEqual([true, false]);
    expect(destinationsFrom([])).toEqual([]);
  });
});

describe('amounts', () => {
  it('compares decimals without a float', () => {
    expect(compareAmounts('0.1', '0.10')).toBe(0);
    expect(compareAmounts('1000.5', '1000.50000000000000001')).toBe(-1);
    expect(compareAmounts('9.99', '10')).toBe(-1);
  });
  it('holds an amount to the destination’s published limits and invents none', () => {
    expect(amountProblem('', corridor)).toBe('empty');
    expect(amountProblem('0', corridor)).toBe('empty');
    expect(amountProblem('9.99', corridor)).toBe('belowMinimum');
    expect(amountProblem('1000.51', corridor)).toBe('aboveMaximum');
    expect(amountProblem('10', corridor)).toBeNull();
    expect(amountProblem('5', { ...corridor, minAmount: null, maxAmount: null })).toBeNull();
  });
});

describe('the confirmation is bound to exactly the send', () => {
  it('canonicalises the extra fields the way the service does', () => {
    expect(canonicalCompliance({})).toBe('');
    expect(canonicalCompliance({ reference: ' ', purpose: '' })).toBe('');
    expect(canonicalCompliance({ reference: ' INV 7 ', purpose: 'rent' })).toBe('{"purpose":"rent","reference":"INV 7"}');
    expect(complianceMap({ reference: ' INV 7 ' })).toEqual({ reference: 'INV 7' });
    expect(complianceMap({})).toBeUndefined();
  });
  it('asks the identity service for the global-send door with the same strings the send carries', () => {
    const withFields = { ...draft, compliance: { sourceOfFunds: 'salary', purpose: 'family' } };
    const begin = sendStepUpRequest(withFields);
    expect(begin).toMatchObject({ scope: 'bank.step_up.global.send', purpose: 'global.send', amount: '25.50', target: draft.recipientId });
    expect(Object.keys(begin.fields).sort()).toEqual(
      [
        'amount',
        'assetId',
        'compliance',
        'country',
        'deliveryMethod',
        'fromSpaceId',
        'idempotencyKey',
        'quoteId',
        'recipientId',
        'toCurrency',
      ].sort(),
    );
    const send = sendInput(withFields, 'approval-1');
    // The rate lock the person confirmed is bound and sent as the same string.
    expect(begin.fields.quoteId).toBe(send.quoteId);
    expect(send.compliance).toEqual({ purpose: 'family', sourceOfFunds: 'salary' });
    expect(JSON.stringify(send.compliance)).toBe(begin.fields.compliance);
    expect(sendInput(draft, 'approval-1')).not.toHaveProperty('compliance');
    expect(sendStepUpRequest(draft).fields.compliance).toBe('');
  });
  it('sends nothing but the service’s fields', () => {
    expect(Object.keys(sendInput(draft, 'a')).sort()).toEqual(
      [
        'amount',
        'country',
        'deliveryMethod',
        'fromSpaceId',
        'idempotencyKey',
        'quoteId',
        'recipientId',
        'stepUpApprovalId',
        'toCurrency',
      ].sort(),
    );
  });
});

describe('the rate lock', () => {
  it('counts down what is left as m:ss and says nothing once it has run out', () => {
    const at = Date.parse('2026-10-23T12:00:00.000Z');
    expect(lockLeft(at + 300_000, at)).toBe('5:00');
    expect(lockLeft(at + 9_500, at)).toBe('0:10');
    expect(lockLeft(at, at)).toBeNull();
    expect(lockLeft(at - 60_000, at)).toBeNull();
    expect(lockLeft(Number.NaN, at)).toBeNull();
  });
  it('times the lock by its own length from when it was asked for, not by this device’s clock', () => {
    const quote = { lockedAt: '2026-10-23T12:00:00.000Z', validUntil: '2026-10-23T12:05:00.000Z' };
    // A device clock an hour off still gets the full five minutes.
    const asked = Date.parse('2026-10-23T13:00:00.000Z');
    expect(lockDeadline(quote, asked)).toBe(asked + 300_000);
    expect(lockLeft(lockDeadline(quote, asked), asked + 1_000)).toBe('4:59');
    expect(lockLeft(lockDeadline({ ...quote, lockedAt: 'not a time' }, asked), asked)).toBeNull();
  });
});

describe('refusals', () => {
  it('turns the three field refusals into the fields to show', () => {
    expect(askedField('bank.send_purpose_required')).toBe('purpose');
    expect(askedField('bank.source_of_funds_required')).toBe('sourceOfFunds');
    expect(askedField('bank.reference_too_long')).toBe('reference');
    expect(askedField('bank.global_fx_unset')).toBeNull();
    expect(askedField(undefined)).toBeNull();
  });
  it('words every global refusal, with no partner named and nothing promised for later', () => {
    const codes = [
      'bank.global_corridors_unset',
      'bank.global_fx_unset',
      'bank.global_payout_unset',
      'bank.global_travel_rule_undecided',
      'bank.send_field_rules_unset',
      'bank.reference_rules_unset',
      'bank.send_purpose_required',
      'bank.source_of_funds_required',
      'bank.reference_too_long',
      'bank.global_account_format_invalid',
      'bank.global_bic_format_invalid',
      'bank.global_payout_refused',
      'bank.global_corridor_unknown',
      'bank.global_amount_outside_corridor',
      'bank.global_travel_rule_incomplete',
      'bank.payee_blocked',
      'bank.exchange_allowance_exceeded',
      'bank.proof_limits_unset',
      'bank.proof_type_not_allowed',
      'bank.proof_too_large',
      'bank.proof_invalid',
      'bank.proof_not_requested',
      'bank.proof_already_uploaded',
      'bank.transfer_settled',
      'bank.global_send_cancelled',
      'bank.global_send_not_cancellable',
      'bank.receipt_not_ready',
      'bank.receipt_signing_unset',
      'bank.global_quote_required',
      'bank.global_quote_not_found',
      'bank.global_quote_mismatch',
      'bank.global_quote_used',
    ];
    for (const code of codes) {
      const words = refusalCopy(code);
      expect(words.title, code).not.toBe(refusalCopy('bank.nothing_like_this').title);
      expect(`${words.title} ${words.body}`).not.toMatch(/psp|socket|provider|coming soon|for now|not .* yet/i);
    }
    expect(refusalCopy('bank.global_quote_expired').title).toBe(refusalCopy('trade.convert_quote_expired').title);
  });
});

describe('tracking and recipients', () => {
  it('counts the steps a send has passed and none for a failed one', () => {
    expect(['submitted', 'sent', 'on_the_way', 'arrived', 'failed', 'held', 'cancelled'].map((s) => progressOf(s as never))).toEqual([
      0, 1, 2, 3, 0, 0, 0,
    ]);
  });
  it('gives a receipt for any send that left, and lets only one that has not come back be asked back', () => {
    const all = ['submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed', 'cancelled', 'returned', 'refunded'] as const;
    expect(all.filter(hasLeft)).toEqual(['sent', 'on_the_way', 'arrived', 'returned', 'refunded']);
    expect(all.filter(canRecall)).toEqual(['sent', 'on_the_way', 'arrived']);
    expect(progressOf('returned')).toBe(0);
  });
  it('keys a saved recipient by the person, the country and the normalised account', () => {
    expect(recipientKey('u1', 'de', 'de89 3704 0044 0532 0130 00')).toBe('global-recipient:u1:DE:DE89370400440532013000');
  });
});

describe('proof files', () => {
  const limits = { allowedTypes: ['application/pdf', 'image/png'], maxBytes: 1000 };
  it('judges a file only by the limits the service published', () => {
    expect(proofProblem({ type: 'application/pdf', size: 10 }, limits)).toBeNull();
    expect(proofProblem({ type: 'IMAGE/PNG', size: 1000 }, limits)).toBeNull();
    expect(proofProblem({ type: 'text/html', size: 10 }, limits)).toBe('type');
    expect(proofProblem({ type: 'application/pdf', size: 1001 }, limits)).toBe('size');
    expect(proofProblem({ type: 'application/pdf', size: 0 }, limits)).toBe('empty');
    expect(proofProblem({ type: 'application/pdf', size: 10 }, null)).toBe('noLimits');
  });
});

describe('the api', () => {
  it('calls the bank module’s global procedures and nothing else', async () => {
    const calls: string[] = [];
    const fake = {
      query: async (module: string, procedure: string) => (
        calls.push(`${module}.${procedure}`),
        { ok: false as const, reason: 'error' as const, message: 'x' }
      ),
      mutate: async (module: string, procedure: string) => (
        calls.push(`${module}.${procedure}`),
        { ok: false as const, reason: 'error' as const, message: 'x' }
      ),
    };
    const api = createGlobalApi(fake as never);
    await api.corridors();
    await api.recipients();
    await api.validate({ account: 'a' });
    await api.quote({ asset: 'USDT', amount: '1', toCurrency: 'EUR' });
    await api.sends();
    await api.addRecipient({ idempotencyKey: 'k1234567', name: 'n', account: 'a', country: 'DE' });
    await api.removeRecipient({ recipientId: 'r', idempotencyKey: 'k1234567' });
    await api.send(draft, 'approval');
    await api.hold('s1');
    await api.uploadProof({ id: 's1', name: 'a.pdf', type: 'application/pdf', contentBase64: 'AA==' });
    expect(calls).toEqual([
      'bank.global.corridors.list',
      'bank.global.recipients.list',
      'bank.global.recipients.validate',
      'bank.global.quote',
      'bank.global.list',
      'bank.global.recipients.add',
      'bank.global.recipients.remove',
      'bank.global.send',
      'bank.global.hold.get',
      'bank.global.hold.uploadProof',
    ]);
  });
});
