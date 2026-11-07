import 'server-only';
import { createHash } from 'node:crypto';
import { CLAIMS_STORAGE_UNCONFIGURED, claimWriteOutputSchema, type ClaimWriteOutput } from '@intafaced/contracts/ops-marketing-claims';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { opsReadOf } from '@/lib/desk/ops-read';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { readClaimsList, type ClaimsView } from './model';

/** svc-ops `claims.list`: every claim, newest first, with its evidence or its block. Never throws. */
export async function loadClaims(ctx: FounderCallContext): Promise<ClaimsView> {
  return opsReadOf(
    await founderCall(ctx, 'ops', 'claims.list', 'GET', undefined, readClaimsList),
    CLAIMS_STORAGE_UNCONFIGURED,
    'claims register',
  );
}

export interface ClaimContent {
  readonly topic: string;
  readonly text: string;
  readonly evidence: string | null;
}

/** The record's business key: the founder and the content. A lost reply sent again finds the same claim. */
export function claimKey(founder: string, content: ClaimContent): string {
  return `claim:${createHash('sha256')
    .update(JSON.stringify([founder, content.topic, content.text, content.evidence]))
    .digest('hex')
    .slice(0, 48)}`;
}

const parseWrite = (raw: unknown): ClaimWriteOutput | null => {
  const parsed = claimWriteOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

function reply(result: FounderCallResult<ClaimWriteOutput>, done: (out: ClaimWriteOutput) => string) {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return { status: 200, reply: { ok: true as const, what: done(result.data), claim: result.data.claim } };
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

export async function recordClaim(ctx: FounderCallContext, content: ClaimContent) {
  const key = claimKey(ctx.session.userId, content);
  return reply(await founderCall(ctx, 'ops', 'claims.record', 'POST', { key, ...content }, parseWrite), (out) =>
    out.outcome === 'replayed' ? 'this claim was already recorded' : 'claim recorded',
  );
}

export async function publishClaim(ctx: FounderCallContext, id: string) {
  return reply(await founderCall(ctx, 'ops', 'claims.publish', 'POST', { id }, parseWrite), (out) =>
    out.outcome === 'noop' ? 'it was already published' : 'claim published',
  );
}
