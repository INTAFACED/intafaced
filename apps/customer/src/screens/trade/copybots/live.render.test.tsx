// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../../shared/api';

// The session as the room sees it: the boot refresh still running, then answered with a signed-in person.
const session = vi.hoisted(() => ({ restoring: true, token: undefined as string | undefined }));
vi.mock('../../../features/session/session', async (original) => ({
  ...(await original<typeof import('../../../features/session/session')>()),
  useSession: () => ({ restoring: session.restoring }),
}));

import { useLive, type Live } from './live';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let seen: Array<string | undefined>;
let shown: Live<string>;

/** What svc-edge answers a trade:read: the profile with a token, UNAUTHORIZED without one. */
const load = async (): Promise<ApiResult<string>> => {
  seen.push(session.token);
  return session.token
    ? ({ ok: true, data: 'profile' } as ApiResult<string>)
    : ({ ok: false, reason: 'unauthorized', message: 'no', code: 'UNAUTHORIZED' } as unknown as ApiResult<string>);
};

function Probe() {
  shown = useLive(load, 'copy-leader:L1', 60_000);
  return null;
}

beforeEach(() => {
  seen = [];
  session.restoring = true;
  session.token = undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a live read waits for the boot refresh (#7355)', () => {
  it('sends nothing while the session is restoring, then reads once with the token it brought', async () => {
    await act(async () => root.render(<Probe />));
    expect(seen).toEqual([]);
    expect(shown.status).toBe('loading');
    expect(shown.failure).toBeNull();

    session.restoring = false;
    session.token = 'session-token';
    await act(async () => root.render(<Probe />));
    expect(seen).toEqual(['session-token']);
    expect(shown.status).toBe('ready');
    expect(shown.data).toBe('profile');
    expect(shown.failure).toBeNull();
  });

  it('still shows the refusal to someone the boot refresh found signed out', async () => {
    await act(async () => root.render(<Probe />));
    session.restoring = false;
    await act(async () => root.render(<Probe />));
    expect(seen).toEqual([undefined]);
    expect(shown.status).toBe('error');
    expect(shown.failure).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
