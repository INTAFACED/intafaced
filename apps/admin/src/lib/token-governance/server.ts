import 'server-only';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import {
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
      const result = await founderCall(
        ctx,
        'token',
        'governance.setRole',
        'POST',
        { userId: request.userId, role: request.role || null, expectedRevision: Number(request.revision), ...approval },
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
