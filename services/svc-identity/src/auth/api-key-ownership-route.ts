/**
 * GET /internal/api-keys/:keyId — S2S ownership snapshot for WS/edge live-check.
 * Extra bind lists ride on the JSON (contract schema stays {id,userId,revoked}).
 * No permission scopes flatten.
 */
import type { FastifyInstance } from 'fastify';
import { rawBodyOf, retainRawBody, verifyServiceHeaders, SERVICE_HEADER, type ServiceBodyBindMode } from '@intafaced/contracts';
import { identityAuthorityReadSecret } from '../controls/founder-context.js';
import type { PlaceDoor } from './place-door.js';

export const API_KEY_OWNERSHIP_PATH = '/internal/api-keys' as const;

export function registerApiKeyOwnershipRoute(
  app: FastifyInstance,
  opts: {
    door: Pick<PlaceDoor, 'getApiKeyOwnership'>;
    internalSecret: string;
    privateAuthoritySecret?: string;
    edgeAuthoritySecret?: string;
    operationAdmissionSecrets?: Partial<Record<'svc-trade' | 'svc-pay', string>>;
    bodyBind?: ServiceBodyBindMode;
    /** Isolated tests need this. Production `index.ts` already installed via accrue. */
    installRawBody?: boolean;
  },
): void {
  if (opts.installRawBody !== false) {
    retainRawBody(app);
  }
  app.get<{ Params: { keyId: string } }>(`${API_KEY_OWNERSHIP_PATH}/:keyId`, async (req, reply) => {
    const reader = req.headers[SERVICE_HEADER];
    const scoped = reader === 'svc-ws' || reader === 'svc-edge';
    const secret = scoped ? identityAuthorityReadSecret(opts, reader) : opts.internalSecret;
    const hasBody =
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    if (
      !secret ||
      (scoped && hasBody) ||
      verifyServiceHeaders(req.headers, secret, {
        rawBody: scoped ? { retained: true, bytes: Buffer.alloc(0) } : rawBodyOf(req),
        mode: scoped ? 'require' : opts.bodyBind,
      }).service === null
    ) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    const row = await opts.door.getApiKeyOwnership(req.params.keyId);
    if (!row) {
      return reply.code(404).send({ error: 'API key not found', code: 'identity.api_key_not_found' });
    }
    return row;
  });
}
