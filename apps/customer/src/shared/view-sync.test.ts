import { describe, expect, it } from 'vitest';
import { uiViewRequestId, uiViewValueSchema, type UiViewValue } from '@intafaced/contracts/ui-view-preferences';
import type { ApiClient } from './api';
import type { Preferences } from './preferences';
import { createViewSync } from './view-sync';

type Sent = { value: UiViewValue; ifVersion: number; clientRequestId: string };

/** The account side of the identity door: one record, compare-and-set on the version, a receipt per request id. */
function accountServer(initial?: { version: number; value: UiViewValue }) {
  let version = initial?.version ?? 0;
  let value: UiViewValue | null = initial?.value ?? null;
  const receipts = new Map<string, { fingerprint: string; version: number; value: UiViewValue }>();
  const writes: Sent[] = [];
  const refusals: Array<{ status?: number; code?: string; message?: string }> = [];
  const offline = { on: false };
  const hooks: { afterWrite?: () => void } = {};
  const unreachable = { ok: false as const, reason: 'unreachable' as const, message: 'offline' };
  const api = {
    async query(_module: string, procedure: string, input: { namespace: string }) {
      if (offline.on) return unreachable;
      expect(procedure).toBe('preferences.get');
      return { ok: true as const, data: { namespace: input.namespace, version, value } };
    },
    async mutate(_module: string, procedure: string, input: Sent & { namespace: string }) {
      if (offline.on) return unreachable;
      expect(procedure).toBe('preferences.set');
      const refusal = refusals.shift();
      if (refusal) return { ok: false as const, reason: 'error' as const, message: refusal.message ?? 'refused', ...refusal };
      expect(uiViewValueSchema.safeParse(input.value).success).toBe(true);
      writes.push({ value: input.value, ifVersion: input.ifVersion, clientRequestId: input.clientRequestId });
      const fingerprint = JSON.stringify([input.value, input.ifVersion]);
      const receipt = receipts.get(input.clientRequestId);
      if (receipt) {
        return receipt.fingerprint === fingerprint
          ? { ok: true as const, data: { namespace: input.namespace, version: receipt.version, value: receipt.value, outcome: 'stored' } }
          : { ok: false as const, reason: 'error' as const, message: 'identity.preferences_idempotency_conflict', status: 409 };
      }
      if (input.ifVersion !== version) {
        return { ok: false as const, reason: 'error' as const, message: 'preferences.version_conflict', status: 409 };
      }
      version += 1;
      value = input.value;
      receipts.set(input.clientRequestId, { fingerprint, version, value });
      const afterWrite = hooks.afterWrite;
      hooks.afterWrite = undefined;
      afterWrite?.();
      return { ok: true as const, data: { namespace: input.namespace, version, value, outcome: 'stored' } };
    },
  } as unknown as ApiClient;
  return {
    api,
    writes,
    refusals,
    offline,
    hooks,
    record: () => ({ version, value }),
    /** Another device writes. */
    external(next: UiViewValue) {
      version += 1;
      value = next;
    },
  };
}

/** A device's own copy of the view, as the app keeps it. */
function device(start: Partial<Preferences> = {}) {
  let copy = { layoutMode: 'pro', hideBalances: false, displayCurrency: 'USD', theme: 'dark', ...start } as Preferences;
  return {
    get: () => copy,
    set: (patch: Partial<Preferences>) => {
      copy = { ...copy, ...patch };
    },
  };
}

function sync(server: ReturnType<typeof accountServer>, phone: ReturnType<typeof device>, userId = 'U-9') {
  return createViewSync({ api: () => server.api, userId, local: phone.get, applyRemote: phone.set });
}

describe('account view sync', () => {
  it('lets the account record win over this device and leaves a field the account never set alone', async () => {
    const server = accountServer({ version: 3, value: { layoutMode: 'simple', hideBalances: true } });
    const phone = device({ layoutMode: 'pro', displayCurrency: 'BTC' });
    expect(await sync(server, phone).pull()).toBe('synced');
    expect(phone.get()).toMatchObject({ layoutMode: 'simple', hideBalances: true, displayCurrency: 'BTC', theme: 'dark' });
  });

  it('changes nothing on this device and writes nothing when the account has no record', async () => {
    const server = accountServer();
    const phone = device({ layoutMode: 'pro' });
    const view = sync(server, phone);
    expect(await view.pull()).toBe('synced');
    expect(await view.push()).toBe('synced');
    expect(phone.get().layoutMode).toBe('pro');
    expect(server.writes).toEqual([]);
  });

  it('writes only the field this device changed, with the version it read and a business key', async () => {
    const server = accountServer({ version: 2, value: { theme: 'light', activeProfile: 'business:acme' } });
    const phone = device();
    const view = sync(server, phone);
    await view.pull();
    phone.set({ hideBalances: true });
    expect(await view.push()).toBe('synced');
    expect(server.writes).toEqual([
      {
        value: { theme: 'light', activeProfile: 'business:acme', hideBalances: true },
        ifVersion: 2,
        clientRequestId: uiViewRequestId('U-9', 2),
      },
    ]);
    expect(server.record().version).toBe(3);
  });

  it('follows the account to a second device: a choice on one shows on the other after sign-in', async () => {
    const server = accountServer();
    const laptop = device();
    const laptopSync = sync(server, laptop);
    await laptopSync.pull();
    laptop.set({ layoutMode: 'simple', displayCurrency: 'BTC' });
    await laptopSync.push();
    const phone = device();
    await sync(server, phone).pull();
    expect(phone.get()).toMatchObject({ layoutMode: 'simple', displayCurrency: 'BTC' });
  });

  it('reads the other device’s record after a conflict and sends only this device’s change on top of it', async () => {
    const server = accountServer({ version: 1, value: { theme: 'dark' } });
    const phone = device();
    const view = sync(server, phone);
    await view.pull();
    server.external({ theme: 'light', hideBalances: true });
    phone.set({ layoutMode: 'simple' });
    expect(await view.push()).toBe('synced');
    expect(server.record()).toEqual({ version: 3, value: { theme: 'light', hideBalances: true, layoutMode: 'simple' } });
    expect(server.writes.map((write) => write.ifVersion)).toEqual([1, 2]);
    expect(phone.get().layoutMode).toBe('simple');
  });

  it('treats an idempotency conflict like a version conflict', async () => {
    const server = accountServer({ version: 1, value: { theme: 'dark' } });
    const phone = device();
    const view = sync(server, phone);
    await view.pull();
    server.refusals.push({ status: 409, message: 'identity.preferences_idempotency_conflict' });
    phone.set({ theme: 'light' });
    expect(await view.push()).toBe('synced');
    expect(server.record().value).toEqual({ theme: 'light' });
  });

  it('keeps this device’s choice and reports not-saved when the account refuses or cannot be reached', async () => {
    const server = accountServer({ version: 1, value: { theme: 'dark' } });
    const phone = device();
    const view = sync(server, phone);
    await view.pull();
    server.refusals.push({ status: 403, code: 'FORBIDDEN', message: 'operator.denied' });
    phone.set({ layoutMode: 'simple' });
    expect(await view.push()).toBe('not-saved');
    expect(phone.get().layoutMode).toBe('simple');
    server.offline.on = true;
    expect(await view.push()).toBe('not-saved');
    server.offline.on = false;
    expect(await view.push()).toBe('synced');
    expect(server.record().value).toEqual({ theme: 'dark', layoutMode: 'simple' });
  });

  it('gives up after one re-read when the conflict does not clear, and says so', async () => {
    const server = accountServer({ version: 1, value: {} });
    const phone = device();
    const view = sync(server, phone);
    await view.pull();
    phone.set({ theme: 'light' });
    server.refusals.push(
      { status: 409, message: 'preferences.version_conflict' },
      { status: 409, message: 'preferences.version_conflict' },
    );
    expect(await view.push()).toBe('not-saved');
    expect(phone.get().theme).toBe('light');
  });

  it('reads the account before its first write when the sign-in read failed', async () => {
    const server = accountServer({ version: 4, value: { hideBalances: true } });
    const phone = device();
    const view = sync(server, phone);
    server.offline.on = true;
    expect(await view.pull()).toBe('not-saved');
    server.offline.on = false;
    phone.set({ theme: 'light' });
    expect(await view.push()).toBe('synced');
    expect(server.writes[0]).toMatchObject({ ifVersion: 4, value: { hideBalances: true, theme: 'light' } });
  });

  it('sends a change made during a write after that write, with the version it returned', async () => {
    const server = accountServer();
    const phone = device();
    const view = sync(server, phone);
    await view.pull();
    let second: Promise<string> | undefined;
    server.hooks.afterWrite = () => {
      phone.set({ theme: 'light' });
      second = view.push();
    };
    phone.set({ layoutMode: 'simple' });
    expect(await view.push()).toBe('synced');
    expect(await second).toBe('synced');
    expect(server.writes.map((write) => write.ifVersion)).toEqual([0, 1]);
    expect(server.record().value).toEqual({ layoutMode: 'simple', theme: 'light' });
  });
});
