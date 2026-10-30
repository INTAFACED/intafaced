/**
 * The person's own VIP applications (SP-fees-vip-04, J-cex-spot-10 #7), self only: the user is the edge-signed
 * principal, never a body or query field.
 *
 *   GET  /api/v1/vip/applications  the owner's rules (accepted types and largest file) and the person's applications,
 *                                  metadata only. Not open: rules null and `closed` names why (the owner's rules or
 *                                  the proof key unset), so the screen says it before anyone sends a file.
 *   POST /api/v1/vip/applications  { requestId, proof: { fileName, contentType, bytesBase64 }, note? } → 201, or 200 for
 *                                  the same request again. Refusals name their code (vip-applications.ts).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import type { EdgeTrust } from '../edge-trust.js';
import type { OwnerFeeSchedule } from './fee-schedule.js';
import {
  VIP_ERROR_STATUS,
  VIP_PROOF_MAX_BYTES_CEILING,
  VipError,
  type VipApplicationRules,
  type VipApplicationStore,
} from './vip-applications.js';
import { privateRead, privateWrite } from '../route-inventory.js';

export const VIP_APPLICATIONS_PATH = '/api/v1/vip/applications';

/** The largest body the route reads: the largest proof the owner may allow, base64-encoded, and the fields around it. */
export const VIP_APPLICATION_BODY_LIMIT = Math.ceil(VIP_PROOF_MAX_BYTES_CEILING / 3) * 4 + 16 * 1024;

const bodySchema = z
  .object({
    requestId: z.string(),
    proof: z.object({ fileName: z.string(), contentType: z.string(), bytesBase64: z.string() }).strict(),
    note: z.string().nullable().optional(),
  })
  .strict();

export interface VipRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  store: Pick<VipApplicationStore, 'submit' | 'listOwn' | 'keyed'>;
  scheduleAt(at: Date): Promise<OwnerFeeSchedule>;
  now?: () => Date;
}

/** The rules in force now, and the version they come from; an unpublished schedule has none. */
async function rulesNow(deps: VipRestDeps): Promise<{ rules: VipApplicationRules | null; version: string | null }> {
  const schedule = await deps.scheduleAt((deps.now ?? (() => new Date()))());
  if (schedule.published !== true) return { rules: null, version: null };
  return { rules: schedule.tierProgram?.application ?? null, version: schedule.version };
}

export function registerVipRest(app: FastifyInstance, deps: VipRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });
  type Who = { refused: { status: number; code: string; message: string } } | { refused?: undefined; userId: string };
  const principalOf = (req: { headers: unknown; id: string }, scope: 'trade:read' | 'trade:write'): Who => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return { refused: { status: 401, code: 'trade.unauthenticated', message: 'signed principal required' } };
    try {
      requireScope(principal, scope);
    } catch (error) {
      if (error instanceof AuthError) return { refused: { status: 403, code: 'trade.permission_denied', message: error.message } };
      throw error;
    }
    return { userId: principal.userId };
  };

  app.get(VIP_APPLICATIONS_PATH, privateRead, async (req, reply) => {
    const who = principalOf(req, 'trade:read');
    if (who.refused) return reply.code(who.refused.status).send({ code: who.refused.code, message: who.refused.message });
    const { rules } = await rulesNow(deps);
    const closed = !rules ? 'vip.application_unset' : !deps.store.keyed ? 'vip.proof_key_unset' : null;
    return reply.code(200).send({ rules: closed ? null : rules, closed, applications: await deps.store.listOwn(who.userId) });
  });

  app.post(VIP_APPLICATIONS_PATH, { ...privateWrite, bodyLimit: VIP_APPLICATION_BODY_LIMIT }, async (req, reply) => {
    const who = principalOf(req, 'trade:write');
    if (who.refused) return reply.code(who.refused.status).send({ code: who.refused.code, message: who.refused.message });
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ code: 'vip.request_invalid', message: body.error.issues[0]?.message ?? 'invalid request' });
    }
    const { rules, version } = await rulesNow(deps);
    try {
      const { application, created } = await deps.store.submit(who.userId, rules, version ?? 'unpublished', {
        requestId: body.data.requestId,
        fileName: body.data.proof.fileName,
        contentType: body.data.proof.contentType,
        bytesBase64: body.data.proof.bytesBase64,
        note: body.data.note ?? null,
      });
      return reply.code(created ? 201 : 200).send({ application });
    } catch (error) {
      if (error instanceof VipError) {
        return reply.code(VIP_ERROR_STATUS[error.code]).send({ code: error.code, message: error.message, ...(error.data ?? {}) });
      }
      throw error;
    }
  });
}
