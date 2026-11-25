// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import type { VenueStatus } from './venue-api';
import { useVenueMode, type VenueMode } from './use-venue-mode';

const venueStatus = vi.fn<(signal?: AbortSignal) => Promise<ApiResult<VenueStatus>>>();
const rest = (path: string, _schema: unknown, options: { signal?: AbortSignal } = {}) => {
  if (path === '/venue/status') return venueStatus(options.signal);
  throw new Error(`unexpected ${path}`);
};
const session = { userId: 'u1' as string | null, api: { rest } };
vi.mock('../session', () => ({ useSession: () => session }));

const VENUE_UP: VenueStatus = {
  enabled: true,
  available: true,
  venue: { id: 'test-venue', displayName: 'TEST venue', proofLevel: 'simulator' },
  test: true,
  label: 'TEST',
  chainId: 84532,
  builder: null,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let latest: VenueMode | undefined;

function Probe({ skip = false }: { skip?: boolean }) {
  latest = useVenueMode(skip);
  return null;
}

const flush = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  latest = undefined;
  session.userId = 'u1';
  venueStatus.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('useVenueMode', () => {
  it('settles to off at once on a transient unreachable read, then retries in the background and switches on', async () => {
    venueStatus
      .mockResolvedValueOnce(authoredRefusal('unreachable', { key: 'serviceUnreachable' }))
      .mockResolvedValueOnce({ ok: true, data: VENUE_UP });

    act(() => root.render(<Probe />));
    await flush();

    expect(venueStatus).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({ mode: 'off' });

    await act(async () => void vi.advanceTimersByTime(999));
    expect(venueStatus).toHaveBeenCalledTimes(1);

    await act(async () => void vi.advanceTimersByTime(1));
    await flush();

    expect(venueStatus).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ mode: 'on', status: VENUE_UP });
  });

  it('backs off over its bounded schedule (1s, 2s, 4s, 8s, 15s) and stops at off when the service never answers', async () => {
    const transient = authoredRefusal('unreachable', { key: 'gatewayUnreachable' }, 503);
    venueStatus.mockResolvedValue(transient);

    act(() => root.render(<Probe />));
    await flush();
    expect(venueStatus).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({ mode: 'off' });

    for (const [index, wait] of [1_000, 2_000, 4_000, 8_000, 15_000].entries()) {
      await act(async () => void vi.advanceTimersByTime(wait - 1));
      expect(venueStatus).toHaveBeenCalledTimes(index + 1);
      await act(async () => void vi.advanceTimersByTime(1));
      await flush();
      expect(venueStatus).toHaveBeenCalledTimes(index + 2);
      expect(latest).toEqual({ mode: 'off' });
    }

    // Retries are exhausted after 5 background tries (6 calls total); no further calls fire.
    await act(async () => void vi.advanceTimersByTime(300_000));
    expect(venueStatus).toHaveBeenCalledTimes(6);
    expect(latest).toEqual({ mode: 'off' });
  });

  it('recovers on the final bounded retry before stopping', async () => {
    const transient = authoredRefusal('unreachable', { key: 'gatewayUnreachable' }, 503);
    venueStatus
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce({ ok: true, data: VENUE_UP });

    act(() => root.render(<Probe />));
    await flush();
    expect(latest).toEqual({ mode: 'off' });

    for (const wait of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await act(async () => void vi.advanceTimersByTime(wait));
      await flush();
    }
    expect(venueStatus).toHaveBeenCalledTimes(6);
    expect(latest).toMatchObject({ mode: 'on', status: VENUE_UP });
  });

  it.each<[string, ApiResult<VenueStatus>]>([
    ['enabled: false', { ok: true, data: { enabled: false } }],
    ['404 not_mounted', authoredRefusal('not_mounted', { key: 'serviceRefusal' }, 404)],
    ['501 not_supported', authoredRefusal('not_supported', { key: 'serviceRefusal' }, 501)],
    ['401 unauthorized', authoredRefusal('unauthorized', { key: 'serviceRefusal' }, 401)],
    ['invalid_response', authoredRefusal('invalid_response', { key: 'unverifiedRead' }, 200)],
    ['edge.upstream_unwired', { ok: false, reason: 'unreachable', message: 'Not connected', code: 'edge.upstream_unwired', status: 503 }],
  ])('settles immediately to off with no retry on permanent answer: %s', async (_label, reply) => {
    venueStatus.mockResolvedValue(reply);

    act(() => root.render(<Probe />));
    await flush();

    expect(venueStatus).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({ mode: 'off' });

    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(venueStatus).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({ mode: 'off' });
  });

  it('keeps mode on across reload() while retrying a transient failure, then applies the fresh status', async () => {
    const down: VenueStatus = {
      enabled: true,
      available: false,
      refusal: { code: 'venue_down', detail: 'TEST venue is down' },
    };
    venueStatus
      .mockResolvedValueOnce({ ok: true, data: VENUE_UP })
      .mockResolvedValueOnce(authoredRefusal('unreachable', { key: 'serviceUnreachable' }))
      .mockResolvedValueOnce({ ok: true, data: down });

    act(() => root.render(<Probe />));
    await flush();
    expect(latest).toMatchObject({ mode: 'on', status: VENUE_UP });

    act(() => {
      if (latest?.mode === 'on') latest.reload();
    });
    await flush();
    expect(venueStatus).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ mode: 'on', status: VENUE_UP });

    await act(async () => void vi.advanceTimersByTime(1_000));
    await flush();
    expect(venueStatus).toHaveBeenCalledTimes(3);
    expect(latest).toMatchObject({ mode: 'on', status: down });
  });

  it('settles reload() to off once bounded retries are exhausted', async () => {
    venueStatus
      .mockResolvedValueOnce({ ok: true, data: VENUE_UP })
      .mockResolvedValue(authoredRefusal('unreachable', { key: 'serviceUnreachable' }));

    act(() => root.render(<Probe />));
    await flush();
    expect(latest).toMatchObject({ mode: 'on', status: VENUE_UP });

    act(() => {
      if (latest?.mode === 'on') latest.reload();
    });
    await flush();
    expect(latest).toMatchObject({ mode: 'on', status: VENUE_UP });

    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      await act(async () => void vi.advanceTimersByTime(wait));
      await flush();
      expect(latest).toMatchObject({ mode: 'on', status: VENUE_UP });
    }
    await act(async () => void vi.advanceTimersByTime(15_000));
    await flush();
    expect(venueStatus).toHaveBeenCalledTimes(7);
    expect(latest).toEqual({ mode: 'off' });

    await act(async () => void vi.advanceTimersByTime(300_000));
    expect(venueStatus).toHaveBeenCalledTimes(7);
  });

  it('cancels a pending retry timer and aborts on unmount, sign-out, or skip', async () => {
    venueStatus.mockResolvedValue(authoredRefusal('unreachable', { key: 'serviceUnreachable' }));

    act(() => root.render(<Probe />));
    await flush();
    expect(venueStatus).toHaveBeenCalledTimes(1);
    const firstSignal = venueStatus.mock.calls[0]![0];
    expect(firstSignal?.aborted).toBe(false);

    // Signing out cancels the retry timer and aborts the controller.
    session.userId = null;
    act(() => root.render(<Probe />));
    expect(firstSignal?.aborted).toBe(true);
    expect(latest).toEqual({ mode: 'off' });
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(venueStatus).toHaveBeenCalledTimes(1);

    // Skipping cancels a pending retry too.
    session.userId = 'u1';
    act(() => root.render(<Probe skip={false} />));
    await flush();
    expect(venueStatus).toHaveBeenCalledTimes(2);
    act(() => root.render(<Probe skip={true} />));
    expect(latest).toEqual({ mode: 'off' });
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(venueStatus).toHaveBeenCalledTimes(2);

    // Unmounting cancels a pending retry too.
    act(() => root.render(<Probe skip={false} />));
    await flush();
    expect(venueStatus).toHaveBeenCalledTimes(3);
    act(() => root.unmount());
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(venueStatus).toHaveBeenCalledTimes(3);
    // Recreate root for afterEach cleanup.
    root = createRoot(host);
  });
});
