// TEST DATA ONLY. Nothing here is a real merchant, person, address, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, hex, iso, ok, page, refuse } from '../../mock/shared.mjs';

const CHILD_A = hex('c1', 1);
const CHILD_B = hex('c2', 2);
const REQ_PENDING = hex('d1', 1);

/** The account pages' stand-in: business details, setup progress, activity, team filters and a small platform network. */
export function createAccountMock(ctx) {
  const { scenario, now, state } = ctx;
  const quiet = scenario === 'quiet';
  state.profile = {
    merchantId: MERCHANT_ID,
    version: '3',
    displayName: 'TEST Shop',
    legalName: 'TEST Shop Ltd',
    address: { line1: '1 Test Street', line2: null, city: 'Testville', region: null, postalCode: 'T3ST 1NG', country: 'GB' },
    website: 'https://shop.test',
    supportEmail: 'help@shop.test',
    supportPhone: null,
    statementDescriptor: 'TEST SHOP',
    industry: 'Online retail',
    secondApprovalEnabled: false,
  };
  const emptySide = {
    displayName: null,
    legalName: null,
    address: null,
    website: null,
    supportEmail: null,
    supportPhone: null,
    statementDescriptor: null,
    industry: null,
  };
  state.profileHistory = [
    {
      requestId: REQ_PENDING,
      seq: '3',
      status: 'pending',
      before: { statementDescriptor: 'TEST SHOP' },
      after: { statementDescriptor: 'TEST SHOP UK' },
      sensitiveKeys: ['statementDescriptor'],
      changeHash: 'sha256:' + 'ab'.repeat(32),
      makerId: 'TEST-user-finance',
      checkerId: null,
      secondApproverId: null,
      reason: 'Match our new trading name',
      checkerReason: null,
      createdAt: iso(now - 2 * 3600_000),
      decidedAt: null,
    },
    {
      requestId: hex('d1', 2),
      seq: '2',
      status: 'applied',
      before: { website: null },
      after: { website: 'https://shop.test' },
      sensitiveKeys: [],
      changeHash: 'sha256:' + 'cd'.repeat(32),
      makerId: USER_ID,
      checkerId: null,
      secondApproverId: null,
      reason: 'Add our website',
      checkerReason: null,
      createdAt: iso(now - 20 * DAY),
      decidedAt: iso(now - 20 * DAY),
    },
    {
      requestId: hex('d1', 3),
      seq: '1',
      status: 'applied_pre_kyb',
      before: emptySide,
      after: { legalName: 'TEST Shop Ltd' },
      sensitiveKeys: ['legalName'],
      changeHash: 'sha256:' + 'ef'.repeat(32),
      makerId: USER_ID,
      checkerId: null,
      secondApproverId: null,
      reason: 'First setup',
      checkerReason: null,
      createdAt: iso(now - 90 * DAY),
      decidedAt: iso(now - 90 * DAY),
    },
  ].map((row) => (quiet ? { ...row, status: row.status === 'pending' ? 'applied' : row.status } : row));
  const children = [
    {
      id: CHILD_A,
      userId: 'TEST-child-a',
      parentMerchantId: MERCHANT_ID,
      mode: 'payfac',
      status: 'active',
      kybStatus: 'approved',
      settlingParty: 'self',
      feeBps: 150,
      depth: 1,
      createdAt: iso(now - 60 * DAY),
    },
    {
      id: CHILD_B,
      userId: 'TEST-child-b',
      parentMerchantId: MERCHANT_ID,
      mode: 'payfac',
      status: 'pending',
      kybStatus: 'none',
      settlingParty: 'self',
      feeBps: null,
      depth: 1,
      createdAt: iso(now - 3 * DAY),
    },
  ];
  state.children = children;
  state.grants = [
    {
      granteeMerchantId: CHILD_B,
      subjectMerchantId: CHILD_A,
      area: 'payment',
      reason: 'TEST: lets B see A payments',
      actorId: USER_ID,
      actorMerchantId: MERCHANT_ID,
      grantedAt: iso(now - 10 * DAY),
    },
  ];
  state.permEvents = [
    {
      id: hex('e1', 1),
      seq: '1',
      granteeMerchantId: CHILD_B,
      subjectMerchantId: CHILD_A,
      area: 'payment',
      action: 'grant',
      reason: 'TEST: lets B see A payments',
      actorId: USER_ID,
      actorMerchantId: MERCHANT_ID,
      actorScope: 'pay:write',
      createdAt: iso(now - 10 * DAY),
    },
  ];
  /**
   * The account's activity feed, newest first, drawn from the same records the other pages show: payments and disputes
   * from the world, team and verification changes from the team and compliance pages, exports, payout requests and
   * webhook deliveries from theirs. Read when asked, so a change made on another page shows up here.
   */
  const activityRows = () => {
    const w = ctx.world;
    const rows = [];
    const add = (at, actorId, action, objectType, objectId, detail = {}) =>
      rows.push({
        id: `act-${rows.length + 1}`,
        occurredAt: typeof at === 'number' ? iso(at) : at,
        actorId,
        action,
        objectType,
        objectId,
        detail,
      });
    for (const p of w.payments.filter((x) => ['captured', 'settled', 'refunded'].includes(x.status)).slice(0, 4))
      // five minutes after the payment began: the very moment its own history records the money being taken
      add(Date.parse(p.createdAt) + 5 * 60_000, 'system', 'captured', 'payment', p.id, { amount: p.amount, asset: p.assetId });
    for (const r of w.refunds.filter((x) => x.status !== 'reversed'))
      add(r.createdAt, USER_ID, 'refunded', 'payment', r.paymentId, { amount: r.amount, asset: r.assetId });
    for (const d of w.disputes) {
      add(d.openedAt, 'system', 'opened', 'dispute', d.disputeId, { amount: d.amount, asset: d.assetId, status: 'open' });
      if (d.contestedAt) add(d.contestedAt, USER_ID, 'responded', 'dispute', d.disputeId, { status: 'contested' });
    }
    for (const e of state.teamHistory ?? []) add(e.createdAt, e.actorId, e.action, 'team', e.memberUserId, { role: e.toRole ?? undefined });
    for (const e of state.kybHistory ?? [])
      add(e.at, e.decidedBy === 'merchant' ? USER_ID : e.decidedBy, e.toStatus, 'kyb', e.kybRef ?? 'kyb', {
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
      });
    for (const e of state.reportJobs ?? [])
      add(e.completedAt ?? e.createdAt, e.requestedBy, `export_${e.status === 'failed' ? 'failed' : 'ready'}`, 'export', e.jobId, {
        status: e.status,
      });
    // The real feed has one row per approval, from its current status, at the time it was asked for (svc-pay activity.ts):
    // no row per approve or send, and no destination rows (destinations are not a feed object type). The stand-in keeps to that.
    for (const a of state.approvals ?? [])
      add(a.createdAt, a.makerUserId, `payout_${a.status === 'pending' ? 'pending' : a.status}`, 'approval', a.approvalId, {
        status: a.status,
        amount: a.amount,
        asset: a.assetCode,
        destinationKind: a.destinationKind,
        destinationMasked: a.destinationMasked,
      });
    for (const d of (state.dev?.deliveries ?? []).filter((x) => x.status === 'failed' || x.status === 'dead').slice(0, 2))
      add(d.createdAt, 'system', 'delivery_failed', 'webhook', d.endpointId, {
        status: d.status,
        eventType: d.eventType,
        attempts: String(d.attempts),
      });
    return rows
      .sort((x, y) => y.occurredAt.localeCompare(x.occurredAt))
      .map((r, i) => ({ ...r, id: `act-${String(i + 1).padStart(3, '0')}` }));
  };

  /**
   * The child a request names. The Network board opens `/pay/network/TEST-child`, which stands for the first child, so the
   * page shows a business instead of an error. Any other id is either a business that is not in this network, or, for an
   * account that is not a platform at all, a read this account has no network for.
   */
  const childFor = (id) => state.children.find((c) => c.id === (id === 'TEST-child' ? CHILD_A : id));
  const noChild = (route) =>
    ctx.myAccess === 'payfac' ? refuse(route, 403, 'pay.submerchant_out_of_scope') : refuse(route, 403, 'pay.submerchant_not_onboarded');
  return {
    async handle(procedure, input, route) {
      const gone = scenario === 'new';
      switch (procedure) {
        case 'merchant.onboarding.progress':
          if (gone) return refuse(route, 404, 'pay.merchant_not_found');
          return ok(route, {
            merchantId: MERCHANT_ID,
            business: { done: true, missing: [] },
            documents: { state: 'pending_vendor' },
            terms: state.terms ?? { state: 'not_configured' },
            destination: {
              // As svc-pay's onboarding.ts: only a destination verified with a step-up counts (held or active), never an
              // unverified one (J-merchant-02 #5).
              present: Boolean(state.destination?.verified) || !quiet,
              // the same destinations the Destinations page lists: one list, one set of ids
              destinations:
                state.destination || !quiet
                  ? ctx.world.destinations.map((d) => ({ railId: d.railId, kind: d.kind, destinationMasked: d.destinationMasked }))
                  : [],
            },
            kybStatus: state.kyb?.kybStatus ?? 'approved',
            merchantStatus: 'active',
            blocking: [
              'documents_pending_vendor',
              ...(state.terms?.state === 'accepted' ? [] : [state.terms ? 'terms_not_accepted' : 'terms_not_configured']),
            ],
          });
        case 'merchant.terms.accept':
          // Like the service: nothing to accept until a version is published (a test sets state.terms), and only the version shown.
          if (gone) return refuse(route, 404, 'pay.merchant_not_found');
          if (!state.terms || state.terms.state === 'not_configured') return refuse(route, 412, 'pay.merchant_terms_unset');
          if (input.version !== state.terms.version) return refuse(route, 409, 'pay.merchant_terms_version_stale');
          if (state.terms.state !== 'accepted') state.terms = { ...state.terms, state: 'accepted', acceptedAt: iso(now) };
          return ok(route, { merchantId: MERCHANT_ID, version: state.terms.version, acceptedAt: state.terms.acceptedAt });
        case 'merchant.businessProfile.get':
          if (gone) return refuse(route, 404, 'pay.merchant_not_found');
          return ok(route, state.profile);
        case 'merchant.businessProfile.history':
          if (gone) return refuse(route, 404, 'pay.merchant_not_found');
          return ok(route, page(state.profileHistory, input));
        case 'merchant.businessProfile.submit': {
          if (input.expectedVersion !== state.profile.version) return refuse(route, 409, 'pay.profile_version_conflict');
          const { merchantId: _m, expectedVersion: _v, reason, ...patch } = input;
          const sensitive = ['legalName', 'address', 'statementDescriptor', 'industry'].filter((k) => k in patch);
          const before = Object.fromEntries(Object.keys(patch).map((k) => [k, state.profile[k]]));
          const outcome = sensitive.length ? 'pending_review' : 'applied';
          if (!sensitive.length) Object.assign(state.profile, patch);
          state.profile.version = String(Number(state.profile.version) + 1);
          const requestId = hex('d9', state.profileHistory.length + 1);
          state.profileHistory.unshift({
            requestId,
            seq: String(state.profileHistory.length + 1),
            status: outcome === 'applied' ? 'applied' : 'pending_review',
            before,
            after: patch,
            sensitiveKeys: sensitive,
            changeHash: 'sha256:' + '12'.repeat(32),
            makerId: USER_ID,
            checkerId: null,
            secondApproverId: null,
            reason,
            checkerReason: null,
            createdAt: iso(Date.now()),
            decidedAt: outcome === 'applied' ? iso(Date.now()) : null,
          });
          return ok(route, {
            requestId,
            outcome,
            version: state.profile.version,
            changeHash: sensitive.length ? 'sha256:' + '12'.repeat(32) : null,
            profile: state.profile,
          });
        }
        case 'merchant.businessProfile.confirm': {
          const row = state.profileHistory.find((r) => r.requestId === input.requestId);
          if (!row || row.status !== 'pending') return refuse(route, 409, 'pay.profile_change_not_pending');
          row.status = input.decision === 'confirm' ? 'pending_review' : 'rejected';
          return ok(route, {
            requestId: row.requestId,
            outcome: input.decision === 'confirm' ? 'pending_review' : 'rejected',
            version: state.profile.version,
            profile: state.profile,
          });
        }
        case 'merchant.businessProfile.setSecondApproval':
          state.profile = { ...state.profile, secondApprovalEnabled: input.enabled };
          return ok(route, { merchantId: MERCHANT_ID, enabled: input.enabled });
        case 'merchantOps.team.list': {
          const needle = (input.search ?? '').toLowerCase();
          const rows = state.members.filter(
            (m) =>
              (!input.status || m.status === input.status) &&
              (!input.role || m.role === input.role) &&
              (!needle || `${m.label ?? ''}`.toLowerCase().includes(needle)),
          );
          return ok(route, page(rows, input));
        }
        case 'merchantOps.activity.list': {
          const needle = input.search;
          const rows = activityRows().filter(
            (r) =>
              (!input.objectType || r.objectType === input.objectType) &&
              (!input.actorId || r.actorId === input.actorId) &&
              (!input.from || r.occurredAt >= input.from) &&
              (!input.to || r.occurredAt < input.to) &&
              (!needle || r.objectId === needle),
          );
          return ok(route, page(quiet ? [] : rows, input));
        }
        case 'submerchant.list':
          return ok(route, state.children);
        case 'submerchant.get': {
          const row = childFor(input.merchantId);
          return row ? ok(route, row) : noChild(route);
        }
        case 'submerchant.summary': {
          const row = childFor(input.merchantId);
          if (!row) return noChild(route);
          return ok(route, {
            ...row,
            displayName: row.id === CHILD_A ? 'TEST Child Alpha' : null,
            legalName: row.id === CHILD_A ? 'TEST Child Alpha Ltd' : null,
            volume: {
              window: { kind: 'preset', preset: 'rolling_30d' },
              items: row.id === CHILD_A ? [{ assetCode: 'USDT', volume: '2480.5', count: 31 }] : [],
            },
            recentPayments: {
              items:
                row.id === CHILD_A
                  ? [{ id: hex('f1', 1), status: 'captured', amount: '75', assetId: 'USDT', createdAt: iso(now - 3600_000) }]
                  : [],
              nextCursor: null,
            },
            grants: {
              items: state.grants
                .filter((g) => g.subjectMerchantId === row.id)
                .map((g) => ({ area: g.area, granteeMerchantId: g.granteeMerchantId })),
            },
          });
        }
        case 'submerchant.create': {
          const row = {
            id: hex('c3', state.children.length + 1),
            userId: input.userId,
            parentMerchantId: input.parentMerchantId,
            mode: 'payfac',
            status: 'pending',
            kybStatus: 'none',
            settlingParty: 'self',
            feeBps: input.pricing.feeBps,
            depth: 1,
            createdAt: iso(Date.now()),
          };
          state.children.push(row);
          return ok(route, row);
        }
        case 'submerchantPermission.areas':
          return ok(route, ['merchant.profile', 'payment', 'payment.refund', 'settlement']);
        case 'submerchantPermission.list':
          return ok(
            route,
            state.grants.filter((g) => g.subjectMerchantId === (childFor(input.subjectMerchantId)?.id ?? input.subjectMerchantId)),
          );
        case 'submerchantPermission.history':
          return ok(
            route,
            state.permEvents.filter((g) => g.subjectMerchantId === (childFor(input.subjectMerchantId)?.id ?? input.subjectMerchantId)),
          );
        case 'submerchantPermission.grant':
        case 'submerchantPermission.revoke': {
          const grant = procedure.endsWith('grant');
          const event = {
            id: hex('e1', state.permEvents.length + 1),
            seq: String(state.permEvents.length + 1),
            ...input,
            action: grant ? 'grant' : 'revoke',
            actorId: USER_ID,
            actorMerchantId: MERCHANT_ID,
            actorScope: 'pay:write',
            createdAt: iso(Date.now()),
          };
          state.permEvents.unshift(event);
          if (grant)
            state.grants.push({
              granteeMerchantId: input.granteeMerchantId,
              subjectMerchantId: input.subjectMerchantId,
              area: input.area,
              reason: input.reason,
              actorId: USER_ID,
              actorMerchantId: MERCHANT_ID,
              grantedAt: event.createdAt,
            });
          else
            state.grants = state.grants.filter(
              (g) =>
                !(
                  g.granteeMerchantId === input.granteeMerchantId &&
                  g.subjectMerchantId === input.subjectMerchantId &&
                  g.area === input.area
                ),
            );
          return ok(route, event);
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
