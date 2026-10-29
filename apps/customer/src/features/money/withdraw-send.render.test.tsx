// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination, WithdrawAsset } from './contracts';

/**
 * J-wallet-05 on the screen. #1: the networks the asset list opens, its default chosen. #3: "Get the fee" stores one
 * quote for exactly these terms and shows the fee, what arrives and what leaves the balance; a blank fee rule is a
 * refusal in words, and changing the amount drops the quote. #4: the limit line is svc-pay's own read, and an amount
 * above what can be sent now is refused at the field. #6 and #7: confirming asks for a fresh step-up and sends once with
 * that token as the bearer; a refusal names the blocker, says nothing is held and reads the balance again.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const mutate = vi.fn();
const query = vi.fn();
// The form also reads the caller's campaign rewards (the locked-rewards note): none here.
const noRewards = { ok: true, data: { rewards: [], totals: [], more: false } };
const route = (module: string, ...rest: unknown[]) => (module === 'campaigns' ? Promise.resolve(noRewards) : query(module, ...rest));
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: { mutate, query: route } }) }));
const mint = vi.fn();
vi.mock('./withdraw-step-up', async (original) => ({
  ...(await original<typeof import('./withdraw-step-up')>()),
  mintWithdrawToken: (...args: unknown[]) => mint(...args),
}));
const reloads = { held: 0 };
vi.mock('./holdings', () => ({
  useHoldings: () => ({
    resource: { status: 'ready', data: { assets: [{ assetId: 'USDT', available: '300' }], spaces: [], holdings: [] } },
    reload: () => void (reloads.held += 1),
  }),
}));
const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const ROW: Destination = {
  destinationId: '22222222-2222-4222-8222-222222222222',
  label: 'Cold wallet',
  kind: 'crypto',
  ref: WALLET,
  addedAt: '2026-10-01T10:00:00Z',
  coolingOffEndsAt: '2026-10-02T10:00:00Z',
  coolingBlocker: null,
  assetId: 'USDT',
  network: 'ethereum',
  state: 'active',
};
const ASSETS: WithdrawAsset[] = [
  {
    assetId: 'USDT',
    precision: 6,
    networks: [
      { networkId: 'ethereum', label: 'TEST Ethereum' },
      { networkId: 'base', label: 'TEST Base' },
    ],
    defaultNetworkId: 'ethereum',
  },
];
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string) =>
      procedure === 'ramps.destinations.networks'
        ? { resource: { status: 'ready', data: ASSETS }, reload: () => undefined }
        : { resource: { status: 'ready', data: [ROW] }, reload: () => undefined },
  };
});
import { WithdrawForm } from './WithdrawForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const LIMITS = {
  tier: 'full',
  assetId: 'USDT',
  perTx: '100',
  rolling24h: '200',
  used24h: '0',
  remaining: { perTx: '100', rolling24h: '200' },
  maxNow: '100',
};
const RULES = { assetId: 'USDT', networkId: 'ethereum', minimum: '10', maximum: '1000', step: '0.5', tag: 'none' };
/** svc-pay's reads: the limit line and the network's rules, each by its own procedure. */
const reads = (rules: unknown = { ok: true, data: RULES }, limits: unknown = { ok: true, data: LIMITS }) =>
  query.mockImplementation(async (_module: string, procedure: string) => (procedure === 'withdrawal.networkRules' ? rules : limits));
const quoteFor = (amount: string, over: Record<string, unknown> = {}) => ({
  quoteRef: 'q',
  assetId: 'USDT',
  networkId: 'ethereum',
  amount,
  feeMode: 'on_top',
  fees: [{ kind: 'network', amount: '1.5' }],
  feeTotal: '1.5',
  netAmount: amount,
  totalDebit: (Number(amount) + 1.5).toString(),
  feeSource: 'fixed',
  quotedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  expired: false,
  acceptedBy: null,
  ...over,
});
const refusal = (code: string, status = 412) => ({ ok: false, reason: 'error', status, code, message: `${code}: service words` });
let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  mutate.mockReset();
  query.mockReset();
  mint.mockReset();
  reloads.held = 0;
  reads();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
  sessionStorage.clear();
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<WithdrawForm />));
}
function field(label: string): HTMLInputElement | HTMLSelectElement {
  const found = [...document.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent === label);
  return found!.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
}
async function type(label: string, value: string) {
  const input = field(label);
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
async function press(name: string) {
  await act(async () => void button(name).click());
}
async function confirmWithCode() {
  const code = document.querySelector('input[name="withdraw-stepup-code"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, '123456');
    code.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => void code.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
const text = () => document.body.textContent ?? '';
const fee = () => document.querySelector('[data-testid="withdraw-fee"]')!.textContent ?? '';

describe('sending crypto out (J-wallet-05)', () => {
  it('reads the limit line from svc-pay for the chosen asset, and refuses an amount above it at the field', async () => {
    await mount();
    expect(query).toHaveBeenCalledWith('pay', 'withdrawal.limits', { assetId: 'USDT' }, expect.anything(), expect.anything());
    expect(text()).toContain('You can send up to 100 USDT now: 100 per withdrawal, and 200 of 200 left in the last 24 hours.');
    await type('Amount', '150');
    expect(text()).toContain('That is above what you can send now: 100 USDT.');
    expect(button('Get the fee').disabled).toBe(true);
  });

  it('shows the network rules from svc-pay before any fee, and an amount outside them is refused at the field with no quote', async () => {
    await mount();
    expect(query).toHaveBeenCalledWith(
      'pay',
      'withdrawal.networkRules',
      { assetId: 'USDT', networkId: 'ethereum' },
      expect.anything(),
      expect.anything(),
    );
    const panel = document.querySelector('[data-testid="withdraw-network-rules"]')!.textContent ?? '';
    expect(panel).toContain('This network takes no tag or memo.');
    expect(panel).toContain('Minimum10 USDT');
    expect(panel).toContain('Maximum1,000 USDT');
    expect(panel).toContain('Step0.5 USDT');
    for (const [typed, words] of [
      ['9.5', 'That is below this network’s minimum of 10 USDT.'],
      ['10.25', 'Send a whole number of steps of 0.5 USDT on this network.'],
    ] as const) {
      await type('Amount', typed);
      expect(text()).toContain(words);
      expect(button('Get the fee').disabled).toBe(true);
    }
    await type('Amount', '10.5');
    expect(button('Get the fee').disabled).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('says in words when the network has no rules or needs a tag, and no fee can be got', async () => {
    reads(refusal('withdrawal_network_rules.unset'));
    await mount();
    expect(text()).toContain('The minimum, maximum and step for this network aren’t published, so nothing can be sent on it.');
    expect(text()).not.toContain('service words');
    await type('Amount', '25');
    expect(button('Get the fee').disabled).toBe(true);
    act(() => root?.unmount());
    root = null;
    reads({ ok: true, data: { ...RULES, tag: 'required' } });
    await mount();
    expect(text()).toContain('This network needs a tag or memo with every send.');
    await type('Amount', '25');
    expect(button('Get the fee').disabled).toBe(true);
  });

  it('says in words when no limit is set, and nothing can be confirmed', async () => {
    reads(undefined, refusal('pay.guard_withdrawal_limit_unset'));
    await mount();
    expect(text()).toContain('No withdrawal limit is set for your account level and this asset, so nothing can be sent.');
    expect(text()).not.toContain('service words');
    expect(button('Review withdrawal').disabled).toBe(true);
  });

  it('gets one quote for exactly these terms, shows the fee, what arrives and what leaves, and drops it when the amount changes', async () => {
    mutate.mockResolvedValue({ ok: true, data: quoteFor('25') });
    await mount();
    await type('Amount', '25');
    await press('Get the fee');
    expect(mutate).toHaveBeenCalledTimes(1);
    const [module, procedure, input] = mutate.mock.calls[0]!;
    expect([module, procedure]).toEqual(['pay', 'withdrawal.quote']);
    expect(input).toMatchObject({ assetId: 'USDT', networkId: 'ethereum', amount: '25' });
    expect(input.quoteRef).toMatch(/^withdraw-quote:/);
    expect(fee()).toContain('1.5 USDT');
    const review = document.querySelector('[data-testid="withdraw-review"]')!.textContent;
    expect(review).toContain('Arrives25 USDT');
    expect(review).toContain('Leaves your balance26.5 USDT');
    expect(text()).toContain('The fee is added to the amount.');
    await type('Amount', '26');
    expect(fee()).toContain('Get the fee to see it');
    expect(document.querySelector('[data-testid="withdraw-review"]')!.textContent).not.toContain('Arrives');
  });

  it('refuses in words when no fee rule is set, and shows no fee', async () => {
    mutate.mockResolvedValue(refusal('withdrawal_quote.policy_unset'));
    await mount();
    await type('Amount', '25');
    await press('Get the fee');
    expect(text()).toContain('No fee rule is set for withdrawals, so no fee can be quoted and nothing can be sent.');
    expect(fee()).toContain('Get the fee to see it');
  });

  it('says an expired quote must be got again, and keeps confirm off', async () => {
    mutate.mockResolvedValue({ ok: true, data: quoteFor('25', { expired: true }) });
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    expect(text()).toContain('This quote has expired. Get the fee again.');
    expect(button('Review withdrawal').disabled).toBe(true);
  });

  it('confirms with a fresh step-up, sends once to the saved address, and on a refusal names the blocker and holds nothing', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce(refusal('pay.wallet_withdraw_unavailable', 400));
    await mount();
    expect(button('Review withdrawal').disabled).toBe(true);
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    expect(button('Confirm and send').disabled).toBe(false);
    await press('Confirm and send');
    expect(text()).toContain('Sending money out needs a fresh confirmation.');
    expect(mutate).toHaveBeenCalledTimes(1);
    await confirmWithCode();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(2);
    const [module, procedure, input, , options] = mutate.mock.calls[1]!;
    expect([module, procedure]).toEqual(['pay', 'withdrawal.create']);
    expect(input).toMatchObject({
      assetId: 'USDT',
      amount: '25',
      railId: 'crypto-native',
      destination: { kind: 'crypto', ref: WALLET },
      // J-wallet-05 #6: the network and the accepted quote go with the send.
      networkId: 'ethereum',
      quoteRef: 'q',
    });
    expect(input.clientRef).toMatch(/^withdraw:/);
    expect(options).toEqual({ bearer: 'one-use' });
    const outcome = document.querySelector('[data-testid="withdraw-outcome"]')!.textContent;
    expect(outcome).toContain('Not sent');
    expect(outcome).toContain('no custody signer is set up');
    expect(outcome).toContain('Nothing was sent and nothing is held.');
    expect(outcome).toContain('Your available balance is 300 USDT.');
    expect(reloads.held).toBe(1);
    expect(document.querySelector('input[name="withdraw-stepup-code"]')).toBeNull();
  });

  it('never says nothing is held when the answer is lost, and a retry of the same send keeps its reference and its terms', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce({ ok: false, reason: 'uncertain', status: 504, message: 'gateway timeout' });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce(refusal('pay.wallet_withdraw_unavailable', 400));
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    const outcome = () => document.querySelector('[data-testid="withdraw-outcome"]')!.textContent;
    expect(outcome()).toContain('Answer not received');
    expect(outcome()).not.toContain('nothing is held');
    // The terms are locked until svc-pay answers for that reference.
    expect((field('Amount') as HTMLInputElement).readOnly).toBe(true);
    expect((field('Saved address') as HTMLSelectElement).disabled).toBe(true);
    await press('Get the fee');
    await press('Confirm again to finish');
    await confirmWithCode();
    const sends = mutate.mock.calls.filter(([, procedure]) => procedure === 'withdrawal.create');
    expect(sends).toHaveLength(2);
    expect(sends[1]![2].clientRef).toBe(sends[0]![2].clientRef);
    // A refusal of the retry says nothing about the first ask, which may be recorded: still not "nothing is held".
    expect(outcome()).toContain('Answer not received');
    expect(outcome()).not.toContain('nothing is held');
  });

  it('keeps a send whose answer was lost across a reload, and finishes it under the same reference', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce({ ok: false, reason: 'uncertain', status: 504, message: 'gateway timeout' });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25', { quoteRef: 'q-again' }) });
    mutate.mockResolvedValueOnce({ ok: true, data: { id: '99999999-9999-4999-8999-999999999999' } });
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    act(() => root?.unmount());
    root = null;
    await mount();
    expect((field('Amount') as HTMLInputElement).value).toBe('25');
    expect((field('Amount') as HTMLInputElement).readOnly).toBe(true);
    await press('Get the fee');
    expect(text()).toContain('An earlier withdrawal with these details got no answer');
    await press('Confirm again to finish');
    await confirmWithCode();
    const sends = mutate.mock.calls.filter(([, procedure]) => procedure === 'withdrawal.create');
    expect(sends).toHaveLength(2);
    expect(sends[1]![2].clientRef).toBe(sends[0]![2].clientRef);
    // svc-pay keeps the quote the first ask was made under, so finishing it names that one, not the fee got again.
    expect(sends[1]![2].quoteRef).toBe('q');
    expect(text()).toContain('Withdrawal 99999999-9999-4999-8999-999999999999 is recorded.');
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps a send whose ask is still in flight across a reload, and finishes it under the same reference', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    // The first send never answers: the tab reloads (or crashes) while it is in flight.
    mutate.mockReturnValueOnce(new Promise(() => {}));
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce({ ok: true, data: { id: '99999999-9999-4999-8999-999999999999' } });
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    act(() => root?.unmount());
    root = null;
    await mount();
    expect((field('Amount') as HTMLInputElement).value).toBe('25');
    expect((field('Amount') as HTMLInputElement).readOnly).toBe(true);
    await press('Get the fee');
    await press('Confirm again to finish');
    await confirmWithCode();
    const sends = mutate.mock.calls.filter(([, procedure]) => procedure === 'withdrawal.create');
    expect(sends).toHaveLength(2);
    expect(sends[1]![2].clientRef).toBe(sends[0]![2].clientRef);
    expect(text()).toContain('Withdrawal 99999999-9999-4999-8999-999999999999 is recorded.');
    expect(sessionStorage.length).toBe(0);
  });

  it('lets the reference go when finishing a send whose answer was lost is refused for its quote: no withdrawal was claimed', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce({ ok: false, reason: 'uncertain', status: 504, message: 'gateway timeout' });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25', { quoteRef: 'q-again' }) });
    mutate.mockResolvedValueOnce(refusal('withdrawal_quote.expired', 412));
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    await press('Get the fee');
    await press('Confirm again to finish');
    await confirmWithCode();
    const outcome = document.querySelector('[data-testid="withdraw-outcome"]')!.textContent;
    expect(outcome).toContain('Not sent');
    expect(outcome).toContain('This quote has expired. Get the fee again.');
    expect(sessionStorage.length).toBe(0);
    expect((field('Amount') as HTMLInputElement).readOnly).toBe(false);
  });

  it('never says nothing is held when svc-pay answers that the ledger refused the fee after the hold', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce(refusal('pay.withdrawal_fee_unbound', 412));
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    const outcome = document.querySelector('[data-testid="withdraw-outcome"]')!.textContent;
    expect(outcome).toContain('Answer not received');
    expect(outcome).not.toContain('nothing is held');
  });

  it('lets the reference go on a definite first refusal, so nothing is kept in the tab', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce(refusal('pay.wallet_withdraw_unavailable', 400));
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    expect(text()).toContain('Nothing was sent and nothing is held.');
    expect(sessionStorage.length).toBe(0);
    expect((field('Amount') as HTMLInputElement).readOnly).toBe(false);
  });

  it('gives a send for other terms its own reference', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce(refusal('pay.guard_withdrawal_limit_exceeded', 412));
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('20') });
    mutate.mockResolvedValueOnce(refusal('pay.wallet_withdraw_unavailable', 400));
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    await type('Amount', '20');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    const sends = mutate.mock.calls.filter(([, procedure]) => procedure === 'withdrawal.create');
    expect(sends.map((call) => call[2].amount)).toEqual(['25', '20']);
    expect(sends[1]![2].clientRef).not.toBe(sends[0]![2].clientRef);
  });

  it('names the recorded withdrawal and links to its record when svc-pay takes it', async () => {
    const id = '99999999-9999-4999-8999-999999999999';
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'one-use', expiresAt: '2026-10-23T05:10:00Z' } });
    mutate.mockResolvedValueOnce({ ok: true, data: quoteFor('25') });
    mutate.mockResolvedValueOnce({ ok: true, data: { id } });
    await mount();
    await type('Saved address', ROW.destinationId);
    await type('Amount', '25');
    await press('Get the fee');
    await press('Confirm and send');
    await confirmWithCode();
    expect(text()).toContain(`Withdrawal ${id} is recorded.`);
    expect(document.querySelector(`a[href="/uc/withdraw?withdrawalId=${id}"]`)).not.toBeNull();
  });
});
