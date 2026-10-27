import { describe, expect, it } from 'vitest';
import {
  moneyRefusalCopy,
  moneyRefusalWords,
  REFUSAL_CHECKED_WRITES,
  REFUSED_BEFORE_POSTING,
  settleRefusal,
  withPlainRefusal,
} from './money-refusal-copy';
import { editedRequestChanged } from './components';
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
    expect(moneyRefusalWords('BANK.BUSINESS_DIRECTORY_UNSET')).toContain('People lookup');
    expect(moneyRefusalWords('bank.something_new')).toBeNull();
    expect(moneyRefusalWords(undefined)).toBeNull();
    expect(moneyRefusalWords('')).toBeNull();
  });
  it('covers the refusals of cards, team, payroll, lookups and transfer notes', () => {
    for (const code of [
      'bank.card_limit_exceeded',
      'bank.card_shipping_address_required',
      'bank.card_sim_not_live',
      'bank.no_card_issuer',
      'bank.cards_disabled',
      'bank.step_up_required',
      'bank.business_self_approve',
      'bank.business_payroll_rate_unset',
      'bank.business_directory_rate_limited',
      'bank.business_directory_unset',
      'bank.business_directory_unavailable',
      'bank.business_directory_incomplete',
      'bank.business_recipient_query',
      'bank.personal_note_invalid',
      'bank.personal_reference_invalid',
      'bank.recipient_cannot_receive',
      'bank.business_last_admin',
      'bank.business_member_has_pending',
    ])
      expect(REFUSED_BEFORE_POSTING.has(code), code).toBe(true);
  });
  it('keeps every conflict out of the clean refusals: the bank throws some of them after it has posted', () => {
    for (const code of [
      'bank.card_issue_conflict',
      'bank.card_command_conflict',
      'bank.business_payroll_conflict',
      'bank.business_request_conflict',
      'bank.personal_transfer_conflict',
      'bank.transfer_message_conflict',
      'bank.ramp_conflict',
    ]) {
      expect(REFUSED_BEFORE_POSTING.has(code), code).toBe(false);
      // They still have words, in every language, and none of them says to start again or that nothing was sent.
      for (const locale of ['en', 'es', 'fr'] as const) expect(moneyRefusalWords(code, locale), `${locale} ${code}`).toBeTruthy();
      expect(moneyRefusalWords(code)).not.toMatch(/start a new|nothing was sent|nothing was changed/i);
      expect(moneyRefusalWords(code)).toMatch(/already holds/);
    }
  });
  it('does not claim a lost or unknown ledger answer is a clean refusal', () => {
    for (const code of ['bank.ledger_outcome_unknown', 'bank.transfers_disabled', 'ledger.unavailable', 'bank.prices_unavailable'])
      expect(REFUSED_BEFORE_POSTING.has(code), code).toBe(false);
  });
});

describe('reading a refusal that has come back', () => {
  it('turns a typed refusal made before posting into plain words and a definite no, on a checked write', () => {
    const settled = settleRefusal(failure(400, 'bank.card_limit_exceeded'), 'cards.setLimits');
    expect(settled.refusedFirst).toBe(true);
    expect(settled.outcome).toMatchObject({ ok: false, reason: 'error', message: 'A card limit must be more than zero.' });
  });
  it('treats a switched-off module as a definite no even though it answers 503', () => {
    const settled = settleRefusal(failure(503, 'bank.cards_disabled', 'uncertain'), 'cards.issue');
    expect(settled.refusedFirst).toBe(true);
    expect(settled.outcome).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'Cards are switched off right now. Nothing was changed.',
    });
  });
  it('treats a taken address name as a clean refusal that clears the pending request', () => {
    const settled = settleRefusal(failure(409, 'bank.destination_label_taken', 'error'), 'ramps.destinations.rename');
    expect(settled.refusedFirst).toBe(true);
    expect(settled.outcome).toMatchObject({ ok: false, reason: 'error', message: expect.stringContaining('Nothing was changed') });
  });
  it('covers exactly the writes whose refusals were read in the bank', () => {
    expect([...REFUSAL_CHECKED_WRITES].sort()).toEqual([
      'business.removeMember',
      'business.runPayroll',
      'business.setMemberRole',
      'cards.issue',
      'cards.setChannels',
      'cards.setLimits',
      'cards.setStatus',
      'ramps.destinations.rename',
      'sharedPots.accept',
      'sharedPots.cancelInvite',
      'sharedPots.decline',
      'sharedPots.freezeCard',
      'sharedPots.invite',
      'sharedPots.leave',
      'sharedPots.linkCard',
      'sharedPots.remove',
      'sharedPots.unlinkCard',
      'spaces.create',
      'transfers.create',
      'transfers.toUser',
      'transfers.updateSchedule',
    ]);
  });
  it('reads a duplicate space name as changing nothing, with a way out', () => {
    const settled = settleRefusal(
      { ok: false, reason: 'error', status: 409, code: 'bank.space_name_taken', message: 'bank.space_name_taken' },
      'spaces.create',
    );
    expect(settled.refusedFirst).toBe(true);
    expect(settled.outcome).toMatchObject({
      reason: 'error',
      message: expect.stringMatching(/Pick another name\. Nothing was changed\.$/),
    });
  });
  it('reads a shared pot refusal as changing nothing, and a viewer’s refused transfer as sending nothing', () => {
    for (const code of [
      'bank.joint_unset',
      'bank.invite_expired',
      'bank.invite_not_found',
      'bank.invitee_not_found',
      'bank.shared_pot_full',
      'bank.shared_pot_invalid',
    ]) {
      const settled = settleRefusal({ ok: false, reason: 'error', status: 409, code, message: code }, 'sharedPots.accept');
      expect(settled.refusedFirst, code).toBe(true);
      expect(settled.outcome).toMatchObject({ reason: 'error', message: expect.stringMatching(/Nothing was (changed|sent)\.$/) });
    }
    const viewer = settleRefusal(
      { ok: false, reason: 'error', status: 403, code: 'bank.space_forbidden', message: 'bank.space_forbidden' },
      'transfers.create',
    );
    expect(viewer.refusedFirst).toBe(true);
    expect(viewer.outcome).toMatchObject({ reason: 'error', message: expect.stringContaining('Nothing was sent.') });
  });
  it('a refused freeze of a pot’s card says why in the pot’s words, and that nothing changed', () => {
    const viewer = settleRefusal(
      { ok: false, reason: 'error', status: 403, code: 'bank.space_forbidden', message: 'bank.space_forbidden' },
      'sharedPots.freezeCard',
    );
    expect(viewer.refusedFirst).toBe(true);
    expect(viewer.outcome).toMatchObject({
      message: 'You can see this shared pot, but only its owner and contributors can freeze its card. Nothing was changed.',
    });
    expect(moneyRefusalWords('bank.card_not_found', 'en', 'sharedPots.freezeCard')).toBe(
      'No card is linked to this pot any more. Nothing was changed.',
    );
    expect(moneyRefusalWords('bank.shared_pot_invalid', 'en', 'sharedPots.linkCard')).toMatch(/^This pot already has a linked card/);
  });
  it('reads a standing-order edit refusal as changing nothing, a stale revision included', () => {
    for (const code of [
      'bank.schedule_revision_conflict',
      'bank.schedule_cutoff',
      'bank.schedule_edit_cutoff_unset',
      'bank.schedule_inactive',
      'bank.schedule_not_found',
    ]) {
      const settled = settleRefusal({ ok: false, reason: 'error', status: 409, code, message: code }, 'transfers.updateSchedule');
      expect(settled.refusedFirst, code).toBe(true);
      expect(settled.outcome).toMatchObject({ reason: 'error', message: expect.stringContaining('Nothing was changed') });
    }
  });
  it('leaves every other write as it was: insufficient funds on a loan repayment or a cash-out stays unconfirmed', () => {
    for (const procedure of [
      'loans.repay',
      'loans.open',
      'ramps.offramp',
      'earn.deposit',
      'autoInvest.createDca',
      'business.proposeTransfer',
      'business.approve',
    ]) {
      for (const code of ['ledger.insufficient_funds', 'bank.below_minimum', 'bank.space_locked']) {
        const bad = failure(400, code);
        const settled = settleRefusal(bad, procedure);
        expect(settled.refusedFirst, `${procedure} ${code}`).toBe(false);
        expect(settled.outcome, `${procedure} ${code}`).toBe(bad);
      }
    }
  });
  it('gives a conflict words but keeps it unconfirmed, on a checked write and on any other', () => {
    for (const procedure of [
      'business.runPayroll',
      'transfers.toUser',
      'cards.setLimits',
      'cards.issue',
      'business.proposeTransfer',
      'ramps.offramp',
    ]) {
      for (const code of [
        'bank.business_request_conflict',
        'bank.business_payroll_conflict',
        'bank.personal_transfer_conflict',
        'bank.card_command_conflict',
        'bank.card_issue_conflict',
        'bank.transfer_message_conflict',
        'bank.ramp_conflict',
      ]) {
        const settled = settleRefusal(failure(409, code), procedure);
        expect(settled.refusedFirst, `${procedure} ${code}`).toBe(false);
        expect(settled.outcome, `${procedure} ${code}`).toMatchObject({
          ok: false,
          reason: 'uncertain',
          message: expect.stringContaining('already holds'),
        });
      }
    }
  });
  it('keeps a card that could not be issued unconfirmed for an order, but a clean refusal for a change', () => {
    const order = settleRefusal(failure(400, 'bank.card_not_found'), 'cards.issue');
    expect(order.refusedFirst).toBe(false);
    expect(order.outcome).toMatchObject({
      reason: 'uncertain',
      message: expect.stringContaining('could not confirm that this card was issued'),
    });
    const change = settleRefusal(failure(400, 'bank.card_not_found'), 'cards.setLimits');
    expect(change.refusedFirst).toBe(true);
  });
  it('says a payroll over the limit must stay below it, not that a second person must decide', () => {
    const settled = settleRefusal(failure(400, 'bank.business_self_approve'), 'business.runPayroll');
    expect(settled.refusedFirst).toBe(true);
    expect((settled.outcome as { message: string }).message).toContain('must stay below the approval limit');
    const approval = failure(400, 'bank.business_self_approve');
    expect(settleRefusal(approval, 'business.approve').outcome).toBe(approval);
  });
  it('leaves an unknown outcome unconfirmed: no status, no code, an unknown code or a lost ledger answer', () => {
    for (const bad of [
      failure(undefined, 'bank.card_limit_exceeded'),
      failure(400, undefined),
      failure(400, 'bank.who_knows'),
      failure(503, 'bank.ledger_outcome_unknown', 'uncertain'),
    ]) {
      const settled = settleRefusal(bad, 'cards.setLimits');
      expect(settled.refusedFirst).toBe(false);
      expect(settled.outcome).toBe(bad);
    }
  });
  it('passes a success straight through', () => {
    const ok: ApiResult<unknown> = { ok: true, data: { id: 'x' } };
    expect(settleRefusal(ok, 'cards.setLimits')).toEqual({ outcome: ok, refusedFirst: false });
  });
  it('puts plain words on a failed read without touching one it has no words for', () => {
    expect(withPlainRefusal({ code: 'bank.business_directory_unset', message: 'operator text' }).message).toContain(
      'People lookup is not set up',
    );
    const other = { code: 'x.y', message: 'keep me' };
    expect(withPlainRefusal(other)).toBe(other);
  });
});

describe('editing a refused request', () => {
  const id = '0c1f0a52-5c7f-4c1c-8e7b-6f2d3b9a1e44';
  it('is the same request when nothing changed, so a resend keeps its reference', () => {
    expect(editedRequestChanged({ transferId: id, amount: '5' }, { transferId: id, amount: '5' })).toBe(false);
  });
  it('is a new request when anything changed, so it never reuses the refused reference', () => {
    expect(editedRequestChanged({ transferId: id, amount: '5' }, { transferId: id, amount: '4' })).toBe(true);
    expect(editedRequestChanged({ transferId: id, amount: '5' }, { transferId: id, amount: '5', note: 'x' })).toBe(true);
  });
});
