import 'server-only';
import { doorForScope } from '@intafaced/contracts';
import type { ExecuteFn, ExecuteReply } from '@/lib/desk/approval-steps';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import {
  isObj,
  readRoleResult,
  readRoles,
  readSettings,
  readSettingsHistory,
  type GovernanceSettings,
  type RoleRow,
  type SettingsMove,
} from './model';

/**
 * Token governance (J-more-catalogue-10), read and written as the signed-in founder through svc-token `governance.*`. Each
 * write spends a two-founder identity approval bound to its exact fields; svc-token refuses one founder acting alone. This
 * console adds no authority and keeps no state.
 */

const LABELS = {
  service: 'svc-token',
  forbiddenMessage: 'svc-token did not accept this founder session for governance (admin:read).',
};
/** svc-token's largest roles page. A full page says that more exist. */
const PAGE = 200;

export interface GovernanceRead {
  readonly settings: Part<GovernanceSettings>;
  readonly history: Part<SettingsMove[]>;
  readonly roles: Part<RoleRow[]>;
  readonly rolesFull: boolean;
  readonly asOf: string;
}

export async function readGovernance(ctx: FounderCallContext): Promise<GovernanceRead> {
  const [settings, history, roles] = await Promise.all([
    founderCall(ctx, 'token', 'governance.settings', 'GET', undefined, readSettings),
    founderCall(ctx, 'token', 'governance.settingsHistory', 'GET', undefined, readSettingsHistory),
    founderCall(ctx, 'token', 'governance.roles', 'GET', { limit: PAGE }, readRoles),
  ]);
  const rolePart = partFrom(roles, (d) => d, LABELS);
  return {
    settings: partFrom(settings, (d) => d, LABELS),
    history: partFrom(history, (d) => d, LABELS),
    roles: rolePart,
    rolesFull: rolePart.kind === 'ok' && rolePart.data.length === PAGE,
    asOf: new Date().toISOString(),
  };
}

/** Runs an approved settings or role change once, spending the approval at svc-token. */
export function governanceExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    const approval = { approvalId: ids.approvalId, operationId: ids.operationId };
    if (request.kind === 'token.governance.settings.set') {
      const result = await founderCall(
        ctx,
        'token',
        'governance.setSettings',
        'POST',
        {
          votingDelayMs: request.votingDelayMs || null,
          votingPeriodMs: request.votingPeriodMs || null,
          expectedRevision: Number(request.revision),
          ...approval,
        },
        readSettings,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-token', 'token', result);
      return { ok: true, detail: `The governance settings are stored at revision ${result.data.revision}.` };
    }
    if (request.kind === 'token.governance.role.set') {
      // A role change needs this founder's fresh step-up for exactly this move (J-more-catalogue-10 #6). Without a code,
      // svc-token is asked anyway and refuses identity.step_up_required, so the desk says what is missing.
      let stepUpApprovalId: string | null = null;
      if (ids.stepUpCode) {
        const stepped = await stepUpForRole(ctx, request, ids.stepUpCode);
        if (!stepped.ok) return stepped;
        stepUpApprovalId = stepped.stepUpApprovalId;
      }
      const result = await founderCall(
        ctx,
        'token',
        'governance.setRole',
        'POST',
        {
          userId: request.userId,
          role: request.role || null,
          expectedRevision: Number(request.revision),
          ...approval,
          ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
        },
        readRoleResult,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-token', 'token', result);
      if (result.data.userId !== request.userId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
      return {
        ok: true,
        detail: `Account ${result.data.userId} ${result.data.role ? `is ${result.data.role}` : 'has no governance role'}, at revision ${result.data.revision}.`,
      };
    }
    return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
  };
}

/** The scope and purpose identity binds a governance role step-up to, from its door in contracts. */
const ROLE_DOOR = doorForScope('token.step_up.governance.setRole');
const ROLE_STEP_UP = { scope: ROLE_DOOR?.scope ?? '', purpose: ROLE_DOOR?.purpose ?? '' };

/**
 * Proves the signed-in founder's fresh authenticator code for exactly this role move at identity: begin binds the
 * account, role and revision to this founder and session, complete spends the code and mints a single-use approval that
 * svc-token consumes once.
 */
async function stepUpForRole(
  ctx: FounderCallContext,
  request: Extract<DeskRequest, { kind: 'token.governance.role.set' }>,
  code: string,
): Promise<{ ok: true; stepUpApprovalId: string } | { ok: false; refusal: RefusalView }> {
  const fields = { userId: request.userId, role: request.role, expectedRevision: request.revision };
  const begun = await founderCall(ctx, 'identity', 'stepUp.begin', 'POST', { ...ROLE_STEP_UP, target: request.userId, fields }, (raw) =>
    isObj(raw) && typeof raw.challengeId === 'string' && raw.totp === true ? { challengeId: raw.challengeId } : null,
  );
  if (begun.kind !== 'ok') return refusedOnly(failureRefusal('svc-identity', 'identity', begun));
  const done = await founderCall(
    ctx,
    'identity',
    'stepUp.complete',
    'POST',
    { challengeId: begun.data.challengeId, totpCode: code },
    (raw) => (isObj(raw) && typeof raw.stepUpApprovalId === 'string' && raw.scope === ROLE_STEP_UP.scope ? raw.stepUpApprovalId : null),
  );
  if (done.kind !== 'ok') return refusedOnly(failureRefusal('svc-identity', 'identity', done));
  return { ok: true, stepUpApprovalId: done.data };
}

/** A failed call's refusal; a reply that claims success here is the console's own fault, not a pass. */
const refusedOnly = (reply: ExecuteReply): { ok: false; refusal: RefusalView } =>
  reply.ok ? { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) } : { ok: false, refusal: reply.refusal };
