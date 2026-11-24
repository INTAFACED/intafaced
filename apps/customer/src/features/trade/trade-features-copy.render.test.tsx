// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRADE_COPY_LEAD_ELIGIBILITY } from '@intafaced/contracts/trade-copy-records';
import { leadApplyCopy } from './lead-apply/lead-apply-copy';
import { stakingCopy } from './staking/staking-copy';
import { ordersCopy } from './orders/orders-copy';
import { venueOrdersCopy } from './orders/venue-orders-copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callMock = vi.fn();
vi.mock('../session', () => ({
  useSession: () => ({ userId: 'u-1', api: { call: callMock } }),
}));

const { LeadApplyRoom } = await import('./lead-apply/LeadApplyRoom');

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  callMock.mockReset();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (root) {
    const mounted = root;
    root = null;
    act(() => mounted.unmount());
  }
  host.remove();
});

describe('Trade feature rooms customer copy (#6177)', () => {
  it('/copy/lead/apply uses plain wording and does not style a disconnected wallet in warning colour', async () => {
    expect(leadApplyCopy.t('termsThreshold')).not.toContain('Least venue balance');
    expect(leadApplyCopy.t('termsVenueNone')).not.toContain('No venue account connected');
    callMock.mockImplementation(async (proc: unknown) => {
      if (proc === TRADE_COPY_LEAD_ELIGIBILITY) {
        return { ok: true, data: { following: null, threshold: '500', venue: { state: 'missing' } } };
      }
      return { ok: true, data: null };
    });
    root = createRoot(host);
    const mounted = root;
    await act(async () => mounted.render(<LeadApplyRoom />));
    await act(async () => {
      await Promise.resolve();
    });
    const rows = [...host.querySelectorAll('[data-slot="key-value-row"]')];
    const walletRow = rows.find((el) => el.textContent?.includes(leadApplyCopy.t('termsVenue')));
    expect(walletRow).toBeTruthy();
    expect(walletRow?.getAttribute('data-unset')).toBeNull();
  });

  it('/trade/staking intro does not say "the venue’s own coin" or "the venue door is off"', () => {
    expect(stakingCopy.t('lead')).not.toContain('venue’s own coin');
    expect(stakingCopy.t('lead')).not.toContain('the venue’s:');
    expect(stakingCopy.t('venueOff')).not.toContain('venue door');
    expect(stakingCopy.t('ledgerNote')).not.toContain('our ledger');
  });

  it('/trade/orders renames the Venue account tab and removes agent key / venue jargon from assistant orders', () => {
    expect(venueOrdersCopy.t('productVenue')).not.toBe('Venue account');
    expect(ordersCopy.t('assistantLead')).not.toContain('agent key');
    expect(ordersCopy.t('assistantLead')).not.toContain('Every figure is the venue');
    expect(ordersCopy.t('assistantOff')).not.toContain('isn’t on here');
  });
});
