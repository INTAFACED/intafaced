import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFreeze, readKillSwitches, setFreeze, setKillSwitch } from './control-plane-client';

/**
 * DOES THE COMMAND ACTUALLY LEAVE THIS PROCESS?
 *
 * The bug this file guards against is not a crash. It is a console that reports
 * success having called nothing — the state the ledger controls were in before
 * this branch, where "Freeze ledger" set a boolean in a browser tab and the
 * panel went to HALTED.
 *
 * So every test here asserts one of exactly two things:
 *
 *   1. a real request went out, to the right address, carrying the right
 *      authority's credential; or
 *   2. no request went out AND the result is a refusal — never a cheerful
 *      default that an operator would read as "the platform is stopped".
 *
 * `fetch` is replaced rather than intercepted, because "was fetch called at
 * all" is the assertion that matters most and a passthrough cannot make it.
 */

const EDGE = 'http://edge:4000';
const OPERATOR = 'operator-token-value';
const TREASURY = 'treasury-token-value';

const ORIGINAL = { ...process.env };

/** A fetch that must never be reached. Calling it fails the test by name. */
const forbiddenFetch = vi.fn(() => {
  throw new Error('fetch was called on a console that is not configured to call anything');
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A `fetch` double that declares the parameters it receives, so the assertions
 * below can read `mock.calls[n]` as the (url, init) pair it actually is rather
 * than casting an untyped tuple.
 */
function spyFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(handler);
}

const headerOf = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name];

beforeEach(() => {
  for (const key of ['EDGE_URL', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN']) delete process.env[key];
  vi.restoreAllMocks();
  forbiddenFetch.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('an unconfigured console refuses, and calls nothing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', forbiddenFetch);
  });

  it('setKillSwitch answers 503 without reaching the network', async () => {
    const result = await setKillSwitch({ module: 'trade', disabled: true, reason: 'incident 2026-08-03' });

    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.detail).toContain('ADMIN_OPERATOR_TOKEN');
  });

  it('readKillSwitches reports unconfigured rather than an empty platform', async () => {
    const state = await readKillSwitches();

    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(state.status).toBe('unconfigured');
    expect(state.detail).toContain('ADMIN_OPERATOR_TOKEN');
  });

  /**
   * The single most dangerous default in this app. `frozen: false` means "the
   * book is accepting writes" — a claim nobody has checked. It must be null.
   */
  it('readFreeze never answers "not frozen" for a ledger it has not spoken to', async () => {
    const result = await readFreeze();

    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.state).toBeNull();
  });

  it('setFreeze answers 503 and moves nothing', async () => {
    const result = await setFreeze(true, 'halting for incident 2026-08-03');

    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.state).toBeNull();
  });
});

describe('the authority split is enforced by which token is present', () => {
  /**
   * A console holding only the module token can stop one market and CANNOT stop
   * the money plane. This is the test that would fail if the two credentials
   * were ever collapsed into one.
   */
  it('a module-only console halts a module but refuses to freeze the ledger', async () => {
    process.env.EDGE_URL = EDGE;
    process.env.ADMIN_OPERATOR_TOKEN = OPERATOR;

    const fetchMock = vi.fn(async () => jsonResponse({ disabledModules: ['trade'], reasons: {}, audit: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const halted = await setKillSwitch({ module: 'trade', disabled: true, reason: 'incident 2026-08-03' });
    expect(halted.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const frozen = await setFreeze(true, 'halting for incident 2026-08-03');
    expect(frozen.ok).toBe(false);
    expect(frozen.status).toBe(503);
    expect(frozen.detail).toContain('ADMIN_TREASURY_TOKEN');
    // Still one call: the freeze never reached the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the treasury token to the ledger and the operator token to the switches', async () => {
    process.env.EDGE_URL = EDGE;
    process.env.ADMIN_OPERATOR_TOKEN = OPERATOR;
    process.env.ADMIN_TREASURY_TOKEN = TREASURY;

    const fetchMock = spyFetch(async () => jsonResponse({ disabledModules: [], reasons: {}, audit: [], frozen: true }));
    vi.stubGlobal('fetch', fetchMock);

    await setKillSwitch({ module: 'trade', disabled: true, reason: 'incident 2026-08-03' });
    const [switchUrl, switchInit] = fetchMock.mock.calls[0]!;
    expect(switchUrl).toBe(`${EDGE}/admin/kill-switches`);
    expect(headerOf(switchInit, 'authorization')).toBe(`Bearer ${OPERATOR}`);

    await setFreeze(true, 'halting for incident 2026-08-03');
    const [freezeUrl, freezeInit] = fetchMock.mock.calls[1]!;
    expect(freezeUrl).toBe(`${EDGE}/admin/ledger/freeze`);
    expect(headerOf(freezeInit, 'authorization')).toBe(`Bearer ${TREASURY}`);
  });

  it('posts a thaw to /unfreeze and carries no reason with it', async () => {
    process.env.EDGE_URL = EDGE;
    process.env.ADMIN_TREASURY_TOKEN = TREASURY;

    const fetchMock = spyFetch(async () =>
      jsonResponse({ frozen: false, reason: null, actor: 'ops', changedAt: '2026-08-03T00:00:00.000Z' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await setFreeze(false);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${EDGE}/admin/ledger/unfreeze`);
    expect(JSON.parse(init!.body as string)).toEqual({});
    expect(result.ok).toBe(true);
    expect(result.state?.frozen).toBe(false);
  });
});

describe('a failure is never reported as a success', () => {
  beforeEach(() => {
    process.env.EDGE_URL = EDGE;
    process.env.ADMIN_OPERATOR_TOKEN = OPERATOR;
    process.env.ADMIN_TREASURY_TOKEN = TREASURY;
  });

  it('a refused freeze does not come back as frozen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'scope admin:treasury required' }, 403)),
    );

    const result = await setFreeze(true, 'halting for incident 2026-08-03');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.state).toBeNull();
    expect(result.detail).toBe('scope admin:treasury required');
  });

  /**
   * The operator walks away from a book that is still accepting writes. This is
   * the worst outcome in the app, so a transport failure is asserted explicitly.
   */
  it('a network failure is a 502 with the reason, not a silent "not frozen"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:4000');
      }),
    );

    const result = await setFreeze(true, 'halting for incident 2026-08-03');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.state).toBeNull();
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('a non-JSON error page does not become an empty snapshot reported as ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );

    const result = await setKillSwitch({ module: 'trade', disabled: true, reason: 'incident 2026-08-03' });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.detail).toContain('502');
  });

  it('an edge that answers 500 reads as unreachable, not as "nothing is halted"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 500)),
    );

    const state = await readKillSwitches();

    expect(state.status).toBe('unreachable');
    expect(state.snapshot.disabledModules).toEqual([]);
    expect(state.detail).toContain('500');
  });

  it('reports what is halted when the edge answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          disabledModules: ['trade', 'pay'],
          reasons: { trade: 'incident 2026-08-03' },
          audit: [
            {
              at: '2026-08-03T00:00:00.000Z',
              module: 'trade',
              actor: 'ops',
              reason: 'incident',
              previous: false,
              next: true,
              changed: true,
            },
          ],
        }),
      ),
    );

    const state = await readKillSwitches();

    expect(state.status).toBe('reachable');
    expect(state.snapshot.disabledModules).toEqual(['trade', 'pay']);
    expect(state.snapshot.audit).toHaveLength(1);
    expect(state.detail).toBeNull();
  });
});

describe('module response integrity and original intent', () => {
  beforeEach(() => {
    process.env.EDGE_URL = EDGE;
    process.env.ADMIN_OPERATOR_TOKEN = OPERATOR;
  });
  it('malformed HTTP200 never becomes a reachable empty platform', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ audit: [], reasons: {} })),
    );
    expect(await readKillSwitches()).toMatchObject({ status: 'invalid_response', code: 'admin.kill_invalid_response' });
  });
  it('auth refusal preserves the authoritative status and code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Isolated scope refusal', code: 'scope.insufficient' }, 403)),
    );
    expect(await readKillSwitches()).toMatchObject({ status: 'refused', httpStatus: 403, code: 'scope.insufficient' });
  });
  it('timeout retains original module intent without claiming a definite non-application', async () => {
    const fetchMock = spyFetch(async () => {
      throw new Error('Isolated timeout');
    });
    vi.stubGlobal('fetch', fetchMock);
    const intent = { module: 'pay' as const, disabled: true, reason: 'Original isolated incident' };
    expect(await setKillSwitch(intent)).toMatchObject({ ok: false, uncertain: true, intent });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('unreadable success cannot establish a module outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unreadable', { status: 200 })),
    );
    expect(await setKillSwitch({ module: 'pay', disabled: true, reason: 'Original isolated incident' })).toMatchObject({
      ok: false,
      uncertain: true,
      code: 'admin.kill_invalid_command_response',
    });
  });
});
