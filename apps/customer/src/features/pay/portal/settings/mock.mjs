// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, TEAM, USER_ID, iso, ok, page, refuse } from '../mock/shared.mjs';
import { createAccountMock } from './account/mock.mjs';
import { createApplicationMock } from './onboarding/mock.mjs';

/** Onboarding, verification and the team. Report files are answered by reports/mock.mjs. */
export function createSettingsMock(ctx) {
  const { scenario, now, state } = ctx;
  Object.assign(state, {
    members: [
      {
        memberId: null,
        userId: USER_ID,
        role: 'owner',
        status: 'active',
        label: null,
        invitedBy: null,
        createdAt: iso(now - 90 * DAY),
        activatedAt: iso(now - 90 * DAY),
        removedAt: null,
        cursor: null,
      },
      {
        memberId: TEAM.finance.memberId,
        userId: TEAM.finance.userId,
        role: 'finance',
        status: 'active',
        label: TEAM.finance.label,
        invitedBy: USER_ID,
        createdAt: iso(now - 40 * DAY),
        activatedAt: iso(now - 39 * DAY),
        removedAt: null,
        cursor: 'c1',
      },
      {
        memberId: TEAM.developer.memberId,
        userId: TEAM.developer.userId,
        role: 'developer',
        status: 'active',
        label: TEAM.developer.label,
        invitedBy: USER_ID,
        createdAt: iso(now - 20 * DAY),
        activatedAt: iso(now - 20 * DAY),
        removedAt: null,
        cursor: 'c2',
      },
      {
        memberId: TEAM.invited.memberId,
        userId: TEAM.invited.userId,
        role: 'viewer',
        status: 'invited',
        label: TEAM.invited.label,
        invitedBy: USER_ID,
        createdAt: iso(now - 1 * DAY),
        activatedAt: null,
        removedAt: null,
        cursor: 'c3',
      },
      {
        memberId: 'a4444444-4444-4444-8444-444444444444',
        userId: 'email:pending.person@test.invalid',
        role: 'viewer',
        status: 'invited',
        label: null,
        invitedBy: USER_ID,
        createdAt: iso(now - 2 * 3600_000),
        activatedAt: null,
        removedAt: null,
        cursor: 'c4',
      },
    ],
    teamHistory: [
      {
        seq: '3',
        memberUserId: TEAM.invited.userId,
        action: 'invited',
        fromRole: null,
        toRole: 'viewer',
        actorId: USER_ID,
        createdAt: iso(now - 1 * DAY),
      },
      {
        seq: '2',
        memberUserId: TEAM.developer.userId,
        action: 'accepted',
        fromRole: null,
        toRole: 'developer',
        actorId: TEAM.developer.userId,
        createdAt: iso(now - 20 * DAY),
      },
      {
        seq: '1',
        memberUserId: TEAM.finance.userId,
        action: 'role_changed',
        fromRole: 'viewer',
        toRole: 'finance',
        actorId: USER_ID,
        createdAt: iso(now - 38 * DAY),
      },
    ],
    invitations:
      scenario === 'new'
        ? [
            {
              memberId: 'b1111111-1111-4111-8111-111111111111',
              merchantId: '99999999-9999-4999-8999-999999999999',
              role: 'developer',
              invitedAt: iso(now - 2 * DAY),
            },
          ]
        : [],
    kyb: {
      kybStatus: scenario === 'quiet' ? 'none' : 'approved',
      kybRef: scenario === 'quiet' ? null : 'TEST-dossier-001',
      mode: 'gateway',
    },
    kybHistory:
      scenario === 'quiet'
        ? []
        : [
            {
              seq: '2',
              fromStatus: 'pending',
              toStatus: 'approved',
              kybRef: 'TEST-dossier-001',
              decidedBy: 'intafaced',
              reason: null,
              at: iso(now - 80 * DAY),
            },
            {
              seq: '1',
              fromStatus: 'none',
              toStatus: 'pending',
              kybRef: 'TEST-dossier-001',
              decidedBy: 'merchant',
              reason: null,
              at: iso(now - 85 * DAY),
            },
          ],
    destination: null,
  });

  const mine = state.members;
  const account = createAccountMock(ctx);
  const application = createApplicationMock(ctx);
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      const answered = await account.handle(procedure, input, route);
      if (answered !== NOT_MINE) return answered;
      const applied = await application.handle(procedure, input, route);
      if (applied !== NOT_MINE) return applied;
      switch (procedure) {
        case 'merchant.create':
          state.merchant = {
            id: MERCHANT_ID,
            userId: USER_ID,
            mode: 'gateway',
            status: 'pending',
            kybStatus: 'none',
            kybRef: null,
            feeBps: input.pricing.feeBps,
          };
          state.kyb = { kybStatus: 'none', kybRef: null, mode: 'gateway' };
          return ok(route, { id: MERCHANT_ID, userId: USER_ID, mode: 'gateway', feeBps: input.pricing.feeBps });
        case 'merchant.submitKyb':
          state.merchant = { ...state.merchant, kybStatus: 'pending', kybRef: input.kybRef };
          state.kyb = { kybStatus: 'pending', kybRef: input.kybRef, mode: 'gateway' };
          state.kybHistory.unshift({
            seq: String(state.kybHistory.length + 1),
            fromStatus: 'none',
            toStatus: 'pending',
            kybRef: input.kybRef,
            decidedBy: 'merchant',
            reason: null,
            at: iso(Date.now()),
          });
          return ok(route, { id: MERCHANT_ID, kybStatus: 'pending', kybRef: input.kybRef });
        case 'merchant.setPayoutDestination':
          // J-merchant-02 #5: verify verifies the saved address only, as svc-pay does, before the confirmation is spent.
          if (
            state.destination &&
            !state.destination.verified &&
            (state.destination.ref !== input.ref || state.destination.kind !== input.kind)
          )
            return refuse(route, 409, 'pay.destination_verify_mismatch');
          if (!ctx.stepUp?.spendDestinationApproval(input.stepUpApprovalId, input))
            return refuse(route, 403, 'pay.destination_step_up_required');
          {
            // J-merchant-02 #5: verifying starts the hold; the stand-in's TEST hold is 45 seconds, like the local stack's.
            const same = state.destination?.verified && state.destination.ref === input.ref && state.destination.railId === input.railId;
            if (!same)
              state.destination = {
                kind: input.kind,
                ref: input.ref,
                railId: input.railId,
                verified: true,
                activatesAt: new Date(Date.now() + 45_000).toISOString(),
              };
            const held = Date.parse(state.destination.activatesAt) > Date.now();
            const { kind, ref, railId } = state.destination;
            return ok(route, {
              kind,
              ref,
              railId,
              status: held ? 'held' : 'active',
              activatesAt: held ? state.destination.activatesAt : null,
            });
          }
        case 'merchantOps.kyb.current':
          return ok(route, state.kyb);
        case 'merchantOps.activation.get': {
          // The stand-in never records an activation, so it is never confirmed here; svc-pay's own record decides that.
          const status = state.merchant?.status ?? 'active';
          const reason = status === 'active' ? 'no_activation_record' : 'not_active';
          return ok(route, { activation: 'unconfirmed', status, activatedAt: null, reason });
        }
        case 'merchantOps.kyb.history':
          return ok(route, page(state.kybHistory, input));
        case 'merchantOps.team.list':
          return ok(route, page(input.status ? mine.filter((m) => m.status === input.status) : mine, input));
        case 'merchantOps.team.history':
          return ok(route, page(state.teamHistory, input));
        case 'merchantOps.team.myInvitations':
          return ok(route, state.invitations);
        case 'merchantOps.team.invite': {
          // Exactly one target, as the service requires. An email is never looked up, so the reply is the same for every address.
          const accountId = (input.userId ?? '').trim();
          const rawEmail = (input.email ?? '').trim();
          if ((accountId === '') === (rawEmail === '')) return refuse(route, 400, 'pay.team_invite_target_invalid');
          let target = accountId;
          if (rawEmail) {
            const email = rawEmail.toLowerCase();
            if (
              !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)
            ) {
              return refuse(route, 400, 'pay.team_email_invalid');
            }
            if (ctx.emailInvites === 'off') return refuse(route, 412, 'pay.team_email_invite_unconfigured');
            if (ctx.emailInvites === 'limited') return refuse(route, 412, 'pay.team_email_invite_rate_limited');
            target = `email:${email}`;
          } else if (accountId.toLowerCase().startsWith('email:')) {
            return refuse(route, 400, 'pay.team_user_id_reserved');
          }
          const row = {
            memberId: `c${mine.length}000000-0000-4000-8000-000000000000`,
            userId: target,
            role: input.role,
            status: 'invited',
            label: input.label ?? null,
            invitedBy: USER_ID,
            createdAt: iso(Date.now()),
            activatedAt: null,
            removedAt: null,
            cursor: `c${mine.length}`,
          };
          mine.push(row);
          state.teamHistory.unshift({
            seq: String(state.teamHistory.length + 1),
            memberUserId: target,
            action: 'invited',
            fromRole: null,
            toRole: input.role,
            actorId: USER_ID,
            createdAt: row.createdAt,
          });
          return ok(route, row);
        }
        case 'merchantOps.team.changeRole': {
          const row = mine.find((m) => m.memberId === input.memberId);
          if (!row) return refuse(route, 404, 'pay.team_member_not_found');
          state.teamHistory.unshift({
            seq: String(state.teamHistory.length + 1),
            memberUserId: row.userId,
            action: 'role_changed',
            fromRole: row.role,
            toRole: input.role,
            actorId: USER_ID,
            createdAt: iso(Date.now()),
          });
          row.role = input.role;
          return ok(route, row);
        }
        case 'merchantOps.team.remove': {
          const row = mine.find((m) => m.memberId === input.memberId);
          if (!row) return refuse(route, 404, 'pay.team_member_not_found');
          row.status = 'removed';
          return ok(route, row);
        }
        case 'merchantOps.team.acceptInvite':
          state.invitations = [];
          return ok(route, { ...mine[1], status: 'active' });
        case 'merchantOps.team.declineInvite':
          state.invitations = [];
          return ok(route, { declined: true });
        default:
          return NOT_MINE;
      }
    },
  };
}
