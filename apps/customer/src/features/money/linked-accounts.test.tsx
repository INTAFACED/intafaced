import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { draftProblems, ibanOk, LinkedAccountTable } from './LinkedAccounts';
import { bankReads, linkedAccountSchema, type LinkedAccount } from './contracts';

/** BK-acct-02 screen half (J-bank-02 #6): linked bank accounts with their state, and the link form's checks. */

// TEST fixture: a well-known example IBAN, not a customer's account.
const row = (patch: Partial<LinkedAccount> = {}): LinkedAccount => ({
  accountId: '0f4a2b8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
  label: 'TEST salary account',
  holderName: 'TEST Holder',
  ibanMasked: 'GB82 •••• 5432',
  country: 'GB',
  state: 'unverified',
  usable: false,
  blocker: 'bank.linked_account_unverified',
  verificationRail: 'rail.bank',
  linkedAt: '2026-10-23T03:00:00.000Z',
  coolingOffEndsAt: '2026-10-24T03:00:00.000Z',
  ...patch,
});

describe('linked bank accounts', () => {
  it('lists an unverified account with its state and why it cannot be used, naming rail.bank, and only the masked IBAN', () => {
    const html = renderToStaticMarkup(<LinkedAccountTable rows={[row()]} />);
    expect(html).toContain('TEST salary account');
    expect(html).toContain('GB82 •••• 5432');
    expect(html).toContain('Unverified');
    expect(html).toContain('No. Only a banking partner can verify it, and rail.bank is switched off in this build.');
    expect(html).toContain('bank.linked_account_unverified');
    expect(html).not.toContain('WEST');
  });

  it('a verified account reads its cooling-off, a blank window, or yes', () => {
    const verified = { state: 'verified' as const, verificationRail: null };
    const cooling = renderToStaticMarkup(<LinkedAccountTable rows={[row({ ...verified, blocker: 'bank.offramp_cooling_active' })]} />);
    expect(cooling).toContain('Verified');
    expect(cooling).toMatch(/From .+, when its cooling-off ends\./);
    const unset = renderToStaticMarkup(
      <LinkedAccountTable rows={[row({ ...verified, blocker: 'bank.offramp_cooling_unset', coolingOffEndsAt: null })]} />,
    );
    expect(unset).toContain('No. The bank has published no cooling-off period for new accounts.');
    const usable = renderToStaticMarkup(<LinkedAccountTable rows={[row({ ...verified, blocker: null, usable: true })]} />);
    expect(usable).toContain('<td>Yes</td>');
  });

  it('with no account the columns stay and the body says why it is empty', () => {
    const html = renderToStaticMarkup(<LinkedAccountTable rows={[]} />);
    expect(html).toContain('Can it be used');
    expect(html).toContain('You have no linked bank account.');
  });

  it('checks the IBAN digits and the names before a confirmation code is asked for', () => {
    expect(ibanOk('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanOk('de89370400440532013000')).toBe(true);
    expect(ibanOk('GB82WEST12345698765433')).toBe(false);
    expect(ibanOk('0x0000000000000000000000000000000000000000')).toBe(false);
    expect(draftProblems({ label: ' ', holderName: 'TEST Holder', iban: 'GB82WEST12345698765432' })).toEqual({
      label: 'nameBad',
      holderName: null,
      iban: null,
    });
    expect(draftProblems({ label: 'a'.repeat(65), holderName: '', iban: 'GB00' })).toEqual({
      label: 'nameBad',
      holderName: 'holderBad',
      iban: 'ibanBad',
    });
  });

  it('reads the bank answer through the shared contract', () => {
    expect(bankReads['linkedAccounts.list'].parse({ accounts: [row()] }).accounts[0]).toEqual(linkedAccountSchema.parse(row()));
  });
});
