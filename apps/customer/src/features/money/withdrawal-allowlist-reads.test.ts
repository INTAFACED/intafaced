import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { createAllowlistReads, requestedChange } from './withdrawal-allowlist-reads';

const owner = '11111111-1111-4111-8111-111111111111';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash = 'a'.repeat(64);
const change = {
  id,
  userId: owner,
  op: 'add',
  entryId: null,
  subject: { address: '0x1111111111111111111111111111111111111111', label: 'Cold', assetId: 'USDT', group: 'external_wallet' },
  requestHash: hash,
  teamAccountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  requiredApprovals: 2,
  approvalCount: 1,
  approvedByMe: false,
  status: 'waiting',
  failureCode: null,
  createdAt: '2026-10-20T09:20:00Z',
  decidedAt: null,
};
const entry = {
  id,
  userId: owner,
  group: 'external_wallet',
  assetId: 'USDT',
  address: '0x1111111111111111111111111111111111111111',
  label: 'Cold',
  state: 'active',
  createdBy: owner,
  suspendedReason: null,
  createdAt: '2026-10-20T09:20:00Z',
  lastUsedAt: null,
};
const wire = (data: unknown) => new Response(JSON.stringify({ result: { data } }));

describe('withdrawal allowlist reads', () => {
  it('admits only one UUID changeId, lower-casing a canonical one', () => {
    expect(requestedChange('')).toEqual({ ok: true, id: null });
    expect(requestedChange('?changeId=' + id.toUpperCase())).toEqual({ ok: true, id });
    for (const search of ['?changeId=', '?changeId=1', `?changeId=${id}&changeId=${id}`])
      expect(requestedChange(search)).toEqual({ ok: false });
  });

  it('reads each list on its published procedure with an explicit bound', async () => {
    const urls: string[] = [];
    const api = createApiClient({
      fetch: async (url) => {
        urls.push(String(url));
        return wire(String(url).includes('listEntries') ? [entry] : [change]);
      },
    });
    const reads = createAllowlistReads(api, owner, () => true);
    expect((await reads.entries(50)).ok).toBe(true);
    expect((await reads.changes(25)).ok).toBe(true);
    expect(urls[0]).toContain('/api/pay/trpc/allowlist.listEntries');
    expect(JSON.parse(new URL(urls[0]!, 'http://x').searchParams.get('input')!)).toEqual({ limit: 50 });
    expect(urls[1]).toContain('/api/pay/trpc/allowlist.listChanges');
  });

  it('shows no row that names another user, and refuses a window above its bound', async () => {
    const api = createApiClient({ fetch: async () => wire([{ ...entry, userId: other }]) });
    const reads = createAllowlistReads(api, owner, () => true);
    expect(await reads.entries(50)).toMatchObject({ ok: false, code: 'allowlist.window_invalid' });
    const tooMany = createApiClient({ fetch: async () => wire([entry, entry]) });
    expect(await createAllowlistReads(tooMany, owner, () => true).entries(1)).toMatchObject({
      ok: false,
      code: 'allowlist.window_invalid',
    });
    expect(await createAllowlistReads(api, owner, () => true).entries(0)).toMatchObject({ ok: false, code: 'allowlist.window_invalid' });
  });

  it('refuses a change whose id is not the one asked for, and a malformed id before any call', async () => {
    let calls = 0;
    const api = createApiClient({
      fetch: async () => {
        calls += 1;
        return wire({ ...change, id: other });
      },
    });
    const reads = createAllowlistReads(api, owner, () => true);
    expect(await reads.get(id)).toMatchObject({ ok: false, code: 'allowlist.input_invalid' });
    expect(await reads.get('nope')).toMatchObject({ ok: false, code: 'allowlist.input_invalid' });
    expect(calls).toBe(1);
  });

  it('sends nothing when signed out', async () => {
    let calls = 0;
    const api = createApiClient({
      fetch: async () => {
        calls += 1;
        return wire({});
      },
    });
    const reads = createAllowlistReads(api, null, () => true);
    expect(await reads.mode()).toMatchObject({ ok: false, code: 'allowlist.session_required' });
    expect(await reads.cancel(id)).toMatchObject({ ok: false, code: 'allowlist.session_required' });
    expect(calls).toBe(0);
  });

  it('cancels with the one change id on the published mutation', async () => {
    const bodies: string[] = [];
    const api = createApiClient({
      fetch: async (url, init) => {
        bodies.push(`${String(url)} ${String(init?.body ?? '')}`);
        return wire({ ...change, status: 'cancelled' });
      },
    });
    const result = await createAllowlistReads(api, owner, () => true).cancel(id.toUpperCase());
    expect(result.ok).toBe(true);
    expect(bodies[0]).toContain('allowlist.cancel');
    expect(bodies[0]).toContain(`"changeId":"${id}"`);
  });
});

describe('the owner calls that need the withdrawal token', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const changeRow = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: ownerId,
    op: 'add',
    entryId: null,
    subject: {},
    requestHash: 'a'.repeat(64),
    teamAccountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    requiredApprovals: 2,
    approvalCount: 0,
    approvedByMe: false,
    status: 'waiting',
    failureCode: null,
    createdAt: '2026-10-20T09:20:00Z',
    decidedAt: null,
  };
  const make = () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true, data: changeRow });
    return { mutate, reads: createAllowlistReads({ mutate } as never, ownerId, () => true) };
  };

  it('sends each one with the confirmation token as its own bearer and the request reference', async () => {
    const { mutate, reads } = make();
    await reads.proposeAdd({ group: 'external_wallet', assetId: 'USDT', address: '0xabc', label: 'Cold', clientRef: 'r1' }, 'tok');
    await reads.proposeDelete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'r2', 'tok');
    await reads.proposePolicy({ enabled: true, assetId: 'USDT', maxAmount: '10', clientRef: 'r3' }, 'tok');
    expect(mutate.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      'allowlist.proposeAdd',
      'allowlist.proposeDelete',
      'allowlist.proposePolicy',
    ]);
    for (const call of mutate.mock.calls) expect(call[4]).toEqual({ bearer: 'tok' });
  });

  it('sends nothing when the account changed', async () => {
    const mutate = vi.fn();
    const reads = createAllowlistReads({ mutate } as never, ownerId, () => false);
    expect(await reads.setMode(true, 'r', 'tok')).toMatchObject({ ok: false });
    expect(mutate).not.toHaveBeenCalled();
  });
});
