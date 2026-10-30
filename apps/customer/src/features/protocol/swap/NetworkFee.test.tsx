// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolSwapFees } from '@intafaced/contracts/protocol-swap';
import type { Resource } from '../../../shared/resource';
import { chosenFee, type FeeChoice } from './fee';
import { feeRefusal, NetworkFee } from './NetworkFee';

// TEST figures only: shaped like a fee read, not any network's live fees.
const FEES: ProtocolSwapFees = {
  asOf: '2026-10-29T12:00:00.000Z',
  chainId: 84532,
  blocks: 20,
  percentiles: [10, 50, 90],
  baseFeePerGasWei: '1000000000',
  feeCapWei: '100000000000',
  levels: {
    slow: { maxFeePerGasWei: '2000000001', maxPriorityFeePerGasWei: '1', overCap: false },
    normal: { maxFeePerGasWei: '2001000000', maxPriorityFeePerGasWei: '1000000', overCap: false },
    fast: { maxFeePerGasWei: '2100000000', maxPriorityFeePerGasWei: '100000000', overCap: false },
  },
  sponsored: false,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (fees: Resource<ProtocolSwapFees>, choice: FeeChoice = 'normal', custom = '', onChoice = vi.fn()) => {
  const chosen = fees.status === 'ready' ? chosenFee(fees.data, choice, custom) : null;
  const refusal = feeRefusal(fees.status === 'ready' ? fees.data : null, chosen, custom, 'en');
  await act(async () => {
    root.render(
      <NetworkFee fees={fees} retry={vi.fn()} choice={choice} onChoice={onChoice} custom={custom} onCustom={vi.fn()} refusal={refusal} />,
    );
  });
};
const radios = () => [...host.querySelectorAll('[role="radiogroup"] input[type="radio"]')] as HTMLInputElement[];
const radioText = () => [...host.querySelectorAll('[role="radiogroup"] label')].map((label) => label.textContent ?? '');

describe('Network fee', () => {
  it('offers Slow, Normal, Fast and Custom from the last blocks, and names who pays', async () => {
    await render({ status: 'ready', data: FEES });
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Network fee');
    expect(radios()).toHaveLength(4);
    expect(radioText().map((label) => label.split(' ')[0])).toEqual(['Slow', 'Normal', 'Fast', 'Custom']);
    expect(radioText()[0]).toContain('at most 2.000000001 gwei per gas, 0.000000001 gwei priority');
    expect(radios()[1]!.checked).toBe(true);
    expect(host.querySelector('[data-testid="fee-line"]')?.textContent).toBe('You pay the network fee');
    expect(host.textContent).toContain('last 20 blocks');
  });

  it('says the fee is sponsored only when the service says a paymaster pays it', async () => {
    await render({ status: 'ready', data: { ...FEES, sponsored: true } });
    expect(host.querySelector('[data-testid="fee-line"]')?.textContent).toBe('Network fee sponsored');
  });

  it('asks for a custom fee and refuses one above the cap by name', async () => {
    await render({ status: 'ready', data: FEES }, 'custom', '100000');
    expect(host.textContent).toContain('Custom fee (gwei per gas)');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'That fee is above the fee cap of 100 gwei per gas. Choose a lower one.',
    );
  });

  it('refuses a custom fee under the next base fee', async () => {
    await render({ status: 'ready', data: FEES }, 'custom', '0.5');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('under the next block’s base fee of 1 gwei');
  });

  it('does not alert on an empty custom fee', async () => {
    await render({ status: 'ready', data: FEES }, 'custom', '');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('refuses a level above the cap rather than lowering it', async () => {
    const over = { ...FEES, levels: { ...FEES.levels, fast: { ...FEES.levels.fast, overCap: true } } };
    await render({ status: 'ready', data: over }, 'fast');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('above the fee cap');
  });

  it('keeps all four choices on screen while the levels are read or refused, and shows the refusal', async () => {
    await render({ status: 'loading' });
    expect(radios()).toHaveLength(4);
    expect(radioText()[0]).toContain('reading the last blocks');
    expect(host.querySelector('[data-testid="fee-line"]')).toBeNull();
    await render({ status: 'failed', failure: { ok: false, reason: 'error', message: 'refused', code: 'protocol.swap_fee_cap_unset' } });
    expect(radios()).toHaveLength(4);
    expect(radioText()[0]).toContain('could not be read');
    expect(host.querySelector('[data-testid="failure"]')).not.toBeNull();
  });

  it('reports the choice the person makes', async () => {
    const onChoice = vi.fn();
    await render({ status: 'ready', data: FEES }, 'normal', '', onChoice);
    await act(async () => radios()[3]!.click());
    expect(onChoice).toHaveBeenCalledWith('custom');
  });
});
