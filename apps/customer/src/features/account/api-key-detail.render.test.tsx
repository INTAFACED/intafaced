// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyDetail as Detail, ApiKeyRecord } from '@intafaced/contracts/api-keys';

// TEST data only. The developer room's key list and key detail (DV-keys-03, J-developer-03 #1 and #9): every column, a
// revoked key's reason, the revoke sheet with its optional reason and one Revoke, the detail's end date, idle expiry
// (`not set` while blank) and IP policy, and the end-date form that only sends a passkey when asked.
const USER = '12345678-1234-4234-8234-123456789abc';
const KEY = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
const GONE = '1c7f3d2e-4e5b-4a6c-9d7e-8f9a0b1c2d3e';
const world = vi.hoisted(() => ({
  queries: {} as Record<string, unknown[]>,
  mutate: [] as unknown[],
  asked: [] as Array<{ kind: string; procedure: string; input: unknown }>,
  assertions: 0,
}));
const api = {
  query: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'query', procedure, input });
    const queue = world.queries[procedure] ?? [];
    return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
  },
  mutate: (_service: string, procedure: string, input: unknown) => {
    world.asked.push({ kind: 'mutate', procedure, input });
    return Promise.resolve(world.mutate.shift());
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: USER, api }) }));
vi.mock('../session/webauthn', () => ({
  requestPasskeyAssertion: () => {
    world.assertions += 1;
    return Promise.resolve({ ok: true, data: { id: 'cred', rawId: 'cred', type: 'public-key', response: {} } });
  },
}));

import { ApiKeys } from './ApiKeys';
import { ApiKeyDetail, keyIdFromPath } from './ApiKeyDetail';
import { idlePeriod } from './developer-keys-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The page's dialog opens modally; the test DOM has no modal layer, so opening only marks it open.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
let host: HTMLDivElement;
let root: Root | null = null;

const live: ApiKeyRecord = {
  id: KEY,
  name: 'reader-1',
  prefix: 'ifc_ab12cd',
  mode: 'live',
  scopes: ['trade:read'],
  ipAllowlist: ['203.0.113.7'],
  requireSignature: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revoked: false,
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
};
const frozen: ApiKeyRecord = {
  ...live,
  id: GONE,
  name: 'bot-gone',
  revoked: true,
  revokedAt: '2026-10-21T10:00:00.000Z',
  revokedBy: 'account_freeze',
};
const list = (keys: ApiKeyRecord[]) => ({ ok: true, data: { keys, cap: { limit: 3, live: keys.filter((k) => !k.revoked).length } } });
const detail = (key: ApiKeyRecord, idleExpirySeconds: number | null = null): { ok: true; data: Detail } => ({
  ok: true,
  data: { key, requireNonEmptyIpAllowlist: true, idleExpirySeconds },
});

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function settleUntil(done: () => boolean) {
  for (const started = Date.now(); !done() && Date.now() - started < 5000;) await settle();
}
const shows = (text: string) => () => Boolean(host.textContent?.includes(text));
async function render(element: React.ReactElement) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(element));
  await settle();
}
const buttons = (pattern: RegExp, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].filter((b) => pattern.test(b.textContent ?? ''));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.queries = {};
  world.mutate = [];
  world.asked = [];
  world.assertions = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the key list', () => {
  it('shows the safety guidance and the empty state with no keys', async () => {
    world.queries['developerKeys.list'] = [list([])];
    await render(<ApiKeys />);
    expect(host.textContent).toContain('Keeping a key safe');
    expect(host.textContent).toContain('You have no API keys.');
    expect(host.querySelector('table')).toBeNull();
  });

  it('shows every column, links each name to its detail, and a revoked key says why with no Revoke', async () => {
    world.queries['developerKeys.list'] = [list([live, frozen, { ...frozen, id: KEY.replace('0b', '0c'), name: 'old', revokedBy: null }])];
    await render(<ApiKeys />);
    const headers = [...host.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['Name', 'Prefix', 'Mode', 'Permissions', 'IP addresses', 'Created', 'Ends', 'Last used', 'State', 'Actions']);
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe(`/uc/safe/api-keys/${KEY}`);
    expect(buttons(/Revoke/, rows[0]!)).toHaveLength(1);
    expect(rows[1]!.textContent).toContain('Revoked when the account was frozen');
    expect(buttons(/Revoke/, rows[1]!)).toHaveLength(0);
    expect(rows[2]!.textContent).toContain('Revoked. The reason was not recorded.');
  });

  it('revokes with an optional reason and no second factor, then reads the list again and shows the reason', async () => {
    world.queries['developerKeys.list'] = [
      list([live]),
      list([{ ...live, revoked: true, revokedAt: '2026-10-29T10:00:00.000Z', revokedBy: 'owner', revokeReason: 'TEST: rotated' }]),
    ];
    world.mutate = [{ ok: true, data: { changed: true, record: live } }];
    await render(<ApiKeys />);
    await act(async () => buttons(/Revoke/)[0]!.click());
    const dialog = host.querySelector('dialog')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Revoke this key');
    // One button in the sheet matches /Revoke/, so a loose match finds exactly it.
    expect(buttons(/Revoke/i, dialog).map((b) => b.textContent)).toEqual(['Revoke']);
    dialog.querySelector<HTMLInputElement>('input[name="reason"]')!.value = '  TEST: rotated ';
    await act(async () => dialog.querySelector('form')!.requestSubmit());
    await settleUntil(shows('Revoked by you'));
    expect(world.asked.find((a) => a.kind === 'mutate')).toEqual({
      kind: 'mutate',
      procedure: 'developerKeys.revoke',
      input: { keyId: KEY, reason: 'TEST: rotated' },
    });
    expect(world.assertions).toBe(0);
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelector('tbody tr')!.textContent).toContain('Revoked by you: TEST: rotated');
  });

  it('sends no reason when the field is blank, and keeps the sheet with the typed refusal when one comes back', async () => {
    world.queries['developerKeys.list'] = [list([live])];
    world.mutate = [{ ok: false, reason: 'refused', status: 404, code: 'identity.key_not_found', message: 'gone' }];
    await render(<ApiKeys />);
    await act(async () => buttons(/Revoke/)[0]!.click());
    await act(async () => host.querySelector<HTMLFormElement>('dialog form')!.requestSubmit());
    await settleUntil(shows('This key is not on your account.'));
    expect(world.asked.find((a) => a.kind === 'mutate')!.input).toEqual({ keyId: KEY });
    expect(host.querySelector('dialog')).not.toBeNull();
  });

  it('a lost answer closes the sheet, says it is unconfirmed and reads the list again', async () => {
    world.queries['developerKeys.list'] = [list([live])];
    world.mutate = [{ ok: false, reason: 'uncertain', message: 'lost' }];
    await render(<ApiKeys />);
    await act(async () => buttons(/Revoke/)[0]!.click());
    await act(async () => host.querySelector<HTMLFormElement>('dialog form')!.requestSubmit());
    await settleUntil(shows('We could not confirm that the key was revoked.'));
    expect(world.asked.filter((a) => a.procedure === 'developerKeys.list')).toHaveLength(2);
  });
});

describe('the key detail', () => {
  it('reads the key id from the path only when it is one', () => {
    expect(keyIdFromPath(`/uc/safe/api-keys/${KEY.toUpperCase()}`)).toBe(KEY);
    expect(keyIdFromPath('/uc/safe/api-keys/new')).toBeNull();
    expect(keyIdFromPath(`/uc/safe/api-keys/${KEY}/x`)).toBeNull();
  });

  it('shows the end date as its last day, idle expiry not set, and the IP policy', async () => {
    world.queries['developerKeys.get'] = [detail({ ...live, expiresAt: '2026-11-29T00:00:00.000Z' })];
    await render(<ApiKeyDetail keyId={KEY} />);
    const region = host.querySelector('section[aria-label="Key detail"]')!;
    expect(region.textContent).toContain('Works through 2026-11-28 (UTC)');
    expect(region.textContent).toMatch(/Idle expiry\s*not set/);
    expect(region.textContent).toContain('IP policy');
    expect(region.textContent).toContain('Only from 203.0.113.7');
    expect(region.textContent).toContain('An empty address list refuses every call.');
    expect(world.asked[0]).toEqual({ kind: 'query', procedure: 'developerKeys.get', input: { keyId: KEY } });
  });

  it('shows the owner idle period in days once it is set, and no end-date form on a revoked key', async () => {
    world.queries['developerKeys.get'] = [detail(frozen, 90 * 86_400)];
    await render(<ApiKeyDetail keyId={GONE} />);
    expect(host.textContent).toMatch(/Idle expiry\s*90 days/);
    expect(host.textContent).toContain('Revoked when the account was frozen');
    expect(host.querySelector('input[name="expiry"]')).toBeNull();
    expect(host.textContent).toContain('This key is revoked or has ended, so it cannot change.');
  });

  it('saves an end date with no factor, and shows the typed refusal when a later one needs a passkey, then sends one', async () => {
    world.queries['developerKeys.get'] = [detail(live)];
    world.mutate = [
      { ok: false, reason: 'refused', status: 412, code: 'auth.step_up_required', message: 'confirm' },
      { ok: true, data: { record: { ...live, expiresAt: '2026-12-02T00:00:00.000Z' } } },
    ];
    await render(<ApiKeyDetail keyId={KEY} />);
    host.querySelector<HTMLInputElement>('input[name="expiry"]')!.value = '2026-12-01';
    await act(async () => host.querySelector<HTMLFormElement>('form')!.requestSubmit());
    await settleUntil(shows('A later end date needs a passkey.'));
    expect(world.asked.filter((a) => a.kind === 'mutate')[0]!.input).toEqual({ keyId: KEY, expiresAt: '2026-12-02T00:00:00.000Z' });
    await act(async () => buttons(/Save with a passkey/)[0]!.click());
    await settleUntil(shows('The end date is saved.'));
    expect(world.assertions).toBe(1);
    expect(world.asked.filter((a) => a.kind === 'mutate')[1]!.input).toMatchObject({ factorProof: { webauthn: { id: 'cred' } } });
    expect(host.textContent).toContain('Works through 2026-12-01 (UTC)');
  });

  it('asks for a day before sending anything', async () => {
    world.queries['developerKeys.get'] = [detail(live)];
    await render(<ApiKeyDetail keyId={KEY} />);
    await act(async () => host.querySelector<HTMLFormElement>('form')!.requestSubmit());
    expect(host.textContent).toContain('Choose a day.');
    expect(world.asked.filter((a) => a.kind === 'mutate')).toHaveLength(0);
  });

  it('a key that is not yours reads as the typed not-found sentence', async () => {
    world.queries['developerKeys.get'] = [{ ok: false, reason: 'refused', status: 404, code: 'identity.key_not_found', message: 'x' }];
    await render(<ApiKeyDetail keyId={KEY} />);
    expect(host.textContent).toContain('This key is not on your account.');
  });
});

describe('the idle period and who revoked a key', () => {
  it('states the idle period exactly: whole days, else whole hours, else seconds, never 0 days', () => {
    expect(idlePeriod(90 * 86_400)).toEqual({ key: 'idleDays', params: { days: 90 } });
    expect(idlePeriod(86_400)).toEqual({ key: 'idleDay' });
    expect(idlePeriod(36 * 3_600)).toEqual({ key: 'idleHours', params: { hours: 36 } });
    expect(idlePeriod(3_600)).toEqual({ key: 'idleHour' });
    expect(idlePeriod(5_400)).toEqual({ key: 'idleSeconds', params: { seconds: 5_400 } });
    expect(idlePeriod(1)).toEqual({ key: 'idleSecond' });
  });

  it.each([
    [36 * 3_600, '36 hours'],
    [5_400, '5,400 seconds'],
    [86_400, '1 day'],
  ])('shows an idle period of %i seconds as %s', async (seconds, words) => {
    world.queries['developerKeys.get'] = [detail(live, seconds)];
    await render(<ApiKeyDetail keyId={KEY} />);
    const idle = host.querySelector('[data-testid="api-keys__idle"]')!.textContent!;
    expect(idle.startsWith(words)).toBe(true);
    expect(idle).not.toContain('0 days');
  });

  it('names a support recovery and a key that was never issued', async () => {
    world.queries['developerKeys.list'] = [
      list([
        { ...frozen, revokedBy: 'support' },
        { ...frozen, id: KEY, name: 'never', revokedBy: 'system' },
      ]),
    ];
    await render(<ApiKeys />);
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows[0]!.textContent).toContain('Revoked by our team during account recovery');
    expect(rows[1]!.textContent).toContain('Revoked automatically: the key was never issued');
  });
});
