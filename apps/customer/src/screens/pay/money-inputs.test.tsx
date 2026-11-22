// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Pins two money-input rules the Volt redraw keeps from the old kit (#9570): the Request and Global amount boxes clean
// a pasted "1,234.56" and read a typed "," as the decimal point, as AmountInput did; and a sheet whose save is in flight
// cannot be dismissed by Escape or its Close. Every answer here is TEST data.

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const world = vi.hoisted(() => {
  const world = { session: {} as unknown, save: null as null | ((value: unknown) => void) };
  const answer = (service: string, procedure: string) => {
    if (service === 'bank' && procedure === 'spaces.list')
      return Promise.resolve({
        ok: true,
        data: [
          {
            id: 'sp-1',
            assetId: 'USDT',
            kind: 'primary',
            name: 'Main',
            goalTarget: null,
            lockedUntil: null,
            unlocksAt: null,
            unlockRequestedAt: null,
            billsPot: null,
            balance: '10',
            ledgerAccount: { ownerType: 'user', ownerId: 'u-payee', assetId: 'USDT', kind: 'main' },
            heldAt: null,
          },
        ],
      });
    return Promise.resolve({ ok: false, reason: 'unreachable', message: 'not wired in this test' });
  };
  world.session = {
    userId: 'u-payee',
    profiles: { status: 'ready', businesses: [], active: 'personal', business: null, notice: null, reload: () => {} },
    session: { accessToken: 'x', expiresAt: '2099-01-01T00:00:00Z', userId: 'u-payee' },
    api: {
      query: (service: string, procedure: string) => answer(service, procedure),
      mutation: () => Promise.resolve({ ok: false, code: 'NOT_WIRED_IN_TEST' }),
      call: (record: { module: string; path: string }) => answer(record.module, record.path),
    },
  };
  return world;
});
vi.mock('../../features/session/session', () => ({ useSession: () => world.session }));
vi.mock('./deps', async (original) => {
  const real = await original<typeof import('./deps')>();
  return {
    ...real,
    fetchHandleSettings: () =>
      Promise.resolve({ kind: 'ok', settings: { handle: 'payee_test', discoverable: true, changeCap: 3, changesUsed: 0 } }),
    // The save stays in flight until the test answers it.
    changeHandle: () => new Promise((resolve) => (world.save = resolve)),
  };
});

import { ToastProvider } from '@intafaced/ui';
import { RequestCard } from './RequestCard';
import { GlobalCard } from './GlobalCard';
import { HandleSettings } from './HandleSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  world.save = null;
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function settle() {
  for (let i = 0; i < 8; i += 1) await act(async () => await Promise.resolve());
}

async function show(node: React.ReactNode) {
  root = createRoot(host);
  await act(async () => root?.render(<ToastProvider>{node}</ToastProvider>));
  await settle();
}

function paste(input: HTMLInputElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  act(() => {
    input.dispatchEvent(event);
  });
}

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const amountBox = (testId: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[data-testid="${testId}"]`);
  if (!input) throw new Error(`no ${testId} in ${host.innerHTML.slice(0, 400)}`);
  return input;
};

it.each([
  ['Request', () => <RequestCard identity={{ status: 'handles', handle: 'payee_test' }} />, 'request-amount'],
  ['Global', () => <GlobalCard />, 'global-amount'],
] as const)('the %s amount box cleans a pasted "1,234.56" and reads a typed "," as the decimal point', async (_room, room, testId) => {
  await show(room());
  paste(amountBox(testId), '1,234.56');
  expect(amountBox(testId).value).toBe('1234.56');
  paste(amountBox(testId), '1e5');
  expect(amountBox(testId).value).toBe('1234.56');
  type(amountBox(testId), '12,5');
  expect(amountBox(testId).value).toBe('12.5');
  type(amountBox(testId), '12.5,');
  expect(amountBox(testId).value).toBe('12.5');
});

it('the handle sheet cannot be dismissed while its save is in flight, and can be once it answers', async () => {
  await show(<HandleSettings handle="payee_test" onRenamed={() => {}} />);
  const changeButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Change handle');
  act(() => changeButton?.click());
  const dialog = host.querySelector('dialog');
  if (!dialog) throw new Error('no sheet');
  const form = dialog.querySelector('form');
  await act(async () => {
    form?.requestSubmit();
    await Promise.resolve();
  });
  expect(world.save).not.toBeNull();

  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    dialog.dispatchEvent(escape);
  });
  expect(escape.defaultPrevented).toBe(true);
  const cancel = new Event('cancel', { cancelable: true });
  act(() => {
    dialog.dispatchEvent(cancel);
  });
  expect(cancel.defaultPrevented).toBe(true);
  const close = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Close');
  expect(close?.disabled).toBe(true);
  expect(host.querySelector('dialog form')).not.toBeNull();

  await act(async () => {
    world.save?.({ kind: 'refused', code: 'identity.handle_taken' });
    await Promise.resolve();
  });
  await settle();
  const free = new Event('cancel', { cancelable: true });
  act(() => {
    dialog.dispatchEvent(free);
  });
  expect(free.defaultPrevented).toBe(false);
  expect([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Close')?.disabled).toBe(false);
  await settle();
  expect(host.querySelector('dialog form')).toBeNull();
});
