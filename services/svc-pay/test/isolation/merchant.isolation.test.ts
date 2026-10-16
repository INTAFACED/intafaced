/**
 * M — MERCHANT A CANNOT SEE MERCHANT B (W14, Isolation acceptance suites M1-M4, M6).
 *
 * Real routers, real Postgres, real ledger-shaped data for eight merchants (see
 * fixture.ts). Every merchant-scoped procedure is a row in `procedures.ts`; a new
 * one is one line and gets: the same-error-as-nonexistent probe (M1) as A's
 * session AND as A's `ifc_` key, a positive control (so a refusal is never a
 * broken fixture), and the no-side-effects check on B.
 *
 * "Same response as a non-existent id" is judged on what a caller can observe:
 * tRPC code + message (ids normalised) + cause code; REST status + error code +
 * message. Anything that differs is an existence oracle.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { ControlService } from '../../src/control/service.js';
import { teamAccessPorts } from '../../src/control/access.js';
import { createPayNamespaces } from '../../src/namespaces/index.js';
import {
  callRest,
  callTrpc,
  createWorld,
  ctxOf,
  keyOf,
  medianMs,
  sessionOf,
  shapeOf,
  snapshotMerchant,
  type Outcome,
  type World,
  type Tag,
} from './fixture.js';
import {
  DEFAULT_AREAS,
  LIST_PROCS,
  MERCHANT_PROCS,
  PARENT,
  REST_ROUTES,
  TREE_PROCS,
  ghostIds,
  idsOfEntity,
  keyCanCall,
  relationOf,
  type MerchantProc,
  type ProbeIds,
} from './procedures.js';

const FENCE_CODES = new Set(['pay.merchant_forbidden', 'pay.merchant_not_found', 'pay.payment_not_found', 'pay.settlement_not_found']);

/** The owner got past the isolation fence (data, or a business answer about their own row). */
function passedFence(o: Outcome): boolean {
  if (o.kind === 'ok') return true;
  return !(o.code === 'FORBIDDEN' || o.code === 'NOT_FOUND' || o.code === 'UNAUTHORIZED') && !FENCE_CODES.has(o.causeCode ?? '');
}

describe('M: merchant isolation', () => {
  let w: World;
  const ids = (t: Tag): ProbeIds => idsOfEntity(w.e[t]);

  beforeAll(async () => {
    w = await createWorld();
  }, 120_000);
  afterAll(async () => {
    await w?.stop();
  }, 60_000);

  const ctxFor = (kind: 'session' | 'key', tag: Tag): Context =>
    ctxOf(kind === 'session' ? sessionOf(w.e[tag].userId) : keyOf(w.e[tag].userId));

  // ────────────────────────────────────────────────────────────────────────
  // M2 first: list endpoints. Run before any mutation so counts are the seed.
  // ────────────────────────────────────────────────────────────────────────
  describe('M2: lists return only the caller’s rows (B’s data is seeded)', () => {
    for (const lp of LIST_PROCS) {
      for (const kind of ['session', 'key'] as const) {
        it(`${lp.name} as A's ${kind}`, async () => {
          const A = w.e.A;
          const ctx = ctxFor(kind, 'A');
          const o =
            lp.call.via === 'trpc'
              ? await callTrpc(w, ctx, lp.call.path, lp.call.input(A))
              : await callRest(w, ctx.principal, lp.call.req(A));
          expect(o.kind, JSON.stringify(o)).toBe('ok');
          const rows = lp.rows((o as { value: unknown }).value);
          const got = rows.map((r) => String(r.id));
          // exactly A's, none of anyone else's
          for (const other of ['B', 'P', 'C1', 'G1', 'C2', 'Q', 'D1'] as const) {
            const theirs = new Set(w.idsOf(other));
            expect(
              got.filter((id) => theirs.has(id)),
              `leaked ${other}'s rows`,
            ).toEqual([]);
          }
          for (const r of rows) if ('merchantId' in r) expect(r.merchantId).toBe(A.merchantId);
          if (lp.expectedIds) expect(new Set(got)).toEqual(new Set(lp.expectedIds(A)));
          else expect(got.length).toBeGreaterThan(0);
        });
      }
    }
    it('a merchant with rows in every table sees ONLY them: B’s own list is B’s, and is disjoint from A’s', async () => {
      const a = await callTrpc(w, ctxFor('session', 'A'), 'payment.list', { merchantId: w.e.A.merchantId, limit: 200 });
      const b = await callTrpc(w, ctxFor('session', 'B'), 'payment.list', { merchantId: w.e.B.merchantId, limit: 200 });
      const aIds = (a as { value: { items: Array<{ id: string }> } }).value.items.map((r) => r.id);
      const bIds = (b as { value: { items: Array<{ id: string }> } }).value.items.map((r) => r.id);
      expect(aIds.length).toBeGreaterThan(0);
      expect(bIds.length).toBeGreaterThan(0);
      expect(aIds.filter((x) => bIds.includes(x))).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // M3: PayFac trees. Reads only (plus an explicit grant/revoke round trip).
  // ────────────────────────────────────────────────────────────────────────
  describe('M3: PayFac parent / sub-merchant / other tree', () => {
    const TAGS: Tag[] = ['A', 'B', 'P', 'C1', 'G1', 'C2', 'Q', 'D1'];

    it('the tree under test is the tree that was seeded', async () => {
      const rows = await w.sql`SELECT id, parent_merchant_id FROM pay.merchants`;
      const parentOf = new Map(rows.map((r) => [r.id as string, r.parent_merchant_id as string | null]));
      for (const [child, parent] of Object.entries(PARENT)) {
        expect(parentOf.get(w.e[child as Tag].merchantId), child).toBe(w.e[parent as Tag].merchantId);
      }
      for (const t of ['A', 'B', 'P', 'Q'] as const) expect(parentOf.get(w.e[t].merchantId), t).toBeNull();
    });

    it('a parent lists exactly its own direct sub-merchants, and nothing from another tree', async () => {
      const listOf = async (actor: Tag, subject: Tag) => {
        const o = await callTrpc(w, ctxFor('session', actor), 'submerchant.list', { merchantId: w.e[subject].merchantId, limit: 50 });
        expect(o.kind, `${actor} lists ${subject}: ${JSON.stringify(o)}`).toBe('ok');
        return (o as { value: Array<{ id: string }> }).value.map((r) => r.id).sort();
      };
      expect(await listOf('P', 'P')).toEqual([w.e.C1.merchantId, w.e.C2.merchantId].sort());
      expect(await listOf('C1', 'C1')).toEqual([w.e.G1.merchantId]);
      expect(await listOf('Q', 'Q')).toEqual([w.e.D1.merchantId]);
      expect(await listOf('A', 'A')).toEqual([]);
    });

    for (const actor of TAGS) {
      for (const proc of TREE_PROCS) {
        it(`${actor} → ${proc.path}: reaches only self, own-tree descendants within granted areas`, async () => {
          const ctx = ctxFor('session', actor);
          const problems: string[] = [];
          for (const subject of TAGS) {
            const rel = relationOf(actor, subject);
            const real = await callTrpc(w, ctx, proc.path, proc.input(ids(subject)));
            const label = `${actor}→${subject} (${rel})`;
            if (rel === 'self' || rel === 'root-over') {
              if (real.kind !== 'ok') problems.push(`${label}: owner/root refused: ${JSON.stringify(shapeOf(real))}`);
            } else if (rel === 'intermediate-over') {
              const granted = (DEFAULT_AREAS as readonly string[]).includes(proc.area);
              if (granted && real.kind !== 'ok')
                problems.push(`${label}: default-granted area ${proc.area} refused: ${JSON.stringify(shapeOf(real))}`);
              if (!granted && !(real.kind === 'error' && real.code === 'FORBIDDEN'))
                problems.push(`${label}: area ${proc.area} not granted but got ${JSON.stringify(shapeOf(real))}`);
            } else if (real.kind === 'ok') {
              problems.push(`${label}: HIDDEN row was returned`);
            }
          }
          expect(problems).toEqual([]);
        });

        it(`${actor} → ${proc.path}: parent, siblings and other trees look exactly like a nonexistent id`, async () => {
          const ctx = ctxFor('session', actor);
          const problems: string[] = [];
          for (const subject of TAGS) {
            if (relationOf(actor, subject) !== 'hidden') continue;
            const real = await callTrpc(w, ctx, proc.path, proc.input(ids(subject)));
            const none = await callTrpc(w, ctx, proc.path, proc.input(ghostIds()));
            if (JSON.stringify(shapeOf(real)) !== JSON.stringify(shapeOf(none)))
              problems.push(`${actor}→${subject}: real=${JSON.stringify(shapeOf(real))} ghost=${JSON.stringify(shapeOf(none))}`);
          }
          expect(problems).toEqual([]);
        });
      }
    }

    it('a grant over a descendant opens exactly that area for exactly that grantee, and a revoke closes it', async () => {
      const C1 = w.e.C1;
      const G1 = w.e.G1;
      const read = (actor: Tag) => callTrpc(w, ctxFor('session', actor), 'payment.get', { paymentId: G1.paymentId });
      expect(await read('C1')).toMatchObject({ kind: 'error', code: 'FORBIDDEN', causeCode: 'pay.submerchant_permission_denied' });
      const change = {
        actorMerchantId: w.e.P.merchantId,
        granteeMerchantId: C1.merchantId,
        subjectMerchantId: G1.merchantId,
        area: 'payment',
        reason: 'w14 isolation drill',
        actorId: w.e.P.userId,
        actorScope: 'pay:write',
      };
      await w.subMerchants.grantPermission(change);
      try {
        expect((await read('C1')).kind).toBe('ok');
        // the grant is to C1 only: the sibling subtree and other tree gain nothing
        expect((await read('C2')).kind).toBe('error');
        expect((await read('D1')).kind).toBe('error');
        // and it did not widen anything else C1 holds over G1
        const settle = await callTrpc(w, ctxFor('session', 'C1'), 'settlement.get', { settlementId: G1.settlementId });
        expect(settle).toMatchObject({ kind: 'error', code: 'FORBIDDEN' });
      } finally {
        await w.subMerchants.revokePermission(change);
      }
      expect(await read('C1')).toMatchObject({ kind: 'error', code: 'FORBIDDEN', causeCode: 'pay.submerchant_permission_denied' });
    });

    it('the same three PayFac answers hold on the REST door (A-tree key vs B-tree resource)', async () => {
      const keyC1 = keyOf(w.e.C1.userId);
      const parent = await callRest(w, keyC1, { method: 'GET', url: `/v1/payments/${w.e.P.paymentId}` });
      const sibling = await callRest(w, keyC1, { method: 'GET', url: `/v1/payments/${w.e.C2.paymentId}` });
      const other = await callRest(w, keyC1, { method: 'GET', url: `/v1/payments/${w.e.D1.paymentId}` });
      const none = await callRest(w, keyC1, { method: 'GET', url: `/v1/payments/${ghostIds().paymentId}` });
      for (const [name, r] of Object.entries({ parent, sibling, other })) expect(r.kind, `${name} must be refused`).toBe('error');
      const oracles = Object.entries({ parent, sibling, other }).filter(
        ([, r]) => JSON.stringify(shapeOf(r)) !== JSON.stringify(shapeOf(none)),
      );
      expect(
        oracles.map(([name]) => name),
        'these differ from a nonexistent id',
      ).toEqual([]);
      const down = await callRest(w, keyOf(w.e.P.userId), { method: 'GET', url: `/v1/payments/${w.e.C1.paymentId}` });
      expect(down.kind).toBe('ok');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // M1: tRPC
  // ────────────────────────────────────────────────────────────────────────
  describe('M1 (tRPC): B’s ids look exactly like nonexistent ids', () => {
    let beforeB = '';
    let beforeQ = '';
    beforeAll(async () => {
      beforeB = await snapshotMerchant(w, w.e.B.merchantId);
      beforeQ = await snapshotMerchant(w, w.e.Q.merchantId);
    });

    const cases: Array<[MerchantProc, 'session' | 'key']> = [];
    for (const p of MERCHANT_PROCS) {
      cases.push([p, 'session']);
      if (keyCanCall(p)) cases.push([p, 'key']);
    }

    it.each(cases.map(([p, k]) => [`${p.path}${p.stub ? ' (stub)' : ''} as A's ${k}`, p, k] as const))(
      '%s: positive control',
      async (_name, proc, kind) => {
        const o = await callTrpc(w, ctxFor(kind, 'A'), proc.path, proc.input(ids('A')));
        if (proc.stub) {
          expect(o, 'stub procedure: remove `stub: true` from procedures.ts once it is built').toMatchObject({
            kind: 'error',
            code: 'NOT_IMPLEMENTED',
            causeCode: 'pay.not_built',
          });
          return;
        }
        expect(o.kind === 'error' && o.causeCode === 'pay.not_built', 'built now: remove `stub: true` from procedures.ts').toBe(false);
        if (proc.ownCause) {
          // Refused by design, for this exact reason: the owner reached the row. A foreign or missing id never gets this cause.
          expect(o, JSON.stringify(o)).toMatchObject({ kind: 'error', causeCode: proc.ownCause });
          return;
        }
        if (proc.own === 'ok') expect(o, JSON.stringify(o)).toMatchObject({ kind: 'ok' });
        else expect(passedFence(o), `owner blocked by the fence: ${JSON.stringify(shapeOf(o))}`).toBe(true);
      },
    );

    // Two separate questions, so a red run says which one broke:
    //   (1) is B's data refused?            -> isolation
    //   (2) is the refusal an existence oracle?  -> no-leak (M1's "same response as a non-existent id")
    it.each(cases.map(([p, k]) => [`${p.path}${p.stub ? ' (stub)' : ''} as A's ${k}`, p, k] as const))(
      '%s: B’s id is refused and returns no data',
      async (_name, proc, kind) => {
        const foreign = await callTrpc(w, ctxFor(kind, 'A'), proc.path, proc.input(ids('B')));
        expect(foreign.kind, 'B’s data must never be returned').toBe('error');
      },
    );

    it.each(cases.map(([p, k]) => [`${p.path}${p.stub ? ' (stub)' : ''} as A's ${k}`, p, k] as const))(
      '%s: B’s id gets the SAME error as a nonexistent id (no existence oracle)',
      async (_name, proc, kind) => {
        const ctx = ctxFor(kind, 'A');
        const foreign = await callTrpc(w, ctx, proc.path, proc.input(ids('B')));
        const none = await callTrpc(w, ctx, proc.path, proc.input(ghostIds()));
        expect(shapeOf(foreign)).toEqual(shapeOf(none));
      },
    );

    it.each(cases.filter(([p]) => p.mixed).map(([p, k]) => [`${p.path} as A's ${k}`, p, k] as const))(
      '%s: A’s merchant with B’s child resource id looks nonexistent',
      async (_name, proc, kind) => {
        const ctx = ctxFor(kind, 'A');
        const mixed = { ...ids('B'), merchantId: w.e.A.merchantId };
        const mixedGhost = { ...ghostIds(), merchantId: w.e.A.merchantId };
        const foreign = await callTrpc(w, ctx, proc.path, proc.input(mixed));
        const none = await callTrpc(w, ctx, proc.path, proc.input(mixedGhost));
        // Either both refuse identically, or both answer identically (e.g. `{deactivated:false}`): B's row must not change the answer.
        expect(shapeOf(foreign)).toEqual(shapeOf(none));
        expect(foreign).toEqual(none);
      },
    );

    it('an unauthenticated caller and a caller without the scope get no information either', async () => {
      const noScope = ctxOf(sessionOf(w.e.A.userId, { scopes: ['identity:read'] }));
      for (const proc of MERCHANT_PROCS.filter((p) => !p.stub)) {
        const real = await callTrpc(w, noScope, proc.path, proc.input(ids('B')));
        const none = await callTrpc(w, noScope, proc.path, proc.input(ghostIds()));
        expect(shapeOf(real), proc.path).toEqual(shapeOf(none));
        const anon = await callTrpc(w, ctxOf(null), proc.path, proc.input(ids('B')));
        expect(anon, proc.path).toMatchObject({ kind: 'error', code: 'UNAUTHORIZED' });
      }
    });

    it('timing class: B’s id and a nonexistent id take the same time (no fast-path oracle)', async () => {
      const ctx = ctxFor('session', 'A');
      for (const path of ['payment.get', 'merchant.balances', 'settlement.get']) {
        const proc = MERCHANT_PROCS.find((p) => p.path === path)!;
        const foreignMs = await medianMs(31, () => callTrpc(w, ctx, path, proc.input(ids('B'))));
        const ghostMs = await medianMs(31, () => callTrpc(w, ctx, path, proc.input(ghostIds())));
        const slack = Math.max(15, 2 * Math.min(foreignMs, ghostMs));
        expect(
          Math.abs(foreignMs - ghostMs),
          `${path}: foreign ${foreignMs.toFixed(1)}ms vs ghost ${ghostMs.toFixed(1)}ms`,
        ).toBeLessThanOrEqual(slack);
      }
    });

    it('NO SIDE EFFECTS: after every probe above, B’s and Q’s rows are byte-identical', async () => {
      expect(await snapshotMerchant(w, w.e.B.merchantId)).toBe(beforeB);
      expect(await snapshotMerchant(w, w.e.Q.merchantId)).toBe(beforeQ);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // M1: REST
  // ────────────────────────────────────────────────────────────────────────
  describe('M1 (REST): B’s ids look exactly like nonexistent ids', () => {
    const restCases: Array<[string, (typeof REST_ROUTES)[number], 'session' | 'key']> = [];
    for (const r of REST_ROUTES) {
      restCases.push([`${r.name} as A's key`, r, 'key']);
      restCases.push([`${r.name} as A's session`, r, 'session']);
    }
    const principalOf = (kind: 'session' | 'key') => (kind === 'session' ? sessionOf(w.e.A.userId) : keyOf(w.e.A.userId));

    it.each(restCases)('%s: positive control', async (_n, route, kind) => {
      const o = await callRest(w, principalOf(kind), route.req(ids('A')));
      if (route.own === 'ok') expect(o, JSON.stringify(o.json)).toMatchObject({ kind: 'ok' });
      else
        expect(
          o.kind === 'ok' || (o.httpStatus !== 401 && o.httpStatus !== 404 && o.code !== 'pay.merchant_forbidden'),
          `owner blocked: ${JSON.stringify(o.json)}`,
        ).toBe(true);
    });

    it.each(restCases)('%s: B’s id is refused and returns no data', async (_n, route, kind) => {
      const foreign = await callRest(w, principalOf(kind), route.req(ids('B')));
      expect(foreign.kind).toBe('error');
    });

    it.each(restCases)('%s: B’s id gets the SAME response as a nonexistent id (no existence oracle)', async (_n, route, kind) => {
      const p = principalOf(kind);
      const foreign = await callRest(w, p, route.req(ids('B')));
      const none = await callRest(w, p, route.req(ghostIds()));
      expect(shapeOf(foreign)).toEqual(shapeOf(none));
    });

    it.each(restCases.filter(([, r]) => r.mixed))(
      '%s: A’s merchant with B’s child resource id looks nonexistent',
      async (_n, route, kind) => {
        const p = principalOf(kind);
        const foreign = await callRest(w, p, route.req({ ...ids('B'), merchantId: w.e.A.merchantId }));
        const none = await callRest(w, p, route.req({ ...ghostIds(), merchantId: w.e.A.merchantId }));
        expect(shapeOf(foreign)).toEqual(shapeOf(none));
        expect(foreign.status).toBe(none.status);
        expect(foreign.json).toEqual(none.json);
      },
    );

    it('NO SIDE EFFECT through REST: B’s endpoint is still active after A tried to disable/enable it', async () => {
      const rows = await w.sql`SELECT status FROM pay.merchant_webhook_endpoints WHERE id = ${w.e.B.endpointId}`;
      expect(rows[0]!.status).toBe('active');
      const links = await w.sql`SELECT active FROM pay.payment_links WHERE id = ${w.e.B.linkId}`;
      expect(links[0]!.active).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // M4: maker-checker (merchantControl.approvals.*)
  // ────────────────────────────────────────────────────────────────────────
  describe('M4: maker-checker', () => {
    const FINANCE = randomUUID();
    /** The router the way index.ts builds it: the real team table decides who may see and approve (teamAccessPorts). */
    const withTeam = () =>
      createPayNamespaces({ founderAuthority: w.founderAuthority, control: new ControlService(w.sql, teamAccessPorts(w.sql)) });
    const joinAs = (merchantId: string, userId: string, role: string) =>
      w.sql`INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
            VALUES (${merchantId}, ${userId}, ${role}, 'active', ${userId}, now())`;
    const decideInput = (approvalId: string, hash: string) =>
      ({ approvalId, decision: 'approve', expectedPayloadHash: hash, reason: 'checked' }) as const;
    const rowOf = async (approvalId: string) =>
      (await w.sql`SELECT status, checker_user_id, founder_first_user_id FROM pay.control_payout_approvals WHERE id = ${approvalId}`)[0]!;
    const fail = async (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code: string; message: string; cause?: { code?: string } }) => ({ code: e.code, cause: e.cause?.code }),
      );
    const hashOf = async (approvalId: string) =>
      (await w.sql<Array<{ payload_hash: string }>>`SELECT payload_hash FROM pay.control_payout_approvals WHERE id = ${approvalId}`)[0]!
        .payload_hash;

    it('the seeded approvals are real: every merchant has one pending request made by its own owner', async () => {
      for (const t of ['A', 'B', 'P', 'Q'] as const) {
        const r = await w.sql<Array<{ status: string; maker_user_id: string; merchant_id: string }>>`
          SELECT status, maker_user_id, merchant_id FROM pay.control_payout_approvals WHERE id = ${w.e[t].approvalId}`;
        expect(r[0], t).toMatchObject({ maker_user_id: w.e[t].userId, merchant_id: w.e[t].merchantId });
      }
    });

    it('a maker cannot approve their own payout, on a session with MFA, and the approval does not move', async () => {
      // C2 is untouched by the M1 probes, so its approval is still pending.
      const C2 = w.e.C2;
      const before = await rowOf(C2.approvalId);
      expect(before.status).toBe('pending');
      const o = await callTrpc(
        w,
        ctxFor('session', 'C2'),
        'merchantControl.approvals.decide',
        decideInput(C2.approvalId, await hashOf(C2.approvalId)),
      );
      expect(o).toMatchObject({ kind: 'error', code: 'FORBIDDEN', causeCode: 'pay.approval_self_approval' });
      expect(await rowOf(C2.approvalId)).toEqual(before);
    });

    it('... even when the access rules would let the maker approve (the database also refuses a checker equal to the maker)', async () => {
      const C2 = w.e.C2;
      const router = withTeam(); // the owner holds payout.approve, so only the self-approval rule stands in the way
      const caller = router.createCaller(ctxOf(sessionOf(C2.userId)));
      const e = await fail(caller.merchantControl.approvals.decide(decideInput(C2.approvalId, await hashOf(C2.approvalId))));
      expect(e).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.approval_self_approval' });
      await expect(
        w.sql`UPDATE pay.control_payout_approvals SET checker_user_id = maker_user_id WHERE id = ${C2.approvalId}`,
      ).rejects.toMatchObject({ constraint_name: 'control_approvals_maker_not_checker' });
    });

    it('a member of merchant B cannot approve A’s payout and gets the answer a nonexistent approval gets', async () => {
      const A = w.e.A;
      const before = await rowOf(A.approvalId);
      const asB = ctxFor('session', 'B');
      const real = await callTrpc(w, asB, 'merchantControl.approvals.decide', decideInput(A.approvalId, await hashOf(A.approvalId)));
      const none = await callTrpc(
        w,
        asB,
        'merchantControl.approvals.decide',
        decideInput(ghostIds().approvalId, `sha256:${'a'.repeat(64)}`),
      );
      expect(real).toMatchObject({ kind: 'error', code: 'NOT_FOUND', causeCode: 'pay.approval_not_found' });
      expect(shapeOf(real)).toEqual(shapeOf(none));
      expect(await rowOf(A.approvalId)).toEqual(before);
    });

    it('... and cannot cancel it or list it either', async () => {
      const A = w.e.A;
      const before = await rowOf(A.approvalId);
      const asB = ctxFor('session', 'B');
      const cancel = await callTrpc(w, asB, 'merchantControl.approvals.cancel', { approvalId: A.approvalId, reason: 'not yours' });
      const none = await callTrpc(w, asB, 'merchantControl.approvals.cancel', { approvalId: ghostIds().approvalId, reason: 'not yours' });
      expect(shapeOf(cancel)).toEqual(shapeOf(none));
      expect(cancel).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
      const list = await callTrpc(w, asB, 'merchantControl.approvals.list', { merchantId: A.merchantId, limit: 10 });
      expect(list).toMatchObject({ kind: 'error', code: 'NOT_FOUND', causeCode: 'pay.merchant_not_found' });
      expect(await rowOf(A.approvalId)).toEqual(before);
    });

    it('an API key (no interactive session) cannot decide, whoever owns the approval', async () => {
      const key = ctxFor('key', 'C2');
      const real = await callTrpc(
        w,
        key,
        'merchantControl.approvals.decide',
        decideInput(w.e.C2.approvalId, await hashOf(w.e.C2.approvalId)),
      );
      const foreign = await callTrpc(
        w,
        key,
        'merchantControl.approvals.decide',
        decideInput(w.e.D1.approvalId, await hashOf(w.e.D1.approvalId)),
      );
      expect(real).toMatchObject({ kind: 'error', causeCode: 'pay.approval_mfa_required' });
      expect(shapeOf(foreign)).toEqual(shapeOf(real));
    });

    it('a REAL finance member of B (active row in the team table) reaches nothing of A through any merchantControl.* procedure', async () => {
      const asFinanceB = ctxOf(sessionOf(w.bFinanceUserId));
      const A = w.e.A;
      const beforeA = await rowOf(A.approvalId);
      const procs = MERCHANT_PROCS.filter((pr) => pr.path.startsWith('merchantControl.'));
      expect(procs.length).toBeGreaterThanOrEqual(7);
      for (const pr of procs) {
        const foreign = await callTrpc(w, asFinanceB, pr.path, pr.input(ids('A')));
        const none = await callTrpc(w, asFinanceB, pr.path, pr.input(ghostIds()));
        expect(foreign.kind, pr.path).toBe('error');
        expect(shapeOf(foreign), pr.path).toEqual(shapeOf(none));
      }
      expect(await rowOf(A.approvalId)).toEqual(beforeA);
      // POSITIVE: the same person does see and may use B's own control room, so the refusals are not a broken member row.
      const own = await callTrpc(w, asFinanceB, 'merchantControl.get', { merchantId: w.e.B.merchantId });
      expect(own.kind).toBe('ok');
      const list = await callTrpc(w, asFinanceB, 'merchantControl.approvals.list', { merchantId: w.e.B.merchantId, limit: 10 });
      expect(list.kind).toBe('ok');
    });

    it('POSITIVE CONTROL: a different person with the approver right for THAT merchant can approve, so the refusals above are not a broken fixture', async () => {
      const C2 = w.e.C2;
      await joinAs(C2.merchantId, FINANCE, 'finance');
      const router = withTeam();
      const asFinance = router.createCaller(ctxOf(sessionOf(FINANCE)));
      // The same person has no standing on another merchant: that approval looks missing.
      const other = await fail(asFinance.merchantControl.approvals.decide(decideInput(w.e.G1.approvalId, await hashOf(w.e.G1.approvalId))));
      expect(other).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.approval_not_found' });
      const ok = await asFinance.merchantControl.approvals.decide(decideInput(C2.approvalId, await hashOf(C2.approvalId)));
      expect(ok).toMatchObject({ approvalId: C2.approvalId, status: 'approved', checkerUserId: FINANCE, makerUserId: C2.userId });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // M6: webhooks and exports
  // ────────────────────────────────────────────────────────────────────────
  describe('M6: A’s webhooks and exports contain only A’s data', () => {
    const endpointsOf = async (merchantId: string) =>
      (await w.sql`SELECT id, url, signing_secret FROM pay.merchant_webhook_endpoints WHERE merchant_id = ${merchantId}`) as unknown as Array<{
        id: string;
        url: string;
        signing_secret: string;
      }>;

    it('an event for A is queued for A’s endpoints only, and delivered only to A’s URLs, signed with A’s secret', async () => {
      const A = w.e.A;
      const B = w.e.B;
      const aEndpoints = await endpointsOf(A.merchantId);
      const bEndpoints = await endpointsOf(B.merchantId);
      const payment = await w.pay.getPayment(A.paymentId2);
      await w.webhooks.enqueue({ type: 'payment.failed', payment });
      const queued =
        await w.sql`SELECT endpoint_id, merchant_id FROM pay.merchant_webhook_deliveries WHERE event_id = ${`payment.failed:${A.paymentId2}`}`;
      expect(queued.length).toBe(aEndpoints.length);
      for (const q of queued) {
        expect(aEndpoints.map((e) => e.id)).toContain(q.endpoint_id);
        expect(q.merchant_id).toBe(A.merchantId);
      }
      w.outbound.length = 0;
      await w.webhooks.processDue(200);
      const sent = w.outbound.filter((o) => JSON.parse(o.body).id === `payment.failed:${A.paymentId2}`);
      expect(sent.length).toBe(aEndpoints.length);
      for (const o of sent) {
        expect(
          aEndpoints.map((e) => e.url),
          `delivered to ${o.url}, which is not one of A's endpoints`,
        ).toContain(o.url);
        expect(bEndpoints.map((e) => e.url)).not.toContain(o.url);
        const body = JSON.parse(o.body) as { data: { payment: { merchantId: string } } };
        expect(body.data.payment.merchantId).toBe(A.merchantId);
        for (const id of w.idsOf('B')) expect(o.body).not.toContain(id);
        const ts = o.headers['x-intafaced-timestamp']!;
        const sign = (secret: string) => createHmac('sha256', secret).update(`${ts}.${o.body}`).digest('hex');
        expect(
          aEndpoints.map((e) => sign(e.signing_secret)),
          'signed with a secret that is not one of A’s',
        ).toContain(o.headers['x-intafaced-signature']);
        for (const b of bEndpoints) expect(o.headers['x-intafaced-signature']).not.toBe(sign(b.signing_secret));
      }
    });

    it('and the mirror image: an event for B never reaches A’s endpoints', async () => {
      const B = w.e.B;
      const aUrls = (await endpointsOf(w.e.A.merchantId)).map((e) => e.url);
      await w.webhooks.enqueue({ type: 'payment.failed', payment: await w.pay.getPayment(B.paymentId2) });
      w.outbound.length = 0;
      await w.webhooks.processDue(200);
      const sent = w.outbound.filter((o) => JSON.parse(o.body).id === `payment.failed:${B.paymentId2}`);
      expect(sent.length).toBeGreaterThan(0);
      for (const o of sent) {
        expect(aUrls).not.toContain(o.url);
        for (const id of w.idsOf('A')) expect(o.body).not.toContain(id);
      }
    });

    it('the delivery dashboard (REST) shows A only A’s deliveries, never B’s, however it is filtered', async () => {
      const bDeliveries = new Set(
        (await w.sql`SELECT id FROM pay.merchant_webhook_deliveries WHERE merchant_id = ${w.e.B.merchantId}`).map((r) => r.id as string),
      );
      expect(bDeliveries.size).toBeGreaterThan(0);
      for (const status of ['', '&status=delivered', '&status=failed', '&status=dead', '&status=pending']) {
        const o = await callRest(w, keyOf(w.e.A.userId), {
          method: 'GET',
          url: `/v1/webhook-deliveries?merchantId=${w.e.A.merchantId}&limit=200${status}`,
        });
        expect(o.kind).toBe('ok');
        const rows = (o as { value: Array<{ id: string; merchantId: string; endpointId: string }> }).value;
        for (const r of rows) {
          expect(r.merchantId).toBe(w.e.A.merchantId);
          expect(bDeliveries.has(r.id)).toBe(false);
          expect(r.endpointId).not.toBe(w.e.B.endpointId);
        }
      }
    });

    it('a secret is never returned by a list, only once on create', async () => {
      const list = await callRest(w, keyOf(w.e.A.userId), {
        method: 'GET',
        url: `/v1/webhook-endpoints?merchantId=${w.e.A.merchantId}&limit=50`,
      });
      const text = JSON.stringify((list as { value: unknown }).value);
      for (const e of [...(await endpointsOf(w.e.A.merchantId)), ...(await endpointsOf(w.e.B.merchantId))]) {
        expect(text).not.toContain(e.signing_secret);
        expect(text).not.toContain(createHash('sha256').update(e.signing_secret).digest('hex'));
      }
    });
  });

  describe('merchant.myAccess lists memberships, never a merchant row the caller is not on', () => {
    it('A sees only the merchant it owns; an invited row on that user is not a membership', async () => {
      const o = await callTrpc(w, ctxFor('session', 'A'), 'merchant.myAccess', {});
      expect(o.kind).toBe('ok');
      if (o.kind !== 'ok') return;
      const memberships = (o.value as { memberships: Array<{ merchantId: string; role: string }> }).memberships;
      expect(memberships.map((m) => m.merchantId)).toEqual([w.e.A.merchantId]);
      expect(memberships[0]?.role).toBe('owner');
    });

    it('B’s finance member sees only B, as finance', async () => {
      const o = await callTrpc(w, ctxOf(sessionOf(w.bFinanceUserId)), 'merchant.myAccess', {});
      expect(o.kind).toBe('ok');
      if (o.kind !== 'ok') return;
      const memberships = (o.value as { memberships: Array<{ merchantId: string; role: string }> }).memberships;
      expect(memberships.map((m) => ({ merchantId: m.merchantId, role: m.role }))).toEqual([
        { merchantId: w.e.B.merchantId, role: 'finance' },
      ]);
    });
  });
});
