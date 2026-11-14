import {
  ADDRESS_LABEL_KINDS,
  HUMAN_TOKEN_TIERS,
  protocolComplianceReportsOutputSchema,
  protocolComplianceReviewSchema,
  protocolNameTagRequestSchema,
  protocolNameTagsOutputSchema,
  protocolOnboardingChecklistSchema,
  protocolOnboardingOutputSchema,
  protocolTokenTierSchema,
  protocolTokenTiersOutputSchema,
} from '@intafaced/contracts/protocol-address-risk';
import { protocolAuditProductsSchema } from '@intafaced/contracts/protocol-blockers';
import { tokensListOutputSchema } from '@intafaced/contracts/protocol-tokens';
import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { founderCall, parseWith, type FounderCallResult } from '@/lib/desk/founder-call';
import { trustRefusalWords } from '@/lib/protocol-trust/model';

/**
 * The Protocol trust desk (J-dex-protocol-30) as the signed-in founder: GET reads svc-protocol's compliance queue, its
 * token list, its audit rows, the human token tiers and the permissioned pool checklists; POST asks for or approves a
 * label, a tier or a name tag, removes a tier, and opens or approves a checklist (`compliance.*`). The second person must be a
 * different person, which svc-protocol enforces. A reply that never arrived is reported as
 * unknown, never as failed, and is never sent again on its own.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const answer = (payload: Record<string, unknown>, status: number): Response => Response.json(payload, { status, headers: NO_STORE });

type Part<T> = { ok: true; data: T } | { ok: false; message: string };
function part<T>(result: FounderCallResult<T>, what: string): Part<T> {
  switch (result.kind) {
    case 'ok':
      return { ok: true, data: result.data };
    case 'forbidden':
      return {
        ok: false,
        message: `svc-protocol did not accept this session for the ${what}. It needs the operator read permission (admin:read).`,
      };
    case 'refused':
      return { ok: false, message: `svc-protocol refused the ${what}: ${result.refusal.code ?? result.refusal.message}.` };
    case 'not_built':
      return { ok: false, message: `svc-protocol does not serve the ${what} on this deployment.` };
    case 'invalid':
      return { ok: false, message: `svc-protocol answered the ${what} in a shape this console does not understand.` };
    case 'unavailable':
      return { ok: false, message: `svc-protocol did not answer for the ${what}.` };
  }
}

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('protocol-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const [reports, tokens, audit, tiers, onboarding, nameTags] = await Promise.all([
    founderCall(session, 'protocol', 'compliance.reports.list', 'GET', undefined, parseWith(protocolComplianceReportsOutputSchema)),
    founderCall(session, 'protocol', 'tokens.list', 'GET', { window: '24h' }, parseWith(tokensListOutputSchema)),
    founderCall(session, 'protocol', 'auditProducts', 'GET', undefined, parseWith(protocolAuditProductsSchema)),
    founderCall(session, 'protocol', 'compliance.tiers.list', 'GET', undefined, parseWith(protocolTokenTiersOutputSchema)),
    founderCall(session, 'protocol', 'compliance.onboarding.list', 'GET', undefined, parseWith(protocolOnboardingOutputSchema)),
    founderCall(session, 'protocol', 'compliance.nameTags.list', 'GET', undefined, parseWith(protocolNameTagsOutputSchema)),
  ]);
  return answer(
    {
      asOf: new Date().toISOString(),
      reports: part(reports, 'report queue'),
      tokens: part(tokens, 'token list'),
      audit: part(audit, 'audit rows'),
      tiers: part(tiers, 'token tiers'),
      onboarding: part(onboarding, 'pool onboarding checklists'),
      nameTags: part(nameTags, 'name tag requests'),
    },
    200,
  );
}

/** svc-protocol's own words for a checklist refusal, which name the blank items; the desk's words for the rest. */
function refusalWords(code: string | null, message: string): string {
  const prefix = 'protocol.onboarding.incomplete: ';
  if (code === 'protocol.onboarding.incomplete' && message.startsWith(prefix)) return message.slice(prefix.length);
  return trustRefusalWords(code) ?? 'svc-protocol refused this.';
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('protocol-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const invalid = () =>
    answer({ ok: false, code: 'admin.request_invalid', message: 'That request was not accepted. Nothing was sent.' }, 400);
  const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length === 0 || t.length > max ? null : t;
  };
  const addr = (v: unknown): string | null | undefined =>
    v === null || v === undefined || v === '' ? null : typeof v === 'string' && ADDRESS.test(v.trim()) ? v.trim() : undefined;
  let procedure: string;
  let input: Record<string, string | null>;
  let schema: Parameters<typeof parseWith<unknown>>[0] = protocolComplianceReviewSchema;
  if (raw.op === 'ask') {
    const reason = text(raw.reason, 500);
    if (typeof raw.reportId !== 'string' || !UUID.test(raw.reportId)) return invalid();
    if (!(ADDRESS_LABEL_KINDS as readonly unknown[]).includes(raw.kind) || reason === null) return invalid();
    procedure = 'compliance.labels.ask';
    input = { reportId: raw.reportId, kind: raw.kind as string, reason };
  } else if (raw.op === 'approve') {
    if (typeof raw.reviewId !== 'string' || !UUID.test(raw.reviewId)) return invalid();
    procedure = 'compliance.labels.approve';
    input = { reviewId: raw.reviewId };
  } else if (raw.op === 'tier-ask') {
    const reason = text(raw.reason, 500);
    const token = addr(raw.token);
    if (!token || !(HUMAN_TOKEN_TIERS as readonly unknown[]).includes(raw.tier) || reason === null) return invalid();
    procedure = 'compliance.tiers.ask';
    input = { token, tier: raw.tier as string, reason };
    schema = protocolTokenTierSchema;
  } else if (raw.op === 'tier-approve') {
    if (typeof raw.requestId !== 'string' || !UUID.test(raw.requestId)) return invalid();
    procedure = 'compliance.tiers.approve';
    input = { requestId: raw.requestId };
    schema = protocolTokenTierSchema;
  } else if (raw.op === 'tier-remove') {
    const reason = text(raw.reason, 500);
    const token = addr(raw.token);
    if (!token || reason === null) return invalid();
    procedure = 'compliance.tiers.remove';
    input = { token, reason };
    schema = protocolTokenTierSchema;
  } else if (raw.op === 'onboarding-open') {
    const pool = text(raw.pool, 120);
    const [tokenContract, checkerAddress, wrapperAddress] = [addr(raw.tokenContract), addr(raw.checkerAddress), addr(raw.wrapperAddress)];
    if (pool === null || tokenContract === undefined || checkerAddress === undefined || wrapperAddress === undefined) return invalid();
    procedure = 'compliance.onboarding.open';
    input = {
      pool,
      legalEntity: text(raw.legalEntity, 200),
      tokenContract,
      checkerAddress,
      wrapperAddress,
      routingRegistration: text(raw.routingRegistration, 200),
    };
    schema = protocolOnboardingChecklistSchema;
  } else if (raw.op === 'onboarding-approve') {
    const reason = text(raw.reason, 500);
    if (typeof raw.checklistId !== 'string' || !UUID.test(raw.checklistId) || reason === null) return invalid();
    procedure = 'compliance.onboarding.approve';
    input = { checklistId: raw.checklistId, reason };
    schema = protocolOnboardingChecklistSchema;
  } else if (raw.op === 'nametag-request') {
    const tag = text(raw.tag, 60);
    const reason = text(raw.reason, 500);
    const address = addr(raw.address);
    if (!address || tag === null || reason === null) return invalid();
    procedure = 'compliance.nameTags.request';
    input = { address, tag, reason };
    schema = protocolNameTagRequestSchema;
  } else if (raw.op === 'nametag-approve') {
    if (typeof raw.requestId !== 'string' || !UUID.test(raw.requestId)) return invalid();
    procedure = 'compliance.nameTags.approve';
    input = { requestId: raw.requestId };
    schema = protocolNameTagRequestSchema;
  } else return invalid();

  const result = await founderCall(session, 'protocol', procedure, 'POST', input, parseWith(schema));
  switch (result.kind) {
    case 'ok':
      return answer({ ok: true, result: result.data }, 200);
    case 'forbidden':
      return answer(
        {
          ok: false,
          code: result.refusal.code,
          message: 'svc-protocol did not accept this session for that. It needs the operator write permission (admin:write).',
        },
        403,
      );
    case 'refused':
      return answer({ ok: false, code: result.refusal.code, message: refusalWords(result.refusal.code, result.refusal.message) }, 409);
    case 'not_built':
      return answer({ ok: false, code: 'not_built', message: 'svc-protocol does not serve this on this deployment.' }, 501);
    case 'invalid':
      return answer(
        {
          ok: false,
          unknown: true,
          message: 'svc-protocol answered in a shape this console does not understand. Reload to see what is stored.',
        },
        502,
      );
    case 'unavailable':
      return answer(
        {
          ok: false,
          unknown: result.uncertain,
          message: 'svc-protocol did not answer. Reload to see what is stored; nothing is repeated automatically.',
        },
        503,
      );
  }
}
