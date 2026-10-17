// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, iso, ok, page, refuse } from '../mock/shared.mjs';

/** Onboarding, verification, the team and exports. */
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
        memberId: 'a1111111-1111-4111-8111-111111111111',
        userId: 'TEST-user-finance',
        role: 'finance',
        status: 'active',
        label: 'TEST Accounts',
        invitedBy: USER_ID,
        createdAt: iso(now - 40 * DAY),
        activatedAt: iso(now - 39 * DAY),
        removedAt: null,
        cursor: 'c1',
      },
      {
        memberId: 'a2222222-2222-4222-8222-222222222222',
        userId: 'TEST-user-dev',
        role: 'developer',
        status: 'active',
        label: 'TEST Dev',
        invitedBy: USER_ID,
        createdAt: iso(now - 20 * DAY),
        activatedAt: iso(now - 20 * DAY),
        removedAt: null,
        cursor: 'c2',
      },
      {
        memberId: 'a3333333-3333-4333-8333-333333333333',
        userId: 'TEST-user-pending',
        role: 'viewer',
        status: 'invited',
        label: null,
        invitedBy: USER_ID,
        createdAt: iso(now - 1 * DAY),
        activatedAt: null,
        removedAt: null,
        cursor: 'c3',
      },
    ],
    teamHistory: [
      {
        seq: '3',
        memberUserId: 'TEST-user-pending',
        action: 'invited',
        fromRole: null,
        toRole: 'viewer',
        actorId: USER_ID,
        createdAt: iso(now - 1 * DAY),
      },
      {
        seq: '2',
        memberUserId: 'TEST-user-dev',
        action: 'accepted',
        fromRole: null,
        toRole: 'developer',
        actorId: 'TEST-user-dev',
        createdAt: iso(now - 20 * DAY),
      },
      {
        seq: '1',
        memberUserId: 'TEST-user-finance',
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
    exports: [
      {
        jobId: 'f0000001-0000-4000-8000-000000000001',
        kind: 'payments',
        filters: { from: iso(now - 30 * DAY).slice(0, 10) + 'T00:00:00.000Z', status: 'captured' },
        status: 'ready',
        failureCode: null,
        fileName: 'payments.csv',
        sizeBytes: '20480',
        rowCount: 312,
        sha256: 'cd'.repeat(32),
        requestedBy: USER_ID,
        columns: ['payment_id', 'amount'],
        generatedAt: iso(now - 3590_000),
        asOf: iso(now - 3600_000),
        expiresAt: null,
        createdAt: iso(now - 3600_000),
        completedAt: iso(now - 3590_000),
      },
      {
        jobId: 'f0000002-0000-4000-8000-000000000002',
        kind: 'settlements',
        filters: {},
        status: 'failed',
        failureCode: 'pay.export_failed',
        fileName: null,
        sizeBytes: null,
        rowCount: null,
        sha256: null,
        requestedBy: USER_ID,
        columns: ['settlement_id', 'net'],
        generatedAt: null,
        asOf: null,
        expiresAt: null,
        createdAt: iso(now - 2 * DAY),
        completedAt: iso(now - 2 * DAY),
      },
    ],
    destination: null,
  });

  const mine = state.members;
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
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
          state.destination = { kind: input.kind, ref: input.ref, railId: input.railId };
          return ok(route, state.destination);
        case 'merchantOps.kyb.current':
          return ok(route, state.kyb);
        case 'merchantOps.kyb.history':
          return ok(route, page(state.kybHistory, input));
        case 'merchantOps.team.list':
          return ok(route, page(input.status ? mine.filter((m) => m.status === input.status) : mine, input));
        case 'merchantOps.team.history':
          return ok(route, page(state.teamHistory, input));
        case 'merchantOps.team.myInvitations':
          return ok(route, state.invitations);
        case 'merchantOps.team.invite': {
          const row = {
            memberId: `c${mine.length}000000-0000-4000-8000-000000000000`,
            userId: input.userId,
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
            memberUserId: input.userId,
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
        case 'merchantOps.exports.list':
          return ok(
            route,
            page(
              state.exports.filter((e) => (!input.kind || e.kind === input.kind) && (!input.status || e.status === input.status)),
              input,
            ),
          );
        case 'merchantOps.exports.create': {
          const job = {
            jobId: `f${state.exports.length}000000-0000-4000-8000-000000000000`,
            kind: input.kind,
            filters: input.filters ?? {},
            status: 'queued',
            failureCode: null,
            fileName: null,
            sizeBytes: null,
            rowCount: null,
            sha256: null,
            requestedBy: USER_ID,
            columns: [],
            generatedAt: null,
            asOf: null,
            expiresAt: null,
            createdAt: iso(Date.now()),
            completedAt: null,
          };
          state.exports.unshift(job);
          setTimeout(
            () =>
              Object.assign(job, {
                status: 'ready',
                fileName: `${input.kind}.csv`,
                sizeBytes: '1024',
                rowCount: 12,
                sha256: 'ef'.repeat(32),
                generatedAt: iso(Date.now()),
                asOf: iso(Date.now()),
                completedAt: iso(Date.now()),
              }),
            1500,
          );
          return ok(route, job);
        }
        case 'merchantOps.exports.download':
          return ok(route, {
            fileName: 'payments.csv',
            contentType: 'text/csv; charset=utf-8',
            content: 'id,amount,asset\nTEST-1,10.5,USDT\n',
            sha256: 'cd'.repeat(32),
            rowCount: 1,
          });
        default:
          return NOT_MINE;
      }
    },
  };
}
