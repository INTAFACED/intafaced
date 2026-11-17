// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../../shared/api';

// The session the room's reads carry. No room renders, and so no read goes out, until the boot refresh has answered
// (App, #8658; src/app/session-gate.render.test.tsx holds that).
const session = { token: undefined as string | undefined };

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
    : ({ ok: false, reason: 'unauthorized', message: 'no', code: 'UNAUTHORIZED' } as ApiResult<string>);
};

function Probe() {
  shown = useLive(load, 'copy-leader:L1', 60_000);
  return null;
}

beforeEach(() => {
  seen = [];
  session.token = undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a live read after the boot refresh (#7355)', () => {
  it('reads once with the token the session brought', async () => {
    session.token = 'session-token';
    await act(async () => root.render(<Probe />));
    expect(seen).toEqual(['session-token']);
    expect(shown.status).toBe('ready');
    expect(shown.data).toBe('profile');
    expect(shown.failure).toBeNull();
  });

  it('still shows the refusal to someone the boot refresh found signed out', async () => {
    await act(async () => root.render(<Probe />));
    expect(seen).toEqual([undefined]);
    expect(shown.status).toBe('error');
    expect(shown.failure).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
