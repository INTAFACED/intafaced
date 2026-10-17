/**
 * TEST fixture for the Freezes & approvals, Audit and Exports rooms. In memory, local only, never deployed.
 *
 * Answers what the real services answer, with the real codes:
 *   · svc-trade  accountControls.getState / history / change  (restriction state kept in state.restrictions)
 *   · svc-identity actionApproval.propose / approve / reject / revoke  (approvals kept in state.approvals)
 * The signed-in operator is Nitro (the TEST sign-in token); a sign-in with an identifier that starts with "phantom" is the second TEST
 * founder. One PENDING request from Phantom is also seeded so the approve path can be tried:
 *     approval id  appr-test-phantom-1
 *     account      00000000-0000-4000-8000-000000000100, restrict, version 0, reason "seeded test request"
 *     payload hash is shown by the "Work out the hash" helper with exactly those details.
 * Approving your own proposal answers action_approval.same_person, as the service does.
 * There is no list or read-back for approvals here either, because the real service has none.
 */
import { createHash, randomUUID } from 'node:crypto';
import { NITRO, PHANTOM, actorOf } from '../base.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_USERS = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`);
const KNOWN = new Set([NITRO, PHANTOM, ...TEST_USERS]);
const TTL_MS = 24 * 3_600_000;

/** Same canonical form as @intafaced/contracts founderChangeHash: keys sorted with the fixed 'en' collation. */
const stable = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')))
      : v,
  );
const changeHash = (target, expectedVersion) => `sha256:${createHash('sha256').update(stable({ target, expectedVersion })).digest('hex')}`;

const ok = (data) => ({ status: 200, body: { result: { data: { json: data } } } });
const trpcError = (httpStatus, trpcCode, appCode, message) => ({
  status: httpStatus,
  body: { error: { json: { message: `${message} [${appCode}]`, code: -32600, data: { code: trpcCode, httpStatus, appCode } } } },
});
const approvalError = (code, message) => {
  const http = code === 'action_approval.not_found' ? 404 : code === 'action_approval.not_requester' ? 403 : 412;
  const trpc =
    code === 'action_approval.not_found' ? 'NOT_FOUND' : code === 'action_approval.not_requester' ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
  return trpcError(http, trpc, code, message);
};
const unauthorized = () => trpcError(401, 'UNAUTHORIZED', 'auth.session_invalid', 'sign in again');

const inputOf = (query, body, method) => {
  const raw = method === 'GET' ? JSON.parse(query.get('input') ?? '{}') : body;
  return raw && typeof raw === 'object' && 'json' in raw ? raw.json : raw;
};

export default function routes(state) {
  const restrictions = state.restrictions; // Map<userId, { version: number, restricted: boolean, history: Result[] }>
  const approvals = state.approvals; // Map<approvalId, Approval>
  const requestSeen = (state.requestSeen ??= new Map()); // requestId -> JSON of the request, for request.conflict

  const accountOf = (userId) => {
    if (!KNOWN.has(userId)) return null;
    if (!restrictions.has(userId)) restrictions.set(userId, { version: 0, restricted: false, history: [] });
    return restrictions.get(userId);
  };
  const stateOf = (userId, acct) => ({ target: { area: 'trading', userId }, version: String(acct.version), restricted: acct.restricted });

  // Seed once: one PENDING request from Phantom.
  if (!approvals.has('appr-test-phantom-1')) {
    const userId = TEST_USERS[0];
    const reason = 'seeded test request';
    const now = Date.now();
    approvals.set('appr-test-phantom-1', {
      approvalId: 'appr-test-phantom-1',
      actionType: 'account.trading_restriction',
      targetService: 'svc-trade',
      targetId: `trading:${userId}`,
      expectedVersion: '0',
      payloadHash: changeHash({ area: 'trading', userId, action: 'restrict', reason }, '0'),
      requesterId: PHANTOM,
      approverId: null,
      policyVersion: 'trading-restriction-v1',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL_MS).toISOString(),
      status: 'PENDING',
      operationId: 'appr-test-phantom-1',
    });
  }

  const live = (id) => {
    const a = approvals.get(id);
    if (!a) return { error: approvalError('action_approval.not_found', 'no approval has that id') };
    if (a.status === 'PENDING' && Date.parse(a.expiresAt) < Date.now()) {
      a.status = 'EXPIRED';
    }
    return { approval: a };
  };
  const terminal = (a, fallback) =>
    a.status === 'EXPIRED'
      ? approvalError('action_approval.expired', 'the approval has expired')
      : approvalError(fallback, `the approval is ${a.status}`);

  return [
    // ── svc-trade accountControls ──
    {
      method: 'GET',
      path: '/api/trade/trpc/accountControls.getState',
      handle: ({ query, headers }) => {
        if (!actorOf(headers)) return unauthorized();
        const { target } = inputOf(query, {}, 'GET');
        if (target?.area !== 'trading' || !UUID.test(target.userId ?? ''))
          return trpcError(400, 'BAD_REQUEST', 'trade.bad_input', 'target must be a trading user id');
        const acct = accountOf(target.userId);
        return ok(acct ? stateOf(target.userId, acct) : null);
      },
    },
    {
      method: 'GET',
      path: '/api/trade/trpc/accountControls.history',
      handle: ({ query, headers }) => {
        if (!actorOf(headers)) return unauthorized();
        const { target, limit } = inputOf(query, {}, 'GET');
        if (target?.area !== 'trading' || !UUID.test(target.userId ?? '') || !Number.isInteger(limit) || limit < 1 || limit > 200)
          return trpcError(400, 'BAD_REQUEST', 'trade.bad_input', 'target and a limit from 1 to 200 are required');
        const acct = accountOf(target.userId);
        return ok(acct ? [...acct.history].reverse().slice(0, limit) : []);
      },
    },
    {
      method: 'POST',
      path: '/api/trade/trpc/accountControls.change',
      handle: ({ body, headers }) => {
        const actor = actorOf(headers);
        if (!actor) return unauthorized();
        const input = inputOf(null, body, 'POST');
        if (
          !UUID.test(input.requestId ?? '') ||
          input.target?.area !== 'trading' ||
          !UUID.test(input.target.userId ?? '') ||
          !['restrict', 'restore'].includes(input.action)
        )
          return trpcError(400, 'BAD_REQUEST', 'trade.bad_input', 'requestId, a trading target and restrict|restore are required');
        const reason = String(input.reason ?? '').trim();
        if (reason.length < 3 || reason.length > 500 || !/^(0|[1-9]\d*)$/.test(String(input.expectedVersion ?? '')))
          return trpcError(400, 'BAD_REQUEST', 'trade.bad_input', 'reason 3-500 characters and a numeric expected version are required');
        const base = {
          auditId: randomUUID(),
          requestId: input.requestId,
          target: input.target,
          action: input.action,
          reason,
          occurredAt: new Date().toISOString(),
        };
        const acct = accountOf(input.target.userId);
        const fingerprint = JSON.stringify([input.target, input.action, reason, input.expectedVersion]);
        const refuse = (code, current) => {
          const row = { ...base, outcome: 'refused', changed: false, actorUserId: actor, code, current };
          if (acct) acct.history.push(row);
          return ok(row);
        };
        if (requestSeen.has(input.requestId) && requestSeen.get(input.requestId) !== fingerprint)
          return refuse('request.conflict', acct ? stateOf(input.target.userId, acct) : null);
        requestSeen.set(input.requestId, fingerprint);
        if (!acct) return ok({ ...base, outcome: 'refused', changed: false, actorUserId: actor, code: 'target.not_found', current: null });
        const before = stateOf(input.target.userId, acct);
        if (String(acct.version) !== String(input.expectedVersion)) {
          const row = {
            ...base,
            outcome: 'conflict',
            changed: false,
            actorUserId: actor,
            code: 'restriction.version_conflict',
            current: before,
          };
          acct.history.push(row);
          return ok(row);
        }
        const want = input.action === 'restrict';
        if (acct.restricted === want) {
          const row = { ...base, outcome: 'noop', changed: false, actorUserId: actor, before, after: before };
          acct.history.push(row);
          return ok(row);
        }
        acct.restricted = want;
        acct.version += 1;
        const row = { ...base, outcome: 'changed', changed: true, actorUserId: actor, before, after: stateOf(input.target.userId, acct) };
        acct.history.push(row);
        return ok(row);
      },
    },
    // ── svc-identity actionApproval ──
    {
      method: 'POST',
      path: '/api/identity/trpc/actionApproval.propose',
      handle: ({ body, headers }) => {
        const actor = actorOf(headers);
        if (!actor) return unauthorized();
        const i = inputOf(null, body, 'POST');
        for (const k of ['actionType', 'targetService', 'targetId', 'expectedVersion', 'payloadHash', 'policyVersion'])
          if (typeof i[k] !== 'string' || !i[k]) return trpcError(400, 'BAD_REQUEST', 'trade.bad_input', `${k} is required`);
        const approvalId = `appr-${randomUUID().slice(0, 8)}`;
        const now = Date.now();
        const a = {
          approvalId,
          actionType: i.actionType,
          targetService: i.targetService,
          targetId: i.targetId,
          expectedVersion: i.expectedVersion,
          payloadHash: i.payloadHash,
          requesterId: actor,
          approverId: null,
          policyVersion: i.policyVersion,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + TTL_MS).toISOString(),
          status: 'PENDING',
          operationId: approvalId,
        };
        approvals.set(approvalId, a);
        return ok(a);
      },
    },
    {
      method: 'POST',
      path: '/api/identity/trpc/actionApproval.approve',
      handle: ({ body, headers }) => {
        const actor = actorOf(headers);
        if (!actor) return unauthorized();
        const i = inputOf(null, body, 'POST');
        const { approval: a, error } = live(i.approvalId);
        if (error) return error;
        if (a.status !== 'PENDING') return terminal(a, 'action_approval.not_pending');
        if (a.requesterId === actor) return approvalError('action_approval.same_person', 'the requester cannot approve their own action');
        if (a.payloadHash !== i.expectedPayloadHash)
          return approvalError('action_approval.payload_mismatch', 'the approval is for a different payload than the one reviewed');
        a.status = 'APPROVED';
        a.approverId = actor;
        return ok(a);
      },
    },
    {
      method: 'POST',
      path: '/api/identity/trpc/actionApproval.reject',
      handle: ({ body, headers }) => {
        const actor = actorOf(headers);
        if (!actor) return unauthorized();
        const { approval: a, error } = live(inputOf(null, body, 'POST').approvalId);
        if (error) return error;
        if (a.status !== 'PENDING') return terminal(a, 'action_approval.not_pending');
        if (a.requesterId === actor)
          return approvalError('action_approval.same_person', 'the requester cannot reject as checker; revoke instead');
        a.status = 'REJECTED';
        a.approverId = actor;
        return ok(a);
      },
    },
    {
      method: 'POST',
      path: '/api/identity/trpc/actionApproval.revoke',
      handle: ({ body, headers }) => {
        const actor = actorOf(headers);
        if (!actor) return unauthorized();
        const { approval: a, error } = live(inputOf(null, body, 'POST').approvalId);
        if (error) return error;
        if (a.requesterId !== actor) return approvalError('action_approval.not_requester', 'only the requester can revoke');
        if (!['PENDING', 'APPROVED'].includes(a.status)) return terminal(a, 'action_approval.already_terminal');
        a.status = 'REVOKED';
        return ok(a);
      },
    },
  ];
}
