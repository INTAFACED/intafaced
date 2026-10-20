import type { FastifyInstance } from 'fastify';
import {
  PAY_CUSTODY_DEPOSIT_ADDRESS_PATH,
  PAY_CUSTODY_DEPOSIT_CALLERS,
  PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH,
  payCustodyDepositAddressInputSchema,
  retainRawBody,
  verifyServiceRequest,
  type PayCustodyDepositAddressInput,
  type PayCustodyDepositAddressReply,
  type PayCustodyDepositCatalogue,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';

export interface CustodyDepositRouteDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly catalogue: () => Promise<PayCustodyDepositCatalogue>;
  readonly address: (input: PayCustodyDepositAddressInput) => Promise<PayCustodyDepositAddressReply>;
}

/**
 * The two signed paths svc-bank asks (W-deposit-01). Only svc-bank may ask. A failed read or a throw is a 503, never an empty
 * catalogue and never an address.
 */
export function registerCustodyDepositRoutes(app: FastifyInstance, deps: CustodyDepositRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  const caller = (req: Parameters<typeof verifyServiceRequest>[0]): 'ok' | 'unauthenticated' | 'forbidden' => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) return 'unauthenticated';
    return (PAY_CUSTODY_DEPOSIT_CALLERS as readonly string[]).includes(verified.service) ? 'ok' : 'forbidden';
  };

  app.post(PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH, async (req, reply) => {
    const who = caller(req);
    if (who === 'unauthenticated') return reply.code(401).send({ code: 'pay.unauthenticated' });
    if (who === 'forbidden') return reply.code(403).send({ code: 'pay.custody_deposit_forbidden' });
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
      return reply.code(400).send({ code: 'pay.custody_deposit_input' });
    }
    try {
      return await deps.catalogue();
    } catch {
      return reply.code(503).send({ code: 'pay.custody_deposit_unavailable' });
    }
  });

  app.post(PAY_CUSTODY_DEPOSIT_ADDRESS_PATH, async (req, reply) => {
    const who = caller(req);
    if (who === 'unauthenticated') return reply.code(401).send({ code: 'pay.unauthenticated' });
    if (who === 'forbidden') return reply.code(403).send({ code: 'pay.custody_deposit_forbidden' });
    const input = payCustodyDepositAddressInputSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ code: 'pay.custody_deposit_input' });
    try {
      return await deps.address(input.data);
    } catch {
      return reply.code(503).send({ code: 'pay.custody_deposit_unavailable' });
    }
  });
}
