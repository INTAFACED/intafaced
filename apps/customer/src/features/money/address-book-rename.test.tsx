import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { AddressTable } from './WithdrawalAddresses';
import { type Destination } from './contracts';
import { BANK_RAMPS_DESTINATIONS_RENAME } from '@intafaced/contracts/bank-ramps-destinations-procedures';

/** W-withdraw-08 screen half: the address book shows asset, network and status, and offers a rename. */

const NOW = Date.parse('2026-10-18T00:00:00Z');
const row = (over: Partial<Destination> = {}): Destination => ({
  destinationId: '11111111-1111-4111-8111-111111111111',
  label: 'Test wallet',
  kind: 'crypto',
  ref: '0x52908400098527886E0F7030069857D2E4169EE7',
  addedAt: '2026-10-17T10:00:00Z',
  coolingOffEndsAt: null,
  coolingBlocker: 'bank.offramp_cooling_unset',
  ...over,
});

describe('address book rows', () => {
  it('shows the asset, network, tag and status the bank returned', () => {
    const html = renderToStaticMarkup(
      <AddressTable
        rows={[
          row({
            assetId: 'USDT',
            network: 'TRC20',
            tag: null,
            state: 'cooling',
            coolingOffEndsAt: '2026-10-19T00:00:00Z',
            coolingBlocker: null,
          }),
        ]}
        now={NOW}
      />,
    );
    expect(html).toContain('USDT · TRC20');
    expect(html).toContain('Cooling off');
  });
  it('says "Not returned" instead of guessing when the bank gave no asset, network or status', () => {
    const html = renderToStaticMarkup(<AddressTable rows={[row()]} now={NOW} />);
    expect(html.match(/Not returned/g)).toHaveLength(2);
  });
  it('offers Rename only when a handler is given, and not on a removed entry', () => {
    expect(renderToStaticMarkup(<AddressTable rows={[row({ state: 'active' })]} now={NOW} />)).not.toContain('Rename');
    expect(renderToStaticMarkup(<AddressTable rows={[row({ state: 'active' })]} now={NOW} onRename={() => {}} />)).toContain('Rename');
    expect(renderToStaticMarkup(<AddressTable rows={[row({ state: 'archived' })]} now={NOW} onRename={() => {}} />)).not.toContain(
      'Rename',
    );
  });
  it('reads the rename answer as an address-book entry', () => {
    // The whole entry as the bank answers it: the rename's caller parses with its record's schema.
    const answer = {
      ...row({ label: 'New name', assetId: 'USDT', network: 'TRC20', tag: null, state: 'active' }),
      refMasked: '0x5290…9EE7',
      origin: 'customer',
      lookalikeConfirmedAt: null,
      ownership: { state: 'none', verifiedAt: null, validUntil: null, offerExpiresAt: null },
      approvedAt: null,
      approvedBy: null,
      approvalLinkExpiresAt: null,
    };
    expect(BANK_RAMPS_DESTINATIONS_RENAME.output.parse(answer).label).toBe('New name');
  });
});
