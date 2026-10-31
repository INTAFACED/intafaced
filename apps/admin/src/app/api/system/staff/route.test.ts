import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { staffAccessSchema, staffGetSchema, staffListSchema, staffRolesListSchema } from '@intafaced/contracts/identity-staff';
import { confirmPhrase, type DeskRequest } from '@/lib/desk/approval-packet';
import { staffPayloadHash } from '@/lib/desk/approval-hash';
import {
  T_FOUNDER,
  T_ROLE_ID,
  T_STAFF_ID,
  noProcedure,
  tAccess,
  tGet,
  tList,
  tRoles,
  tStaff,
  trpcForbidden,
  trpcOk,
} from '@/testing/staff-fixtures';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const ctx = {
  session: {
    userId: T_FOUNDER,
    accessToken: 'TEST-founder-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const EDGE = 'http://edge:4000/api/identity/trpc/';
const get = (query: string) => GET(new Request(`http://admin.example/api/system/staff${query}`));
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/system/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const procedureOf = (url: string) => url.slice(EDGE.length).split('?')[0]!;

/** Answers by procedure; anything not listed is an unknown procedure, as identity without step 2 answers. */
function identity(answers: Record<string, () => Response>) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    const name = procedureOf(url);
    return answers[name]?.() ?? noProcedure(name);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const disable: DeskRequest = {
  kind: 'identity.staff.disable',
  staffId: T_STAFF_ID,
  reason: 'TEST left the company',
  version: '4',
};
const APPROVAL = 'appr_TEST_1';
const OPERATION = 'op_TEST_1';

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('reads go through the edge to svc-identity and are parsed with the contract', () => {
  it('the roster reads staff.list, roles.list and the enrolment door as the founder', async () => {
    const fn = identity({
      'staff.list': () => trpcOk(tList()),
      'roles.list': () => trpcOk(tRoles()),
      'auth.founderEnrolmentStatus': () => trpcOk({ open: false }),
    });
    const json = await (await get('?view=roster')).json();
    expect(json.roster).toEqual({ kind: 'ok', data: staffListSchema.parse(tList()) });
    expect(json.roles).toEqual({ kind: 'ok', data: staffRolesListSchema.parse(tRoles()) });
    expect(json.enrolment).toEqual({ kind: 'ok', data: { open: false } });
    const urls = fn.mock.calls.map(([u]) => u);
    expect(urls).toContain(`${EDGE}staff.list?input=${encodeURIComponent('{"limit":100}')}`);
    // roles.list takes a strict empty object, so it is sent rather than left out.
    expect(urls).toContain(`${EDGE}roles.list?input=${encodeURIComponent('{}')}`);
    for (const [, init] of fn.mock.calls) expect((init!.headers as Record<string, string>).authorization).toBe('Bearer TEST-founder-token');
  });

  it('one staff member reads staff.get, staff.access and roles.list by staff id', async () => {
    const fn = identity({
      'staff.get': () => trpcOk(tGet()),
      'staff.access': () => trpcOk(tAccess()),
      'roles.list': () => trpcOk(tRoles()),
    });
    const json = await (await get(`?view=member&staffId=${T_STAFF_ID}`)).json();
    expect(json.record).toEqual({ kind: 'ok', data: staffGetSchema.parse(tGet()) });
    expect(json.access).toEqual({ kind: 'ok', data: staffAccessSchema.parse(tAccess()) });
    expect(fn.mock.calls.map(([u]) => u)).toContain(`${EDGE}staff.get?input=${encodeURIComponent(`{"staffId":"${T_STAFF_ID}"}`)}`);
  });

  it('an unknown procedure says plainly that svc-identity has no staff roster yet, and invents nothing', async () => {
    identity({ 'auth.founderEnrolmentStatus': () => trpcOk({ open: true }) });
    const json = await (await get('?view=roster')).json();
    for (const part of [json.roster, json.roles]) {
      expect(part.kind).toBe('failed');
      expect(part.notBuilt).toBe(true);
      expect(part.code).toBe('admin.staff_roster_not_built');
      expect(part.message).toContain('svc-identity has no staff roster yet (OPS-admin-access-03 step 2)');
      expect(part).not.toHaveProperty('data');
    }
    expect(json.enrolment).toEqual({ kind: 'ok', data: { open: true } });
  });

  it('a row that is not exactly the contract fails the whole read, never a shorter list', async () => {
    identity({
      'staff.list': () => trpcOk(tList([tStaff(), { ...tStaff({ staffId: 'stf_2' }), password: 'x' }])),
      'roles.list': () => trpcOk({ roles: [{ ...tRoles().roles[0], state: 'defined' }], asOf: 'x' }),
    });
    const json = await (await get('?view=roster')).json();
    expect(json.roster).toMatchObject({ kind: 'failed', message: expect.stringContaining('svc-identity answered in a shape') });
    expect(json.roles.kind).toBe('failed');
  });

  it('a non-founder session is refused with the console’s words for operator.denied and mfa.required', async () => {
    identity({ 'roles.list': () => trpcForbidden('operator.denied') });
    let json = await (await get('?view=roles')).json();
    expect(json.roles).toMatchObject({ kind: 'failed', forbidden: true, code: 'operator.denied' });
    expect(json.roles.message).toContain('Not allowed');
    identity({ 'roles.list': () => trpcForbidden('mfa.required') });
    json = await (await get('?view=roles')).json();
    expect(json.roles).toMatchObject({ kind: 'failed', forbidden: true, code: 'mfa.required' });
    expect(json.roles.message).toContain('second factor');
  });

  it('a service that does not answer is an error naming svc-identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const json = await (await get('?view=roles')).json();
    expect(json.roles).toMatchObject({ kind: 'failed', message: 'svc-identity did not answer.', notBuilt: false });
  });

  it('a malformed view, staff id or cursor is refused before any call', async () => {
    const fn = identity({});
    expect((await get('?view=everything')).status).toBe(400);
    expect((await get('?view=member&staffId=has%20space')).status).toBe(400);
    expect((await get('?view=roster&cursor=')).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('privileged changes run the two-founder desk and refuse honestly while identity has no roster', () => {
  it('a propose is refused before any approval is made when svc-identity does not serve the roster', async () => {
    const fn = identity({});
    const res = await post({ step: 'propose', request: disable, confirm: confirmPhrase(disable) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, step: 'propose', refusal: { code: 'admin.staff_roster_not_built', changed: 'no' } });
    expect(json.refusal.body).toContain('No approval was spent');
    const names = fn.mock.calls.map(([u]) => procedureOf(u));
    expect(names).toEqual(['roles.list']);
    expect(names).not.toContain('actionApproval.propose');
  });

  it('a propose goes to identity’s approval desk with the staff action type, target and hash once the roster answers', async () => {
    const fn = identity({
      'roles.list': () => trpcOk(tRoles()),
      'actionApproval.propose': () => Response.json({ error: { message: 'TEST stop [action_approval.policy_unset]' } }, { status: 412 }),
    });
    const json = await (await post({ step: 'propose', request: disable, confirm: confirmPhrase(disable) })).json();
    expect(json.refusal.code).toBe('action_approval.policy_unset');
    const call = fn.mock.calls.find(([u]) => procedureOf(u) === 'actionApproval.propose')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({
      actionType: 'identity.staff.disable',
      targetService: 'svc-identity',
      targetId: `staff:${T_STAFF_ID}`,
      expectedVersion: '4',
      payloadHash: staffPayloadHash(disable as Extract<DeskRequest, { kind: 'identity.staff.disable' }>),
      policyVersion: 'v1',
    });
  });

  it('a run against an identity without the procedure is refused, with nothing changed and no approval spent', async () => {
    identity({});
    const res = await post({
      step: 'execute',
      request: disable,
      confirm: confirmPhrase(disable),
      approvalId: APPROVAL,
      operationId: OPERATION,
    });
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, step: 'execute', refusal: { code: 'admin.staff_roster_not_built', changed: 'no' } });
  });

  it('a run sends the business key and the approval, and a second run after a lost reply sends the same key', async () => {
    const bodies: Record<string, unknown>[] = [];
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(procedureOf(url)).toBe('staff.disable');
        bodies.push(JSON.parse(String(init!.body)));
        if (first) {
          first = false;
          throw new Error('socket hang up');
        }
        return trpcOk({
          auditId: 'aud_TEST',
          requestId: `console:identity.staff.disable:${APPROVAL}`,
          action: 'identity.staff.disable',
          actorId: T_FOUNDER,
          occurredAt: '2026-10-31T05:01:00.000Z',
          outcome: 'replayed',
          approverId: '22222222-2222-4222-8222-222222222222',
          staff: tStaff({ status: 'disabled', disabledAt: '2026-10-31T05:00:30.000Z', version: '5' }),
          role: null,
        });
      }),
    );
    const step = { step: 'execute', request: disable, confirm: confirmPhrase(disable), approvalId: APPROVAL, operationId: OPERATION };
    const lost = await (await post(step)).json();
    expect(lost.refusal.changed).toBe('unknown');
    const again = await (await post(step)).json();
    expect(again).toMatchObject({ ok: true, step: 'execute' });
    expect(again.detail).toContain('changed nothing again');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual({
      requestId: `console:identity.staff.disable:${APPROVAL}`,
      staffId: T_STAFF_ID,
      reason: 'TEST left the company',
      expectedVersion: '4',
      approval: {
        approvalId: APPROVAL,
        payloadHash: staffPayloadHash(disable as Extract<DeskRequest, { kind: 'identity.staff.disable' }>),
      },
    });
  });

  it('a typed refusal from identity is explained with what it names; a reply for another request is not a success', async () => {
    const result = (over: Record<string, unknown>) => ({
      auditId: 'aud_TEST',
      requestId: `console:identity.roles.assign:${APPROVAL}`,
      action: 'identity.roles.assign',
      actorId: T_FOUNDER,
      occurredAt: '2026-10-31T05:01:00.000Z',
      ...over,
    });
    const assign: DeskRequest = { kind: 'identity.roles.assign', staffId: T_STAFF_ID, roleId: T_ROLE_ID, version: '4' };
    const run = () =>
      post({ step: 'execute', request: assign, confirm: confirmPhrase(assign), approvalId: APPROVAL, operationId: OPERATION });

    identity({
      'roles.assign': () =>
        trpcOk(result({ outcome: 'refused', code: 'identity.role_grant_exceeds_holder', detail: ['staff:ledger:write:production'] })),
    });
    let json = await (await run()).json();
    expect(json.refusal).toMatchObject({ code: 'identity.role_grant_exceeds_holder', changed: 'no' });
    expect(json.refusal.body).toContain('staff:ledger:write:production');

    identity({
      'roles.assign': () =>
        trpcOk(
          result({
            requestId: 'console:identity.roles.assign:other',
            outcome: 'changed',
            approverId: 'x'.repeat(8),
            staff: tStaff(),
            role: null,
          }),
        ),
    });
    json = await (await run()).json();
    expect(json).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });

    identity({
      'roles.assign': () => trpcOk(result({ outcome: 'changed', approverId: 'approver1', staff: tStaff({ roleIds: [] }), role: null })),
    });
    json = await (await run()).json();
    expect(json).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });

    identity({ 'roles.assign': () => trpcOk(result({ outcome: 'changed', approverId: 'approver1', staff: tStaff(), role: null })) });
    json = await (await run()).json();
    expect(json).toMatchObject({ ok: true, detail: expect.stringContaining('svc-identity made the change') });
  });

  it('only staff request kinds are taken here', async () => {
    const fn = identity({});
    const kill = { kind: 'edge.kill', module: 'trade', disabled: true, reason: 'TEST not a staff request' };
    const res = await post({ step: 'propose', request: kill, confirm: 'KILL trade' });
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
});
