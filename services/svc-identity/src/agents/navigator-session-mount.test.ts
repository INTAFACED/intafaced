import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { BOOT_TIMEOUT_MS, BOOT_INTERNAL_SECRET, bootIdentity } from '../boot.testkit.js';
import { NAVIGATOR_SESSION_PATH } from './navigator-session-routes.js';

const SESSION = '55555555-5555-4555-8555-555555555555';

describe('navigator session mount', () => {
  it(
    'the booted service serves the S2S route under the internal secret',
    async () => {
      const { app } = await bootIdentity();
      const url = `${NAVIGATOR_SESSION_PATH}/${SESSION}`;

      const unsigned = await app.inject({ method: 'GET', url });
      expect(unsigned.statusCode).toBe(401);
      expect(unsigned.json()).toMatchObject({ error: 'identity.unauthenticated' });

      const otherSecret = await app.inject({ method: 'GET', url, headers: serviceAuthHeadersForBody('svc-agents', 'x'.repeat(32), '') });
      expect(otherSecret.statusCode).toBe(401);

      // Signed with the service's INTERNAL_SERVICE_SECRET, the call reaches the session store (no row: no live session).
      const signed = await app.inject({ method: 'GET', url, headers: serviceAuthHeadersForBody('svc-agents', BOOT_INTERNAL_SECRET, '') });
      expect(signed.statusCode).toBe(503);
      expect(signed.json()).toEqual({ ok: false, reason: 'no_live_session_store' });
    },
    BOOT_TIMEOUT_MS,
  );

  it('exports stable path for svc-agents HTTP port', () => {
    expect(NAVIGATOR_SESSION_PATH).toBe('/internal/agents/navigator-session');
  });
});
