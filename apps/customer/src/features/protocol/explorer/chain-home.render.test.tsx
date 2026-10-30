// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = new Map<string, unknown>();
const tokenAnswers = new Map<string, unknown>();
const query = vi.fn((_module: string, procedure: string, input: { hash?: string; symbol?: string }) => {
  if (procedure === 'explorer.tokens.bySymbol')
    return Promise.resolve(tokenAnswers.get(input.symbol!) ?? { ok: true, data: { rows: [], more: false, asOf: '' } });
  if (procedure !== 'explorer.tx.get') return new Promise(() => undefined);
  const answer = answers.get(input.hash!);
  return answer === undefined ? new Promise(() => undefined) : Promise.resolve(answer);
});
vi.mock('../../session/session', () => ({ useApi: () => ({ query }) }));
import { ChainHome } from './ChainHome';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const A = `0x${'a'.repeat(64)}`;
const B = `0x${'b'.repeat(64)}`;
const tx = (hash: string, extra: object = {}) => ({
  ok: true,
  data: { chainId: 84532, hash, status: 'success', replacingHash: null, orphaned: null, ...extra },
});
let host: HTMLDivElement;
let root: Root;

const box = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
async function search(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box(), value);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    box().form!.requestSubmit();
  });
}
const networks = () => host.querySelector('[aria-label="Networks searched"]')?.textContent ?? '';

beforeEach(async () => {
  answers.clear();
  tokenAnswers.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ChainHome chain={{ status: 'ready', chainId: 84532 }} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Chain home search', () => {
  it('never shows the first hash’s answer for a second hash still being checked', async () => {
    answers.set(A, tx(A));
    await search(A);
    expect(networks()).toContain('Base Sepolia test network: Found (Success)');
    await search(B);
    expect(networks()).toContain('Checking Base Sepolia test network');
    expect(networks()).not.toContain('Found');
  });
  it('says Not found on this network for a hash the indexer does not know', async () => {
    answers.set(A, { ok: false, reason: 'not_mounted', message: 'protocol.not_found', code: 'NOT_FOUND' });
    await search(A);
    expect(networks()).toContain('Base Sepolia test network: Not found on this network');
    expect(networks()).toContain('Local test chain: not checked: this explorer reads only Base Sepolia test network');
  });
  it('never reads a reorged or replaced transaction as plain Success', async () => {
    answers.set(A, tx(A, { orphaned: { reason: 'replaced by a heavier branch' } }));
    await search(A);
    expect(networks()).toContain('Found (Success, in a reorged block: replaced by a heavier branch)');
    // As the indexer sends it: replaced only ever comes with the reorged block that lost it.
    answers.set(B, tx(B, { status: 'replaced', replacingHash: `0x${'c'.repeat(64)}`, orphaned: { reason: 'reorg' } }));
    await search(B);
    expect(networks()).toContain('Found (Replaced by 0xcccccccc…cccccc)');
  });

  it('lists every token sharing a symbol as its own result, never merged, and says when none has it', async () => {
    const one = `0x${'1'.repeat(40)}`;
    const two = `0x${'2'.repeat(40)}`;
    const token = (address: string, symbol: string) => ({ chainId: 84532, address, symbol, name: null, decimals: 18 });
    tokenAnswers.set('same', { ok: true, data: { rows: [token(one, 'SAME'), token(two, 'same')], more: false, asOf: '' } });
    await search('same');
    const options = [...host.querySelectorAll('[role="option"][data-kind="token"]')];
    expect(options.map((o) => o.getAttribute('data-address'))).toEqual([one, two]);
    expect(options.map((o) => o.getAttribute('data-symbol'))).toEqual(['SAME', 'same']);
    await search('NOPE');
    // Typing again waits for a pause before reading, and never shows the last symbol's tokens meanwhile.
    expect(host.querySelector('[data-kind="token"]')).toBeNull();
    expect(host.textContent).toContain('Looking for tokens with this symbol on Base Sepolia test network…');
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(host.textContent).toContain('No token on Base Sepolia test network has the symbol “NOPE”.');
    expect(host.querySelector('[data-kind="token"]')).toBeNull();
  });

  it('shows the indexer’s refusal instead of an empty token list', async () => {
    tokenAnswers.set('X', { ok: false, code: 'indexer.explorer_list_limit_unset', message: 'The explorer list size is not set.' });
    await search('X');
    expect(host.textContent).toContain('Tokens were not searched: The explorer list size is not set.');
  });
});
