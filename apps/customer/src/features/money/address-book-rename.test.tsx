import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { AddressTable } from './WithdrawalAddresses';
import { bankWrites, type Destination } from './contracts';

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
      <AddressTable rows={[row({ assetId: 'USDT', network: 'TRC20', tag: null, state: 'cooling' })]} now={NOW} />,
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
    const answer = { ...row({ label: 'New name' }), refMasked: 'x', origin: 'customer' };
    expect(bankWrites['ramps.destinations.rename'].parse(answer).label).toBe('New name');
  });
});
