import { describe, expect, it } from 'vitest';
import type { ApiClient } from './api';
import type { UiLocale } from './locale';
import { accountDisplayRequestId, createLanguageSync } from './language-sync';

type Value = { locale: string | null; displayCurrency: string | null };

/** The account side of the identity door: one `account.display` record, compare-and-set on the version, a receipt per request id. */
function accountServer(initial?: { version: number; value: Value }) {
  let version = initial?.version ?? 0;
  let value: Value | null = initial?.value ?? null;
  const receipts = new Map<string, { fingerprint: string; version: number; value: Value }>();
  const writes: Array<{ value: Value; ifVersion: number; clientRequestId: string }> = [];
  const refusals: Array<{ status?: number; message?: string }> = [];
  const offline = { on: false };
  const hooks: { onRead?: () => void } = {};
  const unreachable = { ok: false as const, reason: 'unreachable' as const, message: 'offline' };
  const api = {
    async query(_module: string, procedure: string, input: { namespace: string }) {
      if (offline.on) return unreachable;
      expect(procedure).toBe('preferences.get');
      expect(input.namespace).toBe('account.display');
      const onRead = hooks.onRead;
      hooks.onRead = undefined;
      onRead?.();
      return { ok: true as const, data: { namespace: input.namespace, version, value } };
    },
    async mutate(
      _module: string,
      procedure: string,
      input: { namespace: string; value: Value; ifVersion: number; clientRequestId: string },
    ) {
      if (offline.on) return unreachable;
      expect(procedure).toBe('preferences.set');
      const refusal = refusals.shift();
      if (refusal) return { ok: false as const, reason: 'error' as const, message: refusal.message ?? 'refused', ...refusal };
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
      return { ok: true as const, data: { namespace: input.namespace, version, value, outcome: 'stored' } };
    },
  } as unknown as ApiClient;
  return { api, writes, refusals, offline, hooks, record: () => ({ version, value }) };
}

function device(server: ReturnType<typeof accountServer>, language: UiLocale, userId = 'U1') {
  const state = { language };
  const sync = createLanguageSync({
    api: () => server.api,
    userId,
    local: () => state.language,
    applyRemote: (next) => {
      state.language = next;
    },
  });
  return { state, sync };
}

describe('language sync (RC-home-ia-05)', () => {
  it('sends nothing on sign-in when the account holds no language, and keeps the device language', async () => {
    const server = accountServer();
    const a = device(server, 'es');
    expect(await a.sync.pull()).toBe('synced');
    expect(await a.sync.push()).toBe('synced');
    expect(server.writes).toEqual([]);
    expect(a.state.language).toBe('es');
  });

  it('writes a changed language once, and a second device shows it after its own sign-in', async () => {
    const server = accountServer();
    const a = device(server, 'en');
    await a.sync.pull();
    a.state.language = 'ar';
    expect(await a.sync.push()).toBe('synced');
    expect(server.writes).toEqual([
      { value: { locale: 'ar', displayCurrency: null }, ifVersion: 0, clientRequestId: accountDisplayRequestId('U1', 0) },
    ]);
    expect(await a.sync.push()).toBe('synced');
    expect(server.writes).toHaveLength(1);
    const b = device(server, 'en');
    await b.sync.pull();
    expect(b.state.language).toBe('ar');
  });

  it('keeps the display currency the account holds when it writes the language', async () => {
    const server = accountServer({ version: 3, value: { locale: 'fr', displayCurrency: 'BTC' } });
    const a = device(server, 'en');
    await a.sync.pull();
    expect(a.state.language).toBe('fr');
    a.state.language = 'es';
    await a.sync.push();
    expect(server.record().value).toEqual({ locale: 'es', displayCurrency: 'BTC' });
  });

  it('reads the other device first when it lost the version race, then sends its own choice on top', async () => {
    const server = accountServer({ version: 1, value: { locale: 'es', displayCurrency: null } });
    const a = device(server, 'en');
    await a.sync.pull();
    server.refusals.push({ status: 409, message: 'preferences.version_conflict' });
    a.state.language = 'fr';
    expect(await a.sync.push()).toBe('synced');
    expect(server.record().value?.locale).toBe('fr');
  });

  it('a replay of one request id returns the first result; the same id with other contents conflicts and is never applied', async () => {
    const server = accountServer();
    const body = { namespace: 'account.display', value: { locale: 'es', displayCurrency: null }, ifVersion: 0, clientRequestId: 'k1' };
    const mutate = server.api.mutate.bind(server.api) as unknown as (
      m: string,
      p: string,
      i: unknown,
    ) => Promise<{ ok: boolean; data?: { version: number } }>;
    const first = await mutate('identity', 'preferences.set', body);
    const replay = await mutate('identity', 'preferences.set', body);
    expect(replay).toEqual(first);
    const other = await mutate('identity', 'preferences.set', { ...body, value: { locale: 'fr', displayCurrency: null } });
    expect(other.ok).toBe(false);
    expect(server.record()).toEqual({ version: 1, value: { locale: 'es', displayCurrency: null } });
    expect(accountDisplayRequestId('U1', 0)).toBe(accountDisplayRequestId('u1', 0));
  });

  it('reports not-saved and leaves the device language alone when the account is unreachable or refuses', async () => {
    const server = accountServer();
    const a = device(server, 'en');
    await a.sync.pull();
    a.state.language = 'es';
    server.offline.on = true;
    expect(await a.sync.push()).toBe('not-saved');
    server.offline.on = false;
    server.refusals.push({ status: 412, message: 'identity.preferences_value_invalid' });
    expect(await a.sync.push()).toBe('not-saved');
    expect(a.state.language).toBe('es');
    expect(server.writes).toEqual([]);
    expect(await a.sync.push()).toBe('synced');
    expect(server.record().value?.locale).toBe('es');
  });

  it('an unreadable account on sign-in is not-saved and applies nothing', async () => {
    const server = accountServer({ version: 1, value: { locale: 'fr', displayCurrency: null } });
    server.offline.on = true;
    const a = device(server, 'en');
    expect(await a.sync.pull()).toBe('not-saved');
    expect(a.state.language).toBe('en');
  });

  it('ignores a language the catalogue does not hold', async () => {
    const server = accountServer({ version: 1, value: { locale: 'zz-ZZ', displayCurrency: null } });
    const a = device(server, 'es');
    await a.sync.pull();
    expect(a.state.language).toBe('es');
  });

  it('keeps a choice made while the first read was out', async () => {
    const server = accountServer();
    const a = device(server, 'en');
    server.hooks.onRead = () => {
      a.state.language = 'es';
    };
    await a.sync.pull();
    await a.sync.push();
    expect(server.record().value?.locale).toBe('es');
  });
});
