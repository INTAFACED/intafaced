// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The vault deposit form (J-derivatives-31 #2) before and after the venue answers with the person's free USDC. Until it
// answers, free USDC is unknown: the form shows no zero of ours and a deposit can't be reviewed, so a quick "Review" is
// never refused against a figure the venue didn't give. Nothing here signs or sends.

const OWNER = '0x1111111111111111111111111111111111111111';
const VAULT = {
  address: '0xvault',
  name: 'TEST protocol vault',
  kind: 'protocol' as const,
  leader: null,
  asset: 'USDC',
  lockUpSeconds: 4 * 86_400,
  profitShareBps: 0,
  vaultValue: '0',
  pastReturn: null,
};

const api = { balances: vi.fn(), vaultHoldings: vi.fn() };
const run = vi.fn();
vi.mock('../venue/VenueKit', async (actual) => ({
  ...(await actual<typeof import('../venue/VenueKit')>()),
  useVenueApi: () => api,
  useVenueActions: () => ({ run }),
}));
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MoveForm } = await import('./VaultsRoom');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.balances.mockReset();
  run.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const free = (amount: string) => ({ ok: true, data: { value: [{ asset: 'USDC', free: amount, locked: '0' }] } });
// The venue's answers are promises already settled (or held by the test): flushing microtasks lets the form read them.
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function show(direction: 'deposit' | 'withdraw' = 'deposit') {
  await act(async () =>
    root.render(
      <MoveForm
        owner={OWNER}
        venue="TEST venue simulator"
        vault={VAULT}
        direction={direction}
        initialAmount="100"
        onClose={() => {}}
        onMoved={() => {}}
      />,
    ),
  );
  await settle();
}

describe('the vault deposit form before the venue reports free USDC', () => {
  it('shows no zero and holds Review until the venue answers; then reviews 100 USDC against its 500', async () => {
    let answer: (value: unknown) => void = () => {};
    api.balances.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await show();
    expect(q('vault-free')!.textContent).toBe('Reading your free USDC from TEST venue simulator…');
    expect(q('vault-free')!.getAttribute('data-value')).toBe('');
    const review = q('vault-review') as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    // A click while it is held does nothing: no refusal against a zero, no review.
    await act(async () => review.click());
    expect(q('vault-problem')).toBeNull();
    expect(q('vault-review-line')).toBeNull();

    await act(async () => answer(free('500')));
    await settle();
    expect(q('vault-free')!.textContent).toBe('Free in your venue account: 500 USDC, as TEST venue simulator reports it');
    expect(review.disabled).toBe(false);
    await act(async () => review.click());
    expect(q('vault-problem')).toBeNull();
    expect(q('vault-review-line')!.textContent).toContain('100 USDC');
    expect(q('vault-review-line')!.textContent).toContain('4 days');
    expect(run).not.toHaveBeenCalled();
  });

  it('still refuses a deposit above the free USDC the venue reports, and signs nothing', async () => {
    api.balances.mockResolvedValue(free('50'));
    await show();
    await act(async () => q('vault-review')!.click());
    expect(q('vault-problem')!.textContent).toBe(
      'TEST venue simulator reports 50 USDC free; 100 USDC is more than that. Nothing is signed.',
    );
    expect(q('vault-review-line')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('says the read failed, with the venue’s words, and still shows no zero', async () => {
    api.balances.mockResolvedValue({ ok: false, status: 503, message: 'venue unavailable' });
    await show();
    expect(q('vault-free')!.textContent).toBe('Couldn’t read your free USDC from TEST venue simulator: venue unavailable');
    expect((q('vault-review') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets a withdrawal be reviewed without the free figure, which it doesn’t use', async () => {
    api.balances.mockReturnValue(new Promise(() => {}));
    await show('withdraw');
    const review = q('vault-review') as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    await act(async () => review.click());
    expect(q('vault-review-line')!.textContent).toContain('100 USDC');
  });
});
