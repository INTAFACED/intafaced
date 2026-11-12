import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  PAY_WITHDRAWAL_ADDRESSES_CALLERS,
  PAY_WITHDRAWAL_ADDRESSES_PATH,
  payWithdrawalAddressesInputSchema,
  retainRawBody,
  verifyServiceRequest,
  type PayWithdrawalAddressesInput,
  type PayWithdrawalAddressesReply,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';

/**
 * The crypto address each of one person's own withdrawals went to, by withdrawal id (J-portfolio-03 #2). svc-bank asks so its
 * activity can show a withdrawal's address and filter by it; it reads no table of ours. Only that person's rows, and only a
 * crypto destination: an IBAN or any other kind is not an address and is never answered.
 */
export async function withdrawalAddresses(sql: Sql, input: PayWithdrawalAddressesInput): Promise<PayWithdrawalAddressesReply> {
  const rows = await sql<Array<{ id: string; address: string }>>`
    SELECT id::text AS id, destination ->> 'ref' AS address
      FROM pay.withdrawals
     WHERE user_id = ${input.userId}
       AND id = ANY(${sql.array([...input.withdrawalIds])}::uuid[])
       AND destination ->> 'kind' = 'crypto'
       AND COALESCE(destination ->> 'ref', '') <> ''
  `;
  return { addresses: rows.filter((r) => r.address.length <= 256).map((r) => ({ withdrawalId: r.id, address: r.address })) };
}

export interface WithdrawalAddressRouteDeps {
  readonly internalSecret: string;
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly addresses: (input: PayWithdrawalAddressesInput) => Promise<PayWithdrawalAddressesReply>;
}

/** The one signed path svc-bank asks. Only svc-bank may ask. A failed read is a 503, never an empty answer. */
export function registerWithdrawalAddressRoute(app: FastifyInstance, deps: WithdrawalAddressRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  app.post(PAY_WITHDRAWAL_ADDRESSES_PATH, async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) return reply.code(401).send({ code: 'pay.unauthenticated' });
    if (!(PAY_WITHDRAWAL_ADDRESSES_CALLERS as readonly string[]).includes(verified.service)) {
      return reply.code(403).send({ code: 'pay.withdrawal_addresses_forbidden' });
    }
    const input = payWithdrawalAddressesInputSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ code: 'pay.withdrawal_addresses_input' });
    try {
      return await deps.addresses(input.data);
    } catch {
      return reply.code(503).send({ code: 'pay.withdrawal_addresses_unavailable' });
    }
  });
}
