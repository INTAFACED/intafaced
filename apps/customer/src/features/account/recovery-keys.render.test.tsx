// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoveryKeyFingerprint } from '@intafaced/contracts/identity-recovery';
import { recoveryKeysMessages } from './recovery-keys-copy';
import { makeRecoveryKey, RECOVERY_KEY_PREFIX, recoveryStepUp, shortFingerprint } from './recovery-keys';

// TEST data only. Recovery keys in Security (RC-identity-07, J-identity-05 #7): what identity's `recovery.keys.list`
// answers decides the card; making a key sends only its public half, and a confirmation is asked only when identity asks.
const USER = '12345678-1234-4234-8234-123456789abc';
const KEY = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
const FP = 'ab'.repeat(32);
const world = vi.hoisted(() => ({
  list: null as unknown,
  mutate: [] as unknown[],
  asked: [] as Array<{ kind: string; procedure: string; input: unknown }>,
}));
const api = {
  query: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'query', procedure, input });
    return Promise.resolve(world.list);
  },
  mutate: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'mutate', procedure, input });
    return Promise.resolve(world.mutate.shift());
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: USER, api }) }));

import { RecoveryKeys } from './RecoveryKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const empty = { heir: null, threshold: null, keys: [], activeKeys: 0, ready: false, missing: ['heir', 'threshold', 'keys'] };
const oneKey = {
  heir: { handle: 'sam_heir', active: true },
  threshold: 1,
  keys: [{ id: KEY, kind: 'key', label: 'Sister', fingerprint: FP, createdAt: '2026-10-24T10:00:00.000Z', revokedAt: null }],
  activeKeys: 1,
  ready: true,
  missing: [],
};

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function show(list: unknown) {
  world.list = { ok: true, data: list };
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<RecoveryKeys />));
  await settle();
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const typeInto = (name: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  input.value = value;
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.asked = [];
  world.mutate = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('recovery keys in Security', () => {
  it('with nothing set says so, and that only keys the person sets can move the balances', async () => {
    await show(empty);
    expect(host.querySelector('h2')?.textContent).toBe('Recovery keys');
    expect(host.textContent).toContain('No recovery keys set. If something happens to you, your balances stay frozen.');
    expect(host.textContent).toContain('Only keys you set can move your trading balances. Staff will not sell or transfer them.');
    expect(world.asked[0]).toEqual({ kind: 'query', procedure: 'recovery.keys.list', input: {} });
  });

  it('a ready setup names the heir and how many keys must sign', async () => {
    await show(oneKey);
    expect(host.textContent).toContain('Ready: 1 of your 1 live keys together can move your balances to @sam_heir.');
    expect(host.textContent).toContain(`Fingerprint ${shortFingerprint(FP)}`);
  });

  it('making a key sends only its public half, asks for a confirmation when identity does, then shows the key once', async () => {
    await show(empty);
    world.mutate = [
      { ok: false, reason: 'refused', status: 412, code: 'identity.step_up_required', message: 'Confirm first' },
      { ok: true, data: { challengeId: '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', totp: true, webauthn: null } },
      { ok: true, data: { stepUpApprovalId: 'approval-1' } },
      { ok: true, data: oneKey },
    ];
    typeInto('label', 'Sister');
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Make a recovery key"]')!.requestSubmit());
    await settle();
    const add = world.asked.find((a) => a.procedure === 'recovery.keys.add')!.input as Record<string, unknown>;
    expect(Object.keys(add).sort()).toEqual(['clientRequestId', 'kind', 'label', 'publicKey']);
    expect(Object.keys(add.publicKey as object).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(host.textContent).toContain('Confirm to add this recovery key.');
    typeInto('code', '123456');
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Confirm it is you"]')!.requestSubmit());
    await settle();
    const begin = world.asked.find((a) => a.procedure === 'stepUp.begin')!.input as { target: string; fields: Record<string, string> };
    expect(begin.target).toBe(await recoveryKeyFingerprint(add.publicKey as never));
    expect(begin.fields).toEqual({ change: 'add', target: begin.target, clientRequestId: add.clientRequestId });
    const shown = host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(shown.value.startsWith(RECOVERY_KEY_PREFIX)).toBe(true);
    expect(host.textContent).toContain('Give this key to Sister');
    await act(async () => button('I have saved it')!.click());
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('a lost answer after the confirmation keeps the key on screen, since it may be live', async () => {
    await show(empty);
    world.mutate = [
      { ok: false, reason: 'refused', status: 412, code: 'identity.step_up_required', message: 'Confirm first' },
      { ok: true, data: { challengeId: '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', totp: true, webauthn: null } },
      { ok: true, data: { stepUpApprovalId: 'approval-1' } },
      { ok: false, reason: 'error', status: 502, message: 'Bad gateway' },
    ];
    typeInto('label', 'Friend');
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Make a recovery key"]')!.requestSubmit());
    await settle();
    typeInto('code', '123456');
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Confirm it is you"]')!.requestSubmit());
    await settle();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value.startsWith(RECOVERY_KEY_PREFIX)).toBe(true);
    expect(host.textContent).toContain('We could not tell whether this key was added.');
    expect(host.querySelector<HTMLButtonElement>('form[aria-label="Make a recovery key"] button')!.disabled).toBe(true);
  });

  it('refuses an unknown heir before asking for any confirmation', async () => {
    await show(oneKey);
    world.list = { ok: true, data: { found: false } };
    typeInto('heir', '@nobody_here');
    typeInto('threshold', '1');
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Who receives your balances"]')!.requestSubmit());
    await settle();
    expect(host.textContent).toContain('No active account has that handle.');
    expect(world.asked.some((a) => a.kind === 'mutate')).toBe(false);
  });

  it('revoking sends the key id', async () => {
    await show(oneKey);
    world.mutate = [
      {
        ok: true,
        data: {
          ...oneKey,
          keys: [{ ...oneKey.keys[0], revokedAt: '2026-10-24T11:00:00.000Z' }],
          activeKeys: 0,
          ready: false,
          missing: ['keys'],
        },
      },
    ];
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Revoke the key for Sister"]')!.click());
    await settle();
    expect(world.asked.find((a) => a.procedure === 'recovery.keys.revoke')!.input).toMatchObject({ keyId: KEY });
    expect(host.textContent).toContain('It no longer counts.');
  });
});

describe('recovery key helpers', () => {
  it('a made key carries its private half only in the text the holder keeps', async () => {
    const made = await makeRecoveryKey();
    expect(made.fingerprint).toBe(await recoveryKeyFingerprint(made.publicKey));
    expect(made.publicKey).not.toHaveProperty('d');
    const inner = JSON.parse(atob(made.text.slice(RECOVERY_KEY_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')));
    expect(Object.keys(inner).sort()).toEqual(['d', 'x', 'y']);
  });

  it('binds the change, its target and the request', () => {
    expect(recoveryStepUp('revoke', KEY, 'r-1')).toEqual({
      scope: 'identity.step_up.recovery_key_change',
      purpose: 'account.recoveryKey.change',
      target: KEY,
      fields: { change: 'revoke', target: KEY, clientRequestId: 'r-1' },
    });
  });

  it('the copy offers no platform inheritance desk', () => {
    const all = Object.values(recoveryKeysMessages).join(' ').toLowerCase();
    expect(all).toContain('only keys you set can move your trading balances');
    expect(all).not.toContain('inheritance desk');
  });
});
