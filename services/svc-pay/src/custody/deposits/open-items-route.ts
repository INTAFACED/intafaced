/**
 * S2S read for svc-ledger's per-rail reconciliation (OPS-reconciliation-04, lead ruling 2026-10-30 on J-ops-console-27 #8):
 * the open custody-deposit items on rail `crypto-native`, the rail every custody deposit arrives on. It is the same read the
 * founders see on custody-ops (`CustodyOpenItems.list`): held deposits the ledger never credited and credited deposits the
 * chain took back uncovered. It is not every open item on the rail: a withdrawal or merchant payment in flight is not here,
 * so a difference it causes stays a named residual on svc-ledger's run. Paging is by offset, one snapshot per page: a
 * caller checks that `total` and `sums` agree on every page and treats a change as unavailable. Only svc-ledger may call
 * this; the body is bound to the signature. Read-only: it posts nothing.
 */
import type { FastifyInstance } from 'fastify';
import {
  PAY_CUSTODY_OPEN_ITEMS_RAIL,
  payCustodyRailOpenItemsInputSchema,
  retainRawBody,
  verifyServiceRequest,
  type PayCustodyOpenItemsInput,
  type PayCustodyOpenItemsReply,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';

export interface CustodyOpenItemsRouteDeps {
  readonly internalSecret: string;
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly list: (input: PayCustodyOpenItemsInput) => Promise<PayCustodyOpenItemsReply>;
}

export function registerCustodyOpenItemsRoute(app: FastifyInstance, deps: CustodyOpenItemsRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post('/internal/custody/open-items', async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    if (verified.service !== 'svc-ledger') {
      return reply
        .code(403)
        .send({ error: 'pay.open_items_service_forbidden', message: 'only svc-ledger may read the open custody items' });
    }
    const input = payCustodyRailOpenItemsInputSchema.safeParse(req.body);
    if (!input.success) {
      return reply.code(400).send({ error: 'pay.open_items_invalid', message: 'the request is not an open-items read' });
    }
    const { rail, ...page } = input.data;
    if (rail !== PAY_CUSTODY_OPEN_ITEMS_RAIL) {
      return reply
        .code(404)
        .send({ error: 'pay.open_items_rail_unknown', message: `svc-pay holds custody deposits on ${PAY_CUSTODY_OPEN_ITEMS_RAIL} only` });
    }
    try {
      return reply.send(await deps.list(page));
    } catch {
      return reply.code(503).send({ error: 'pay.custody_open_items_unavailable', message: 'the open custody items could not be read' });
    }
  });
}
