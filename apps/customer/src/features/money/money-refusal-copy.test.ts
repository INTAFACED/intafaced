import { describe, expect, it } from 'vitest';
import { moneyRefusalCopy, moneyRefusalWords, REFUSED_BEFORE_POSTING, settleRefusal, withPlainRefusal } from './money-refusal-copy';
import type { ApiResult } from '../../shared/api';

const failure = (status: number | undefined, code: string | undefined, reason: 'error' | 'uncertain' = 'error'): ApiResult<unknown> => ({
  ok: false,
  reason,
  message: 'operator text',
  ...(status === undefined ? {} : { status }),
  ...(code === undefined ? {} : { code }),
});

describe('words for the bank’s typed refusals', () => {
  it('has a sentence in every language for every code it covers', () => {
    expect(REFUSED_BEFORE_POSTING.size).toBeGreaterThan(40);
    for (const locale of ['en', 'es', 'fr'] as const) {
      expect(moneyRefusalCopy.coverage(locale).missing, locale).toEqual([]);
      for (const code of REFUSED_BEFORE_POSTING) expect(moneyRefusalWords(code, locale), `${locale} ${code}`).toBeTruthy();
    }
    // The other languages are real translations, not the English sentence repeated.
    expect(moneyRefusalWords('bank.cards_disabled', 'es')).not.toBe(moneyRefusalWords('bank.cards_disabled', 'en'));
    expect(moneyRefusalWords('bank.cards_disabled', 'fr')).not.toBe(moneyRefusalWords('bank.cards_disabled', 'en'));
  });
  it('never shows a raw code, or a promise about later, in any language', () => {
    for (const locale of ['en', 'es', 'fr'] as const)
      for (const code of REFUSED_BEFORE_POSTING) {
        const words = moneyRefusalWords(code, locale)!;
        expect(words, `${locale} ${code}`).not.toMatch(/\b[a-z]+\.[a-z0-9]+_[a-z0-9_]+\b/);
        expect(words, `${locale} ${code}`).not.toMatch(/\byet\b|coming soon|for now|pas encore|aún no|todavía no/i);
        expect(words.trim().length).toBeGreaterThan(10);
      }
  });
  it('reads the code case-insensitively and gives nothing for a code it does not know', () => {
    expect(moneyRefusalWords('BANK.BUSINESS_SELF_APPROVE')).toContain('second person');
    expect(moneyRefusalWords('bank.something_new')).toBeNull();
    expect(moneyRefusalWords(undefined)).toBeNull();
    expect(moneyRefusalWords('')).toBeNull();
  });
  it('covers the refusals of cards, team, payroll, lookups and transfer notes', () => {
    for (const code of [
      'bank.card_limit_exceeded',
      'bank.card_shipping_address_required',
      'bank.card_issue_conflict',
      'bank.card_command_conflict',
      'bank.card_sim_not_live',
      'bank.no_card_issuer',
      'bank.cards_disabled',
      'bank.step_up_required',
      'bank.business_self_approve',
      'bank.business_payroll_rate_unset',
      'bank.business_payroll_conflict',
      'bank.business_directory_rate_limited',
      'bank.business_directory_unset',
      'bank.business_directory_unavailable',
      'bank.business_directory_incomplete',
      'bank.business_recipient_query',
      'bank.personal_note_invalid',
      'bank.personal_reference_invalid',
      'bank.personal_transfer_conflict',
      'bank.recipient_cannot_receive',
    ])
      expect(REFUSED_BEFORE_POSTING.has(code), code).toBe(true);
  });
  it('does not claim a lost or unknown ledger answer is a clean refusal', () => {
    for (const code of ['bank.ledger_outcome_unknown', 'bank.transfers_disabled', 'ledger.unavailable', 'bank.prices_unavailable'])
      expect(REFUSED_BEFORE_POSTING.has(code), code).toBe(false);
  });
});

describe('reading a refusal that has come back', () => {
  it('turns a typed refusal made before posting into plain words and a definite no', () => {
    const settled = settleRefusal(failure(400, 'bank.card_limit_exceeded'));
    expect(settled.refusedFirst).toBe(true);
    expect(settled.outcome).toMatchObject({ ok: false, reason: 'error', message: 'A card limit must be more than zero.' });
  });
  it('treats a switched-off module as a definite no even though it answers 503', () => {
    const settled = settleRefusal(failure(503, 'bank.cards_disabled', 'uncertain'));
    expect(settled.refusedFirst).toBe(true);
    expect(settled.outcome).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'Cards are switched off right now. Nothing was changed.',
    });
  });
  it('leaves an unknown outcome unconfirmed: no status, no code, an unknown code or a lost ledger answer', () => {
    for (const bad of [
      failure(undefined, 'bank.card_limit_exceeded'),
      failure(400, undefined),
      failure(400, 'bank.who_knows'),
      failure(503, 'bank.ledger_outcome_unknown', 'uncertain'),
    ]) {
      const settled = settleRefusal(bad);
      expect(settled.refusedFirst).toBe(false);
      expect(settled.outcome).toBe(bad);
    }
  });
  it('passes a success straight through', () => {
    const ok: ApiResult<unknown> = { ok: true, data: { id: 'x' } };
    expect(settleRefusal(ok)).toEqual({ outcome: ok, refusedFirst: false });
  });
  it('puts plain words on a failed read without touching one it has no words for', () => {
    expect(withPlainRefusal({ code: 'bank.business_directory_unset', message: 'operator text' }).message).toContain(
      'People lookup is not set up',
    );
    const other = { code: 'x.y', message: 'keep me' };
    expect(withPlainRefusal(other)).toBe(other);
  });
});
