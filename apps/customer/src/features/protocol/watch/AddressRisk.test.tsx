// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressRisk } from './AddressRisk';

const SUSPECT = '0x000000000000000000000000000000000000bAD0';
const session = { userId: 'u1' as string | null };
const addressRisk = vi.fn();
const reportAddress = vi.fn();
vi.mock('../api', () => ({ createProtocolApi: () => ({ addressRisk, reportAddress }) }));
vi.mock('../../session/session', () => ({ useApi: () => ({}), useSession: () => session }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom has no modal dialogs; the shared Dialog calls showModal and close.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? '';
const risk = (over: object = {}) => ({
  ok: true,
  data: {
    chainId: 84532,
    address: SUSPECT,
    reputation: 'UNKNOWN',
    labels: [],
    openReports: 0,
    screening: { status: 'not_loaded', code: 'vendor.aml' },
    ...over,
  },
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const click = async (label: string) => {
  const button = [...host.ownerDocument.querySelectorAll('button')].find((node) => node.textContent === label)!;
  await act(async () => {
    button.click();
  });
};
const submit = async () => {
  await act(async () => {
    host.ownerDocument.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  session.userId = 'u1';
  addressRisk.mockReset().mockResolvedValue(risk());
  reportAddress.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const mount = async () => {
  await act(async () => {
    root.render(<AddressRisk address={SUSPECT} />);
  });
  await flush();
};

describe('address risk card (D-developer-compliance-01)', () => {
  it('with no screening source says the list is not loaded, never clear', async () => {
    await mount();
    const card = host.querySelector('section[aria-label="Address risk"]')!;
    expect(card.textContent).toContain('The screening list is not loaded');
    expect(card.textContent).not.toMatch(/\bClear\b/);
    expect(card.textContent).toContain('Risk: no published label');
    expect(card.textContent).toContain('A label is a record, not a verdict.');
  });

  it('shows each published label with its reason, and the report count only', async () => {
    addressRisk.mockResolvedValue(
      risk({
        reputation: 'UNSAFE',
        openReports: 2,
        labels: [
          {
            kind: 'phishing',
            value: 'TEST phishing',
            source: 'curator',
            reputation: 'UNSAFE',
            reason: 'TEST: drains approvals',
            evidenceUrl: null,
            setAt: '2026-11-07T00:00:00Z',
            version: 1,
          },
        ],
      }),
    );
    await mount();
    expect(text()).toContain('Risk: unsafe');
    expect(text()).toContain('TEST phishing (phishing). Why: TEST: drains approvals');
    expect(text()).toContain('Reported 2 times.');
  });

  it('a report is received; a duplicate is refused in the form, which stays open', async () => {
    await mount();
    reportAddress.mockResolvedValueOnce({ ok: true, data: { id: 'r1', chainId: 84532, address: SUSPECT, kind: 'scam', createdAt: 'x' } });
    await click('Report this address');
    await submit();
    expect(reportAddress).toHaveBeenCalledWith({ address: SUSPECT, kind: 'scam' });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Thank you. Your report was received.');
    expect(host.ownerDocument.querySelector('form')).toBeNull();
    reportAddress.mockResolvedValueOnce({
      ok: false,
      reason: 'refused',
      code: 'protocol.reports.duplicate',
      message: 'protocol.reports.duplicate: x',
    });
    await click('Report this address');
    await submit();
    expect(host.ownerDocument.querySelector('[role="alert"]')?.textContent).toBe(
      'You already reported this address. Your report is still open.',
    );
    expect(host.ownerDocument.querySelector('form')).not.toBeNull();
  });

  it('signed out, offers sign-in instead of the report form', async () => {
    session.userId = null;
    await mount();
    expect(text()).toContain('Sign in to report this address.');
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === 'Report this address')).toBe(false);
  });
});
