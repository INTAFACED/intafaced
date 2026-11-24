// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_API_VERSION } from '@intafaced/contracts/api-versions';

// TEST data only. The API version panel on /uc/safe/api-keys (J-developer-16 #5): the account default ("not set" while
// blank), the published versions, the deprecations with "removal date not set", and the set control's success, no-op,
// named refusal and failure.
const world = vi.hoisted(() => ({ answers: [] as unknown[], calls: [] as Array<{ name: string; input: unknown }> }));
const api = {
  call: (record: { name: string }, input: unknown) => {
    world.calls.push({ name: record.name, input });
    return Promise.resolve(world.answers.length > 1 ? world.answers.shift() : world.answers[0]);
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'user-1', api }) }));

import { ApiVersionPanel } from './ApiVersionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;

const notSet = { ok: true, data: { version: null, setAt: null } };
const set = (changed: boolean) => ({ ok: true, data: { version: LATEST_API_VERSION, setAt: '2026-11-20T10:00:00.000Z', changed } });
const isSet = { ok: true, data: { version: LATEST_API_VERSION, setAt: '2026-11-20T10:00:00.000Z' } };

async function render() {
  root = createRoot(host);
  await act(async () => root!.render(<ApiVersionPanel />));
  await act(async () => {});
}
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
async function submit() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await act(async () => {});
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.answers = [];
  world.calls = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the API version panel', () => {
  it('reads not set, lists the versions and the deprecations with no removal date', async () => {
    world.answers = [notSet];
    await render();
    expect(text('api-version__default')).toBe('Account default: not set');
    expect(text('api-version__versions')).toContain(`${LATEST_API_VERSION} · newest`);
    expect(text('api-version__deprecations')).toContain('POST /api/v1/orders stopPx');
    expect(text('api-version__deprecations')).toContain('stopPrice');
    expect(text('api-version__deprecations')).toContain('removal date not set');
    expect(world.calls).toEqual([{ name: 'identity.apiVersion.get', input: undefined }]);
  });

  it('sets the default, reads it again, and says when nothing changed', async () => {
    world.answers = [notSet, set(true), isSet];
    await render();
    await submit();
    expect(world.calls[1]).toEqual({ name: 'identity.apiVersion.set', input: { version: LATEST_API_VERSION } });
    expect(text('api-version__outcome')).toBe(`The account default is now ${LATEST_API_VERSION}.`);
    expect(text('api-version__default')).toContain(`Account default: ${LATEST_API_VERSION}`);
    world.answers = [set(false), isSet];
    await submit();
    expect(text('api-version__outcome')).toBe(`The account default was already ${LATEST_API_VERSION}. Nothing changed.`);
  });

  it('names a refusal and changes nothing', async () => {
    world.answers = [notSet, { ok: false, reason: 'error', message: 'version.unknown', code: 'version.unknown' }, notSet];
    await render();
    await submit();
    expect(text('api-version__outcome')).toBe('That is not a published API version. Nothing changed.');
    expect(text('api-version__default')).toBe('Account default: not set');
    world.answers = [{ ok: false, reason: 'forbidden', message: 'x', code: 'identity.api_version_session_only' }];
    await submit();
    expect(text('api-version__outcome')).toBe('An API key cannot change the API version. Sign in on a device. Nothing changed.');
  });

  it('a failed read shows the failure, not a default', async () => {
    world.answers = [{ ok: false, reason: 'unreachable', message: 'The service did not answer.' }];
    await render();
    expect(host.querySelector('[data-testid="failure"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="api-version__default"]')).toBeNull();
  });
});
