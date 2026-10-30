// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// The signed pay code a payment link carries (PP-send-request-11). Every answer here is TEST data.
const PAYEE = '0b5f4c7e-3c2a-4f61-9d3e-7a1b2c3d4e5f';
const CODE = `v1.${PAYEE}.AbCdEfGhIjKlMnOp.${'s'.repeat(43)}`;
// One session object for the whole file, as the app holds one: a new client per render would reload Send forever.
const world = vi.hoisted(() => {
  const world = { answers: [] as unknown[], resolves: [] as unknown[], session: {} as unknown };
  world.session = {
    userId: 'u-payer',
    session: { accessToken: 'x', expiresAt: '2099-01-01T00:00:00Z', userId: 'u-payer' },
    api: {
      query: (service: string, procedure: string, input: unknown) => {
        if (service === 'identity' && procedure === 'qr.resolve') {
          world.resolves.push(input);
          return Promise.resolve(world.answers.shift() ?? { ok: false, code: 'NETWORK' });
        }
        if (service === 'bank' && procedure === 'spaces.list') return Promise.resolve({ ok: true, data: [] });
        return Promise.resolve({ ok: false, code: 'NOT_WIRED_IN_TEST' });
      },
      mutation: () => Promise.resolve({ ok: false, code: 'NOT_WIRED_IN_TEST' }),
    },
  };
  return world;
});
vi.mock('../../features/session/session', () => ({ useSession: () => world.session }));

import { ToastProvider } from '@intafaced/ui';
import { SendCard } from './SendCard';
import { parseRequestSearch } from '../../features/pay/personal/personal-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  world.answers = [];
  world.resolves = [];
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => await Promise.resolve());
}

async function open(search: string) {
  const prefill = parseRequestSearch(search);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <SendCard identity={{ status: 'handles', handle: 'payer_test' }} prefill={prefill} prefillKey={search} />
      </ToastProvider>,
    );
  });
  await settle();
}

const handleField = () => host.querySelector<HTMLInputElement>('input[aria-label="Handle"]');

it('reads the scanned code again on "Try again" after a failed read, and trusts only its answer', async () => {
  world.answers = [
    { ok: false, code: 'NETWORK' },
    { ok: true, data: { userId: PAYEE, handle: 'payee_test', self: false } },
  ];
  await open(`?to=someone_else&qr=${CODE}`);
  expect(world.resolves).toEqual([{ payload: CODE }]);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Try again');
  expect(handleField()?.value).toBe('');

  const again = [...(alert?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Try again'));
  await act(async () => again?.click());
  await settle();
  expect(world.resolves).toEqual([{ payload: CODE }, { payload: CODE }]);
  expect(handleField()?.value).toBe('payee_test');
  expect(host.querySelector('[data-testid="recipient-found"]')?.textContent).toContain('@payee_test');
});

it('offers no retry when the code is refused as not valid', async () => {
  world.answers = [{ ok: false, code: 'identity.qr_invalid' }];
  await open(`?to=someone_else&qr=${CODE}`);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('This code is not valid');
  expect(alert?.querySelector('button')).toBeNull();
  expect(handleField()?.value).toBe('');
});
