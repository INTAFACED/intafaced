import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryStatusPageBook } from './book.js';
import { statusPageRouter } from './router.js';

const SECRET = 'status-definition-origin-edge-secret-0123456789';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

function founder() {
  const raw = encodePrincipal({
    sub: FOUNDER,
    userId: FOUNDER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-founder',
  });
}

const caller = (publicOrigin?: string | null) =>
  statusPageRouter({ book: new MemoryStatusPageBook(), notices: null, publicOrigin }).createCaller(founder());

describe('the founders read the public site address with the definition', () => {
  it('names the address without a trailing slash, so the console builds badge links on it', async () => {
    expect((await caller('https://status.example.test/').definition()).publicOrigin).toBe('https://status.example.test');
  });

  it('says null when NOTIFY_PUBLIC_ORIGIN is not set, never a guessed address', async () => {
    expect((await caller(undefined).definition()).publicOrigin).toBeNull();
    expect((await caller('  ').definition()).publicOrigin).toBeNull();
  });

  it('a change answers with the address too', async () => {
    const changed = await caller('https://status.example.test').configure({ uptimeDays: 7, expectedRevision: 0, reason: 'TEST' });
    expect(changed).toMatchObject({ uptimeDays: 7, revision: 1, publicOrigin: 'https://status.example.test' });
  });
});
