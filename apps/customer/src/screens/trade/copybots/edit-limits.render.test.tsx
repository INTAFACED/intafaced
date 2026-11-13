// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../../shared/api';
import type { RoomApi } from './api';
import { EditLimits } from './FollowDetail';
import type { WriteGuard } from './guard';

// Edit limits on a follow (J-copy-bots-otc-02 #2 #3): what Save sends when a cap is changed or cleared.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let sent: unknown[];

const follow = {
  followId: 'f-1',
  permittedMarkets: ['BTC/USDT'],
  sizingMode: 'fixed_amount',
  maxPerMarket: '25',
  maxPerDay: '100',
  relationshipState: 'ACTIVE',
} as unknown as Parameters<typeof EditLimits>[0]['follow'];
const api = {
  amendFollow: async (input: unknown) => {
    sent.push(input);
    return { ok: true, data: follow } as ApiResult<unknown>;
  },
} as unknown as RoomApi;
const guard = {
  busy: false,
  locked: false,
  failure: null,
  setFailure: () => undefined,
  run: async (_id: unknown, call: () => Promise<ApiResult<unknown>>, done: (d: unknown) => void) => {
    const r = await call();
    if (r.ok) done(r.data);
    return r.ok;
  },
} as unknown as WriteGuard;

/** Types into a box as a person does: the browser's own value setter, then the input event React listens to. */
function type(box: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

const boxFor = (label: string) => {
  const found = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label));
  const id = found?.getAttribute('for');
  const box = (id ? host.querySelector(`#${CSS.escape(id)}`) : found?.querySelector('input')) as HTMLInputElement | null;
  if (!box) throw new Error(`no box labelled ${label}`);
  return box;
};

beforeEach(() => {
  sent = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Edit limits', () => {
  it('sends a cleared cap as blank, so the service clears it, and a changed one as typed', async () => {
    await act(async () =>
      root.render(<EditLimits follow={follow} api={api} guard={guard} desk={null} onDone={() => undefined} onCancel={() => undefined} />),
    );
    await act(async () => type(boxFor('Most per contract'), ''));
    await act(async () => type(boxFor('Most per day'), '40'));
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')!;
    await act(async () => save.click());
    expect(sent).toEqual([{ followId: 'f-1', sizingMode: 'fixed_amount', maxPerMarket: '', maxPerDay: '40' }]);
  });
});
