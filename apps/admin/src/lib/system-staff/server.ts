import 'server-only';
import {
  staffAccessSchema,
  staffChangeResultSchema,
  staffGetSchema,
  staffListSchema,
  staffRolesListSchema,
  type StaffChangeResult,
} from '@intafaced/contracts/identity-staff';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import { staffPayloadHash } from '@/lib/desk/approval-hash';
import { isStaffRequestKind, staffRequestId, type StaffDeskRequest } from '@/lib/desk/approval-staff';
import type { ExecuteFn, StepBody } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import {
  ROSTER_NOT_BUILT,
  ROSTER_PAGE,
  STAFF_READS,
  identityPart,
  parseEnrolment,
  type RolesView,
  type RosterView,
  type StaffMemberView,
} from './model';

/**
 * Server-side reads and runs for the staff screens, always as the signed-in founder through svc-edge to svc-identity
 * (`/api/identity/trpc/staff.*` and `roles.*`). Every answer is parsed with the contract schema; one that does not parse is
 * "answered in a shape this console does not understand", never a row.
 */

const parseList = parseWith(staffListSchema);
const parseRoles = parseWith(staffRolesListSchema);
const parseGet = parseWith(staffGetSchema);
const parseAccess = parseWith(staffAccessSchema);
const parseResult = parseWith(staffChangeResultSchema);

function readRoles(ctx: FounderCallContext) {
  // The input is a strict empty object, so it is sent as `{}` rather than left out.
  return founderCall(ctx, 'identity', STAFF_READS.roles, 'GET', {}, parseRoles, { sendEmptyInput: true });
}

export async function loadRoster(ctx: FounderCallContext, cursor?: string): Promise<RosterView> {
  const [roster, roles, enrolment] = await Promise.all([
    founderCall(ctx, 'identity', STAFF_READS.list, 'GET', { limit: ROSTER_PAGE, ...(cursor ? { cursor } : {}) }, parseList),
    readRoles(ctx),
    founderCall(ctx, 'identity', 'auth.founderEnrolmentStatus', 'GET', {}, parseEnrolment),
  ]);
  return {
    asOf: new Date().toISOString(),
    roster: identityPart(roster),
    roles: identityPart(roles),
    enrolment: identityPart(enrolment),
  };
}

export async function loadStaffMember(ctx: FounderCallContext, staffId: string): Promise<StaffMemberView> {
  const [record, access, roles] = await Promise.all([
    founderCall(ctx, 'identity', STAFF_READS.get, 'GET', { staffId }, parseGet),
    founderCall(ctx, 'identity', STAFF_READS.access, 'GET', { staffId }, parseAccess),
    readRoles(ctx),
  ]);
  return {
    asOf: new Date().toISOString(),
    staffId,
    record: identityPart(record),
    access: identityPart(access),
    roles: identityPart(roles),
  };
}

export async function loadRoles(ctx: FounderCallContext): Promise<RolesView> {
  return { asOf: new Date().toISOString(), roles: identityPart(await readRoles(ctx)) };
}

/** The refusal for "svc-identity does not serve the staff procedures here". Nothing was asked of the approval desk. */
export function rosterNotBuiltRefusal(): RefusalView {
  return explainRefusal(ROSTER_NOT_BUILT, 404, false);
}

/**
 * Before a staff approval is proposed, ask svc-identity whether it serves the roster at all. If it does not, the request is
 * refused here and no approval is made, so none is left waiting to be spent on a change identity cannot run.
 */
export function staffPrecheck(ctx: FounderCallContext) {
  return async (body: StepBody): Promise<{ refusal: RefusalView; status: number } | null> => {
    if (body.step !== 'propose') return null;
    const probe = await readRoles(ctx);
    return probe.kind === 'not_built' ? { refusal: rosterNotBuiltRefusal(), status: 409 } : null;
  };
}

const PROCEDURE: Record<StaffDeskRequest['kind'], string> = {
  'identity.staff.invite': 'staff.invite',
  'identity.staff.disable': 'staff.disable',
  'identity.staff.remove': 'staff.remove',
  'identity.roles.define': 'roles.define',
  'identity.roles.assign': 'roles.assign',
  'identity.roles.unassign': 'roles.unassign',
};

/** The input identity's procedure takes for a request, with the business key and the approval it spends. */
export function staffChangeInput(request: StaffDeskRequest, approvalId: string): Record<string, unknown> {
  const requestId = staffRequestId(request.kind, approvalId);
  const approval = { approvalId, payloadHash: staffPayloadHash(request) };
  switch (request.kind) {
    case 'identity.staff.invite':
      return { requestId, email: request.email, displayName: request.displayName, roleIds: [...request.roleIds], approval };
    case 'identity.staff.disable':
    case 'identity.staff.remove':
      return { requestId, staffId: request.staffId, reason: request.reason, expectedVersion: request.version, approval };
    case 'identity.roles.define':
      return {
        requestId,
        ...(request.roleId !== null && request.version !== null ? { roleId: request.roleId, expectedVersion: request.version } : {}),
        name: request.name,
        allow: [...request.allow],
        deny: [...request.deny],
        approval,
      };
    case 'identity.roles.assign':
    case 'identity.roles.unassign':
      return { requestId, staffId: request.staffId, roleId: request.roleId, expectedVersion: request.version, approval };
  }
}

const WRONG_STATE: ExecuteReply = { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };

/** True when what identity returned is the change this request asked for. */
function resultMatches(request: StaffDeskRequest, result: Exclude<StaffChangeResult, { outcome: 'refused' }>): boolean {
  const { staff, role } = result;
  switch (request.kind) {
    case 'identity.staff.invite':
      return staff !== null && staff.email === request.email;
    case 'identity.staff.disable':
      return staff !== null && staff.staffId === request.staffId && staff.status === 'disabled';
    case 'identity.staff.remove':
      return staff === null || staff.staffId === request.staffId;
    case 'identity.roles.define':
      return (
        role !== null &&
        (request.roleId === null || role.roleId === request.roleId) &&
        role.name.toLowerCase() === request.name.toLowerCase()
      );
    case 'identity.roles.assign':
      return staff !== null && staff.staffId === request.staffId && staff.roleIds.includes(request.roleId);
    case 'identity.roles.unassign':
      return staff !== null && staff.staffId === request.staffId && !staff.roleIds.includes(request.roleId);
  }
}

/** What identity answered, as the desk shows it. Only a change identity reports, of the request asked for, counts as done. */
export function staffChangeReply(request: StaffDeskRequest, approvalId: string, result: StaffChangeResult): ExecuteReply {
  if (result.action !== request.kind || result.requestId !== staffRequestId(request.kind, approvalId)) return WRONG_STATE;
  if (result.outcome === 'refused') {
    const refusal = explainRefusal(result.code, 409, false);
    return {
      ok: false,
      refusal: result.detail.length > 0 ? { ...refusal, body: `${refusal.body} It names: ${result.detail.join(', ')}.` } : refusal,
    };
  }
  if (!resultMatches(request, result)) return WRONG_STATE;
  const approver = `approved by ${result.approverId.slice(0, 8)}, audit entry ${result.auditId}`;
  return {
    ok: true,
    detail:
      result.outcome === 'replayed'
        ? `svc-identity had already made this change for this request (${approver}); it answered with what it stored and changed nothing again.`
        : `svc-identity made the change (${approver}).`,
  };
}

/** Run an approved staff change as the signed-in founder. svc-identity spends the approval once. */
export function staffExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request: DeskRequest, ids) => {
    if (!isStaffRequestKind(request.kind)) return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const staffRequest = request as StaffDeskRequest;
    const result = await founderCall(
      ctx,
      'identity',
      PROCEDURE[staffRequest.kind],
      'POST',
      staffChangeInput(staffRequest, ids.approvalId),
      parseResult,
    );
    if (result.kind === 'not_built') return { ok: false, refusal: rosterNotBuiltRefusal() };
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    return staffChangeReply(staffRequest, ids.approvalId, result.data);
  };
}
