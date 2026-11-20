import type { Principal } from '@intafaced/auth';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { privateWrite } from '../route-inventory.js';

/**
 * A key asks for its own rotation (DV-keys-04, J-developer-07 #3). The key's program calls
 * `POST /api/v1/account/api-key/rotation`, and may try `POST /api/v1/account/api-key/rotation/approve { requestId }`,
 * which identity always refuses: the requesting key with `identity.rotation_self_approval`, any other key because only
 * the account's owner, signed in on a device, approves. svc-trade holds nothing: it names the account and the key the
 * edge authenticated and passes identity's answer on as it came, `{ error, code }` on a refusal.
 */
export interface ApiKeyRotationClient {
  post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
}

const TIMEOUT_MS = 5_000;
const UNAVAILABLE = { error: 'Key rotation is unavailable right now', code: 'trade.identity_unavailable' } as const;

export function createApiKeyRotationClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): ApiKeyRotationClient {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async post(path, input) {
      const target = `${url}${path}`;
      const body = JSON.stringify(input);
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function answer(reply: FastifyReply, result: { status: number; body: unknown }) {
  const b = result.body as { code?: unknown; error?: unknown } | null;
  if (result.status >= 200 && result.status < 300) return reply.code(result.status).send(result.body);
  // Identity's typed refusals pass through; anything else (its own 401 to us, a 5xx) is ours to name.
  if ([400, 403, 404, 409].includes(result.status) && b && typeof b.code === 'string' && b.code.startsWith('identity.')) {
    return reply.code(result.status).send({ error: typeof b.error === 'string' ? b.error : b.code, code: b.code });
  }
  return reply.code(503).send(UNAVAILABLE);
}

export function attachApiKeyRotationRoutes(
  app: FastifyInstance,
  client: ApiKeyRotationClient | undefined,
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null,
): void {
  const keyOf = (req: FastifyRequest, reply: FastifyReply): (Principal & { kid: string }) | null => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return null;
    if (!principal.kid) {
      void reply
        .code(403)
        .send({ error: 'This door is for an API key; a person rotates a key on its page', code: 'identity.rotation_key_only' });
      return null;
    }
    return principal as Principal & { kid: string };
  };
  const call = async (reply: FastifyReply, path: string, body: Record<string, unknown>) => {
    if (!client) return reply.code(503).send(UNAVAILABLE);
    try {
      return answer(reply, await client.post(path, body));
    } catch {
      return reply.code(503).send(UNAVAILABLE);
    }
  };

  app.post<{ Body: { overlapSeconds?: unknown } | undefined }>('/api/v1/account/api-key/rotation', privateWrite, async (req, reply) => {
    const principal = keyOf(req, reply);
    if (!principal) return reply;
    const overlap = req.body?.overlapSeconds;
    return call(reply, '/internal/api-key-rotation/request', {
      userId: principal.userId,
      keyId: principal.kid,
      ...(overlap === undefined ? {} : { overlapSeconds: overlap }),
    });
  });

  app.post<{ Body: { requestId?: unknown } | undefined }>('/api/v1/account/api-key/rotation/approve', privateWrite, async (req, reply) => {
    const principal = keyOf(req, reply);
    if (!principal) return reply;
    return call(reply, '/internal/api-key-rotation/approve-by-key', {
      userId: principal.userId,
      keyId: principal.kid,
      requestId: req.body?.requestId,
    });
  });
}
