// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = new Map<string, unknown>();
const calls: Array<{ procedure: string; input: unknown }> = [];
const query = vi.fn((module: string, procedure: string, input: unknown) => {
  calls.push({ procedure, input });
  if (module === 'protocol' && procedure === 'chainStatus') return Promise.resolve({ ok: true, data: { configuredChainId: 84532 } });
  const answer = answers.get(procedure);
  if (typeof answer === 'function') return Promise.resolve((answer as (input: unknown) => unknown)(input));
  return answer === undefined ? new Promise(() => undefined) : Promise.resolve(answer);
});
vi.mock('../../session/session', () => ({ useApi: () => ({ query }) }));
import { AddressHoldings, AddressInternal, AddressSummary, PastBalance, parsePastPoint } from './AddressDetails';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ADDRESS = `0x${'1'.repeat(40)}`;
const TOKEN = `0x${'a'.repeat(40)}`;
const FORWARDER = `0x${'f'.repeat(40)}`;
const HASH = `0x${'c'.repeat(64)}`;
let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

async function show(node: React.ReactNode) {
  await act(async () => root.render(node));
  await act(async () => undefined);
}

beforeEach(() => {
  answers.clear();
  calls.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const labels = { address: 'Address', kind: 'Kind', balance: 'Balance' };

describe('Address summary', () => {
  it('shows the kind and the exact native balance at the block it was read', async () => {
    answers.set('explorer.address.summary', {
      ok: true,
      data: { kind: 'contract', balance: '250000000000000001', asOfHeight: 77, asOf: '' },
    });
    await show(<AddressSummary address={ADDRESS} labels={labels} />);
    expect(byTestId('address-kind')).toBe('Contract');
    expect(byTestId('address-balance')).toBe('0.250000000000000001 (the network’s native unit)');
    expect(text()).toContain('Read at block 77.');
    expect(calls.find((call) => call.procedure === 'explorer.address.summary')?.input).toEqual({ chainId: 84532, address: ADDRESS });
  });
  it('names a node that no longer holds the state, with no figure', async () => {
    answers.set('explorer.address.summary', { ok: false, code: 'indexer.state_unavailable', message: 'indexer.state_unavailable' });
    await show(<AddressSummary address={ADDRESS} labels={labels} />);
    expect(byTestId('address-balance')).toBe('—');
    expect(text()).toContain('Kind and balance were not read: the network’s node no longer holds the state at that block');
  });
  it('before the first block, says nothing is stored instead of a zero', async () => {
    answers.set('explorer.address.summary', { ok: true, data: { kind: null, balance: null, asOfHeight: null, asOf: '' } });
    await show(<AddressSummary address={ADDRESS} labels={labels} />);
    expect(byTestId('address-balance')).toBe('—');
    expect(text()).toContain('Not read: the indexer has stored no block on Base Sepolia test network.');
  });
});

describe('Address holdings', () => {
  it('lists each token’s balance and says how many holdings have no price', async () => {
    answers.set('explorer.address.holdings', {
      ok: true,
      data: {
        rows: [{ token: { address: TOKEN, symbol: 'TESTA', decimals: 18 }, balance: '1000000000000000000', price: null }],
        unpriced: 1,
        more: false,
        asOfHeight: 9,
        asOf: '',
      },
    });
    await show(<AddressHoldings address={ADDRESS} />);
    const row = host.querySelector(`tr[data-token="${TOKEN}"]`)!;
    expect(row.textContent).toBe('TESTA1No price');
    expect(byTestId('address-unpriced')).toBe('1 holding has no price: this explorer has no price source.');
  });
  it('counts several unpriced holdings, shows raw units without decimals, and names a contract that did not answer', async () => {
    const other = `0x${'b'.repeat(40)}`;
    answers.set('explorer.address.holdings', {
      ok: true,
      data: {
        rows: [
          { token: { address: TOKEN, symbol: null, decimals: null }, balance: '7', price: null },
          { token: { address: other, symbol: 'TESTB', decimals: 6 }, balance: null, price: null },
        ],
        unpriced: 2,
        more: true,
        asOfHeight: 9,
        asOf: '',
      },
    });
    await show(<AddressHoldings address={ADDRESS} />);
    expect(text()).toContain('7 base units (the token gave no decimals)');
    expect(text()).toContain('Not answered: the contract did not answer as a token');
    expect(byTestId('address-unpriced')).toBe('2 holdings have no price: this explorer has no price source.');
    expect(text()).toContain('More tokens moved through this address than are listed.');
  });
  it('an empty answer is an empty table with a sentence, and a refusal says why', async () => {
    answers.set('explorer.address.holdings', { ok: true, data: { rows: [], unpriced: 0, more: false, asOfHeight: 9, asOf: '' } });
    await show(<AddressHoldings address={ADDRESS} />);
    expect(text()).toContain('The indexer lists no token this address holds on Base Sepolia test network.');
    expect(byTestId('address-unpriced')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    answers.set('explorer.address.holdings', { ok: false, code: 'indexer.chain_unreachable', message: 'indexer.chain_unreachable' });
    await show(<AddressHoldings address={ADDRESS} />);
    expect(text()).toContain('Holdings were not read: the network’s node didn’t answer');
  });
});

describe('Internal transactions', () => {
  const page = (gaps: object) => ({
    ok: true,
    data: {
      rows: [
        {
          chainId: 84532,
          hash: HASH,
          blockHeight: 40,
          index: 0,
          timestamp: 1_790_000_000,
          calls: [{ path: '0', kind: 'call', from: FORWARDER, to: ADDRESS, value: '250000000000000000' }],
        },
      ],
      nextCursor: null,
      gaps,
      asOfHeight: 41,
      asOf: '',
    },
  });
  it('lists each move with its transaction, sender, recipient and value', async () => {
    answers.set('explorer.address.internal', page({ blocks: 0, fromHeight: null, toHeight: null, reasons: [] }));
    await show(<AddressInternal address={ADDRESS} />);
    const row = host.querySelector(`tr[data-tx="${HASH}"][data-path="0"]`)!;
    expect(row.querySelector(`[data-address="${FORWARDER}"]`)).not.toBeNull();
    expect(row.querySelector(`[data-address="${ADDRESS}"]`)).not.toBeNull();
    expect(row.querySelector('[data-testid="internal-value"]')?.textContent).toBe('0.25');
    expect(row.textContent).toContain('Call');
    expect(byTestId('address-trace-gaps')).toBeNull();
  });
  it('names the blocks whose trace was not read, with their range and why', async () => {
    answers.set(
      'explorer.address.internal',
      page({ blocks: 12, fromHeight: 3, toHeight: 3030, reasons: ['indexer.trace_not_recorded', 'indexer.trace_unavailable'] }),
    );
    await show(<AddressInternal address={ADDRESS} />);
    expect(byTestId('address-trace-gaps')).toContain(
      'Trace unavailable for 12 blocks (3–3030): a move inside them is not listed. Why: indexed before traces were recorded; the network’s node did not trace them.',
    );
  });
});

describe('Balance at a past point', () => {
  async function ask(value: string) {
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.form!.requestSubmit();
    });
    await act(async () => undefined);
  }
  it('reads a date as the end of that UTC day and a number as a block', () => {
    expect(parsePastPoint(' 2026-01-01 ')).toEqual({ date: '2026-01-01' });
    expect(parsePastPoint('120')).toEqual({ height: 120 });
    expect(parsePastPoint('2026-02-30')).toBeNull();
    expect(parsePastPoint('-1')).toBeNull();
    expect(parsePastPoint('1.5')).toBeNull();
    expect(parsePastPoint('')).toBeNull();
  });
  it('shows the balance at the block asked for, and a date before the first indexed block is not indexed', async () => {
    answers.set('explorer.address.balanceAt', (input: { at: { height?: number; date?: string } }) =>
      input.at.height === 5000
        ? { ok: true, data: { indexed: true, height: 5000, timestamp: 1_790_000_000, balance: '1500000000000000000' } }
        : {
            ok: true,
            data: {
              indexed: false,
              after: 'height' in input.at || (input.at.date ?? '') > '2026-06-01',
              earliestHeight: 3,
              latestHeight: 6000,
            },
          },
    );
    await show(<PastBalance address={ADDRESS} />);
    await ask('5000');
    expect(byTestId('address-past-balance')).toMatch(/^1\.5 at block 5000 \(/);
    await ask('2026-01-01');
    expect(byTestId('address-past-balance')).toBe('Not indexed before block 3.');
    expect(
      calls.filter((call) => call.procedure === 'explorer.address.balanceAt').map((call) => (call.input as { at: unknown }).at),
    ).toEqual([{ height: 5000 }, { date: '2026-01-01' }]);
    await ask('6001');
    expect(byTestId('address-past-balance')).toBe('Not indexed after block 6000.');
    await ask('2099-01-01');
    expect(byTestId('address-past-balance')).toBe('Not indexed after block 6000.');
  });
  it('refuses what is neither a date nor a block number, and asks nothing', async () => {
    await show(<PastBalance address={ADDRESS} />);
    await ask('yesterday');
    expect(text()).toContain('Enter a date as YYYY-MM-DD or a block number.');
    expect(byTestId('address-past-balance')).toBeNull();
    expect(calls.some((call) => call.procedure === 'explorer.address.balanceAt')).toBe(false);
  });
});
