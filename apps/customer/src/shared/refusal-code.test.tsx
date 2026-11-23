import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RefusalCode } from './RefusalCode';
import { shownCode, withCode } from './reference';

const line = (code: string) => `Reference: ${code}`;

describe('a refusal code in the page', () => {
  it('a Bank refusal no step names ends in plain words, its code kept on data-code', () => {
    expect(shownCode('bank.payee_invite_unwired')).toBe(null);
    expect(withCode('Invites are switched off.', 'bank.payee_invite_unwired', line)).toBe('Invites are switched off.');
    expect(renderToStaticMarkup(<RefusalCode code="bank.loans_disabled" line={line} />)).toBe(
      '<small data-code="bank.loans_disabled"></small>',
    );
  });

  it('a rail or vendor notice keeps its code in the page', () => {
    expect(withCode('Send needs bank rails.', 'rail.bank', line)).toBe('Send needs bank rails. Reference: rail.bank');
    expect(shownCode('vendor.email')).toBe('vendor.email');
    expect(renderToStaticMarkup(<RefusalCode code="rail.bank" line={line} />)).toContain('Reference: rail.bank');
  });

  it('a Bank code a step names stays in the page', () => {
    expect(shownCode('bank.currency_in_use')).toBe('bank.currency_in_use');
    expect(shownCode('bank.account_terms_unset')).toBe('bank.account_terms_unset');
  });

  it('another service’s code, and no code, are left as they are', () => {
    expect(shownCode('pay.internal_settlement_refused')).toBe('pay.internal_settlement_refused');
    expect(withCode('Refused.', null, line)).toBe('Refused.');
    expect(renderToStaticMarkup(<RefusalCode code="" line={line} />)).toBe('');
  });
});
