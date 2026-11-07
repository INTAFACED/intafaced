import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, postgresAvailable } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type ClaimRecordInput } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { MemoryClaimStore, SqlClaimStore, type ClaimStore } from './store.js';

// RC-more-catalogue-24 (J-more-catalogue-14 #7): the marketing claims evidence register. A founder records a claim with
// its evidence or none; a second founder publishes it, only with evidence; the register shows each claim with its
// evidence or its block.

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signed(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

const T0 = '2026-11-07T09:00:00.000Z';

function build(store: ClaimStore | null = new MemoryClaimStore()) {
  const router = createOpsRouter(new OpsService(), undefined, { now: () => T0, ...(store ? { claims: store } : {}) });
  return {
    store,
    caller: (userId = A, scopes = ['admin:read', 'admin:write']) => signed(userId, scopes).then((ctx) => router.createCaller(ctx)),
  };
}

let n = 0;
const claim = (over: Partial<ClaimRecordInput> = {}): ClaimRecordInput => ({
  key: `claim:${(++n).toString(16).padStart(16, '0')}`,
  topic: 'TEST launch',
  text: 'Reserves for this TEST launch are held one to one',
  evidence: 'TEST reserve attestation, document TEST-001',
  ...over,
});

describe('marketing claims evidence register', () => {
  it('a second founder publishes a claim with evidence; the register shows it with its evidence and both founders', async () => {
    const { caller } = build();
    const a = await caller(A);
    const recorded = await a.claims.record(claim());
    expect(recorded).toMatchObject({ outcome: 'created', claim: { status: 'draft', block: 'awaiting_approval', authorId: A } });
    const published = await (await caller(B)).claims.publish({ id: recorded.claim.id });
    expect(published).toMatchObject({
      outcome: 'published',
      claim: { status: 'published', block: null, approverId: B, publishedAt: T0, evidence: 'TEST reserve attestation, document TEST-001' },
    });
    expect((await a.claims.list()).items).toEqual([published.claim]);
  });

  it('the founder who recorded a claim cannot publish it, and the refusal is logged', async () => {
    const { caller, store } = build();
    const a = await caller(A);
    const { claim: c } = await a.claims.record(claim());
    await expect(a.claims.publish({ id: c.id })).rejects.toThrow(/ops\.claim_self_approval/);
    expect((await a.claims.list()).items[0]).toMatchObject({ status: 'draft', block: 'awaiting_approval', approverId: null });
    expect((store as MemoryClaimStore).log.map((l) => `${l.op}:${l.outcome}:${l.code ?? ''}`)).toEqual([
      'record:created:',
      'publish:refused:ops.claim_self_approval',
    ]);
  });

  it('a claim with no evidence shows its block and cannot be published', async () => {
    const { caller } = build();
    const { claim: c } = await (await caller(A)).claims.record(claim({ evidence: null, text: 'Best execution on every TEST order' }));
    expect(c).toMatchObject({ evidence: null, block: 'evidence_missing' });
    await expect((await caller(B)).claims.publish({ id: c.id })).rejects.toThrow(/ops\.claim_evidence_missing/);
    expect((await (await caller(B)).claims.list()).items[0]).toMatchObject({ status: 'draft', block: 'evidence_missing' });
  });

  it('a lost reply sent again finds the same claim; the same key with other words is refused; publishing twice is a no-op', async () => {
    const { caller } = build();
    const a = await caller(A);
    const input = claim();
    const first = await a.claims.record(input);
    expect(await a.claims.record(input)).toEqual({ ...first, outcome: 'replayed' });
    await expect(a.claims.record({ ...input, text: 'Other words' })).rejects.toThrow(/ops\.idempotency_conflict/);
    const b = await caller(B);
    await b.claims.publish({ id: first.claim.id });
    expect(await b.claims.publish({ id: first.claim.id })).toMatchObject({ outcome: 'noop', claim: { approverId: B } });
    await expect(b.claims.publish({ id: '33333333-3333-4333-8333-333333333333' })).rejects.toThrow(/ops\.claim_not_found/);
  });

  it('reads need admin:read and writes admin:write; with no storage it says so', async () => {
    const { caller } = build();
    await expect((await caller(A, ['admin:read'])).claims.record(claim())).rejects.toThrow();
    await expect((await caller(A, ['ops:read'])).claims.list()).rejects.toThrow();
    const none = await build(null).caller();
    await expect(none.claims.list()).rejects.toThrow(/ops\.claims_storage_unconfigured/);
    await expect(none.claims.record(claim())).rejects.toThrow(/ops\.claims_storage_unconfigured/);
  });
});

const claimsPg = await postgresAvailable();

if (!claimsPg) {
  describe.skip('marketing claims register (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('marketing claims register on real PostgreSQL', () => {
    it('stores, survives a new store, refuses self-approval and an unevidenced publish at the table, and its log is append-only', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
      try {
        await migrateOutreach(sql);
        const { caller } = build(new SqlClaimStore(sql));
        const a = await caller(A);
        const input = claim();
        const first = await a.claims.record(input);
        expect(await a.claims.record(input)).toMatchObject({ outcome: 'replayed', claim: { id: first.claim.id } });
        const bare = await a.claims.record(claim({ evidence: null }));
        await expect(a.claims.publish({ id: first.claim.id })).rejects.toThrow(/ops\.claim_self_approval/);
        // The refused attempt is in the log: it committed before the refusal was thrown.
        expect(
          (await sql`SELECT outcome, code FROM ops.marketing_claim_log WHERE claim_id = ${first.claim.id} ORDER BY seq`).map(
            (r) => `${r.outcome}:${r.code ?? ''}`,
          ),
        ).toEqual(['created:', 'refused:ops.claim_self_approval']);
        await (await caller(B)).claims.publish({ id: first.claim.id });
        expect((await new SqlClaimStore(sql).list(10)).find((c) => c.id === first.claim.id)).toMatchObject({
          status: 'published',
          approverId: B,
        });
        // The table holds the rules even past the desk: no publish without evidence, no approver who is the author.
        await expect(
          sql`UPDATE ops.marketing_claims SET status = 'published', approver_id = ${B}, published_at = now() WHERE id = ${bare.claim.id}`,
        ).rejects.toThrow();
        await expect(sql`UPDATE ops.marketing_claims SET approver_id = ${A} WHERE id = ${first.claim.id}`).rejects.toThrow();
        await expect(sql`DELETE FROM ops.marketing_claim_log`).rejects.toThrow(/append-only/);
        await migrateOutreach(sql, 'down');
      } finally {
        await sql.end();
        await database.drop();
      }
    });
  });
}
