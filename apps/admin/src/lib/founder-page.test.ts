import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { founderCookie, sealFounderSession, type FounderSession } from '@/lib/founder-session';
import { requireFounderPage } from '@/lib/founder-page';

/**
 * The guard in front of every console page, with `next/headers` the only seam mocked and Edge answering through `fetch`.
 * On main a founder who had just signed in was sent to sign-in when one read of their standing got no answer
 * (J-support-public-10 #2, run 42930244817).
 */
let incoming = new Headers();
vi.mock('next/headers', () => ({ headers: async () => incoming }));

const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();

function signedIn() {
  const session: FounderSession = {
    userId: USER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    csrf: Buffer.alloc(32, 5).toString('base64url'),
  };
  incoming = new Headers({
    host: 'admin.example',
    cookie: founderCookie(sealFounderSession(session, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW), 3600).split(';')[0]!,
  });
}

const founder = () =>
  Response.json({ result: { data: { json: { status: 'enabled', userId: USER, version: '1', changedAt: NOW.toISOString() } } } });
const refused = (status: number) => Response.json({ error: { message: 'edge.authority_unavailable' } }, { status });

/** Edge answers these in turn; the number of reads is the mock's call count. */
function edgeAnswers(...answers: Array<() => Response | Promise<Response>>) {
  let at = 0;
  const fetchMock = vi.fn(async () => answers[Math.min(at++, answers.length - 1)]!());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** What the guard did: who it admitted, where it redirected, or what it threw. */
async function outcome() {
  try {
    const { session } = await requireFounderPage();
    return `admitted:${session.userId}`;
  } catch (error) {
    const digest = String((error as { digest?: string }).digest ?? '');
    if (digest.startsWith('NEXT_REDIRECT')) return `redirect:${digest.split(';')[2]}`;
    return `threw:${(error as Error).message}`;
  }
}

beforeEach(() => {
  vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
  vi.stubEnv('EDGE_URL', EDGE);
  vi.stubEnv('ADMIN_SESSION_SECRET', KEY.toString('base64url'));
  vi.stubEnv('APP_ENV', 'test');
  signedIn();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('requireFounderPage', () => {
  it('admits a current founder on one read', async () => {
    const reads = edgeAnswers(founder);
    expect(await outcome()).toBe(`admitted:${USER}`);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 408, 429])('asks again after a %i and keeps the founder signed in', async (status) => {
    const reads = edgeAnswers(() => refused(status), founder);
    expect(await outcome()).toBe(`admitted:${USER}`);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('asks again when the read could not reach Edge', async () => {
    const reads = edgeAnswers(() => Promise.reject(new TypeError('fetch failed')), founder);
    expect(await outcome()).toBe(`admitted:${USER}`);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('shows the failure, not sign-in and not the page, when identity never answers', async () => {
    const reads = edgeAnswers(() => refused(503));
    expect(await outcome()).toBe('threw:admin.upstream_refused');
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])('sends a session Edge refuses with %i to sign-in on the first read', async (status) => {
    const reads = edgeAnswers(() => refused(status));
    expect(await outcome()).toBe('redirect:/login');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('sends someone who is no founder to sign-in on the first read', async () => {
    const reads = edgeAnswers(() => Response.json({ result: { data: { json: { status: 'disabled', userId: USER } } } }));
    expect(await outcome()).toBe('redirect:/login');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('sends a visitor with no session to sign-in without asking', async () => {
    incoming = new Headers({ host: 'admin.example' });
    const reads = edgeAnswers(founder);
    expect(await outcome()).toBe('redirect:/login');
    expect(reads).not.toHaveBeenCalled();
  });

  it('sends a request for another host to sign-in without asking', async () => {
    incoming.set('host', 'elsewhere.example');
    const reads = edgeAnswers(founder);
    expect(await outcome()).toBe('redirect:/login');
    expect(reads).not.toHaveBeenCalled();
  });
});
