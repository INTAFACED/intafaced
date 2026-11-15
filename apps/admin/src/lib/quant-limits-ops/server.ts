import 'server-only';
import {
  quantEscapeCorpusInputSchema,
  quantEscapeCorpusSchema,
  quantQuotaAssignInputSchema,
  quantQuotaProfileSchema,
  quantQuotaSetInputSchema,
  quantSandboxLimitSetInputSchema,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { LimitsDeskOp, LimitsDeskReply, LimitsDeskView } from './model';

/**
 * Plan quotas and sandbox limits as the signed-in founder (J-algo-dev-12). svc-quant holds the profiles and records
 * every write with its reason (`ops.quota.*`, `ops.sandbox.corpus`: `admin:read` to read, `admin:write` to act, module
 * quant), naming the founder from their own token. Nothing here moves money.
 */

const QUANT: PartLabels = {
  service: 'svc-quant',
  forbiddenMessage:
    'svc-quant did not accept your founder session for plan limits (it needs admin:read with module quant to read and admin:write to act).',
};

const readProfile = parseWith(quantQuotaProfileSchema);
const readCorpus = parseWith(quantEscapeCorpusSchema);

export async function loadLimitsDesk(ctx: FounderCallContext, profile: string): Promise<LimitsDeskView> {
  const read = await founderCall(ctx, 'quant', 'ops.quota.profile', 'GET', { profile }, readProfile);
  return { asOf: new Date().toISOString(), profile: partFrom(read, (d) => d, QUANT) };
}

const CODE_SUFFIX = /\s*\[[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+\]\s*$/;

function reply(result: FounderCallResult<unknown>, what: string, corpus: boolean): { status: number; reply: LimitsDeskReply } {
  const refused = (code: string | null, status: number, message: string | null, uncertain = false) => {
    const view = explainRefusal(code, status, uncertain);
    // svc-quant's own sentence names what was missing; a console paraphrase would lose it.
    const body = message?.replace(CODE_SUFFIX, '').trim();
    return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false as const, ...view, code, body: body || view.body } };
  };
  switch (result.kind) {
    case 'ok': {
      if (!corpus) return { status: 200, reply: { ok: true, what, corpus: null } };
      const ran = readCorpus(result.data);
      return ran ? { status: 200, reply: { ok: true, what, corpus: ran } } : refused(null, 502, null, true);
    }
    case 'refused':
      return refused(result.refusal.code, result.refusal.status, result.refusal.message);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403, result.refusal.code ? result.refusal.message : null);
    case 'not_built':
      return refused('not_built', 501, null);
    case 'unavailable':
      return refused(null, 503, null, result.uncertain);
    case 'invalid':
      return refused(null, 502, null, true);
  }
}

const OPS = {
  set: { procedure: 'ops.quota.set', schema: quantQuotaSetInputSchema, what: 'the quota limit is saved' },
  sandbox: { procedure: 'ops.quota.sandbox', schema: quantSandboxLimitSetInputSchema, what: 'the sandbox limit is saved' },
  assign: { procedure: 'ops.quota.assign', schema: quantQuotaAssignInputSchema, what: 'the account is on the plan' },
  corpus: { procedure: 'ops.sandbox.corpus', schema: quantEscapeCorpusInputSchema, what: 'the escape corpus ran' },
} as const;

/** One listed action. The input is checked against the contract here; svc-quant checks it again and decides. */
export async function actOnLimits(
  ctx: FounderCallContext,
  op: LimitsDeskOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: LimitsDeskReply } | { why: string }> {
  const { op: _op, ...input } = body;
  const spec = OPS[op];
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: 'Which plan, which limit and value, and a reason of at most 500 characters?' };
  return reply(await founderCall(ctx, 'quant', spec.procedure, 'POST', parsed.data, (raw) => raw), spec.what, op === 'corpus');
}
