/**
 * Live navigator session from svc-identity S2S
 * (`GET /internal/agents/navigator-session/:sessionId`).
 *
 * Unset / blank IDENTITY_URL = honest `no_live_session`. 503 body = null —
 * never an invented session row and never a caller fixture as live truth.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { SessionFixture } from './data-tools.js';
import type { NavigatorIdentitySessionPort } from './identity-session-port.js';

export const IDENTITY_NAVIGATOR_SESSION_PATH = '/internal/agents/navigator-session' as const;

export type HttpNavigatorIdentitySessionOptions = {
  readonly identityUrl: string;
  readonly internalSecret: string;
  /** svc-agents' own key. With it the call is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  readonly s2s?: { readonly signer: ServiceSigner; readonly mode: ServiceAuthMode };
  readonly fetchImpl?: typeof fetch;
};

type SessionBody =
  | {
      readonly ok: true;
      readonly session: { readonly sessionId: string; readonly userId: string; readonly status: 'open' | 'closed' };
    }
  | { readonly ok: false; readonly reason: string };

function parseSession(raw: unknown): SessionFixture | null {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as SessionBody;
  if (body.ok !== true || body.session === null || typeof body.session !== 'object') return null;
  const row = body.session;
  if (!row.sessionId?.trim() || !row.userId?.trim()) return null;
  if (row.status !== 'open' && row.status !== 'closed') return null;
  return { sessionId: row.sessionId, userId: row.userId, status: row.status };
}

export function createHttpNavigatorIdentitySessionPort(options: HttpNavigatorIdentitySessionOptions): NavigatorIdentitySessionPort {
  const identityUrl = options.identityUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sign = serviceCallSigner({
    service: 'svc-agents',
    audience: 'svc-identity',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });

  return {
    async read(sessionId) {
      let response: Response;
      try {
        const target = `${identityUrl}${IDENTITY_NAVIGATOR_SESSION_PATH}/${encodeURIComponent(sessionId)}`;
        response = await fetchImpl(target, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          },
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      const body = await response.json().catch(() => null);
      return parseSession(body);
    },
  };
}
