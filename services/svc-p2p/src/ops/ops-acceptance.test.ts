import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable, type LedgerClient } from '@intafaced/ledger-client';
import { actionApprovalSchema, createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionApprovalConsumeError, disputeResolvePayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { InstrumentService } from '../instrument-service.js';
import { ANY_COUNTRY } from '../instruments.js';
import { OpsReads } from './ops-reads.js';
import { P2pService } from '../p2p-service.js';
import { createP2pRouter } from '../router.js';

/**
 * Operator reads, manual escalation, and the default-off four-eyes ruling.
 * Postgres is the shared test server. The ledger is MemoryLedger. No Docker.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(here, '..', '..', 'drizzle', file), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const MODERATOR = '44444444-4444-4444-8444-444444444444';
const APPROVER = '55555555-5555-4555-8555-555555555555';
const ASSET = 'USDT';
const SEALED = 'SEALED-ACCT-991773';
const CHAT = 'CHAT-SEALED-771992';
const SECRET = 'p2p-ops-edge-secret-long-enough-ok';

describe('p2p.dispute_resolve stays an operator approval', () => {
  it('svc-p2p is already an operator-level target, so this type needs no identity change', () => {
    const src = readFileSync(join(root, 'services/svc-identity/src/auth/action-approval-audience.ts'), 'utf8');
    expect(src).toContain(
      "export const OPERATOR_TARGET_SERVICES: readonly string[] = ['svc-edge', 'svc-market', 'svc-academy', 'svc-p2p', 'svc-identity'];",
    );
    expect(src).not.toMatch(/FOUNDER_ACTION_PREFIXES[^\]]*p2p\./);
    const env = readFileSync(join(root, 'services/svc-p2p/src/env.ts'), 'utf8');
    expect(env).toContain('P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL');
    expect(env).not.toMatch(/P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL[\s\S]{0,400}\.default\(true\)/);
    const compose = readFileSync(join(root, 'docker-compose.apps.yml'), 'utf8');
    expect(compose).toContain('P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL: ${P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL:-}');
    expect(compose).not.toContain('P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL: ${P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL:-true}');
  });
});

describe('svc-p2p operator desk', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let p2p!: P2pService;
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;
  let posts = 0;

  beforeAll(async () => {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-ops');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'p2p', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    posts = 0;
    const post = ledger.post.bind(ledger);
    ledger.post = async (recipe) => {
      posts += 1;
      return post(recipe);
    };
    instruments = new InstrumentService(sql);
    p2p = new P2pService(sql, ledger as unknown as LedgerClient, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 100,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    for (const ownerId of [MAKER, TAKER]) {
      await instruments.createInstrument({
        ownerId,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'sepa',
        details: { account_reference: `${SEALED}-${ownerId}` },
        instrumentId: crypto.randomUUID(),
      });
    }
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function sign(scopes: string[], userId: string) {
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: userId,
      userId,
      sid: '66666666-6666-4666-8666-666666666666',
      scopes,
      tier: 'basic',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-ops',
    });
  }

  function desk(options: { disputeResolveRequiresApproval?: boolean; approvals?: ActionApprovalConsumer } = {}) {
    return createP2pRouter(p2p, instruments, undefined, {
      moderatorUserIds: [MODERATOR],
      opsReads: new OpsReads(sql),
      ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(options.disputeResolveRequiresApproval ? { disputeResolveRequiresApproval: true } : {}),
    });
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: ASSET,
        amount: parseAmount(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${crypto.randomUUID()}`,
      }),
    );
  }

  async function sell() {
    return p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('100'),
      totalAmt: parseAmount('400'),
      methods: ['sepa'],
    });
  }

  async function take(offerId: string) {
    return p2p.takeOffer({
      offerId,
      takerId: TAKER,
      amount: parseAmount('20'),
      method: 'sepa',
      tradeId: crypto.randomUUID(),
    });
  }

  it('filters three offer and trade statuses, counts them, and keeps the 24h rate exact', async () => {
    const caller = desk().createCaller(sign(['admin:compliance'], MODERATOR));
    expect(await caller.ops.disputeRate24h()).toEqual({ disputesOpened24h: 0, tradesCreated24h: 0, rate: null });

    await fund(MAKER, '1000');
    const older = await sell();
    const newer = await sell();
    const paused = await sell();
    const closed = await sell();
    await p2p.pauseOffer(paused.id, MAKER);
    await p2p.closeOffer(closed.id, MAKER);
    await sql`UPDATE p2p.offers SET created_at = timestamptz '2026-10-17 00:00:00+00' WHERE id = ${older.id}`;
    await sql`UPDATE p2p.offers SET created_at = timestamptz '2026-10-18 00:00:00+00' WHERE id = ${newer.id}`;

    const active = await caller.ops.offers({ status: 'active', limit: 1 });
    expect(active.offers.map((row) => row.id)).toEqual([newer.id]);
    expect(active.offers[0]).toMatchObject({ makerId: MAKER, status: 'active', price: '1', methodIds: ['sepa'] });
    expect(active.nextCursor).toEqual(expect.any(String));
    const rest = await caller.ops.offers({ status: 'active', limit: 1, cursor: active.nextCursor });
    expect(rest.offers.map((row) => row.id)).toEqual([older.id]);
    const end = await caller.ops.offers({ status: 'active', limit: 1, cursor: rest.nextCursor });
    expect(end.offers).toEqual([]);
    expect(end.nextCursor).toBeNull();
    expect((await caller.ops.offers({ status: 'paused', limit: 10 })).offers.map((row) => row.id)).toEqual([paused.id]);
    expect((await caller.ops.offers({ status: 'closed', limit: 10 })).offers.map((row) => row.id)).toEqual([closed.id]);

    const offer = newer;
    const escrowed = await take(offer.id);
    const fiatSent = await take(offer.id);
    await p2p.markFiatSent(fiatSent.id, TAKER);
    const disputed = await take(offer.id);
    await p2p.markFiatSent(disputed.id, TAKER);
    const dispute = await p2p.openDispute({ tradeId: disputed.id, openedBy: TAKER, reason: 'not released' });
    await p2p.sendChatMessage({ tradeId: disputed.id, senderId: TAKER, clientId: 'chat-1', text: CHAT, asModerator: false });

    expect((await caller.ops.trades({ status: 'escrowed', limit: 10 })).trades.map((row) => row.id)).toEqual([escrowed.id]);
    expect((await caller.ops.trades({ status: 'fiat_sent', limit: 10 })).trades.map((row) => row.id)).toEqual([fiatSent.id]);
    const disputedPage = await caller.ops.trades({ status: 'disputed', limit: 10 });
    expect(disputedPage.trades).toHaveLength(1);
    expect(disputedPage.trades[0]).toMatchObject({
      id: disputed.id,
      buyerId: TAKER,
      sellerId: MAKER,
      amount: '20',
      fiatAmount: '20',
      status: 'disputed',
    });
    expect(Object.keys(disputedPage.trades[0]!).sort()).toEqual(
      [
        'amount',
        'asset',
        'buyerId',
        'createdAt',
        'feeBps',
        'fiatAmount',
        'fiatCurrency',
        'id',
        'makerId',
        'method',
        'offerId',
        'price',
        'resolution',
        'sellerId',
        'status',
        'takerId',
      ].sort(),
    );

    expect(await caller.ops.counts()).toEqual({
      offers: { active: 2, paused: 1, closed: 1 },
      trades: { created: 0, escrowed: 1, fiat_sent: 1, released: 0, cancelled: 0, disputed: 1 },
    });
    expect(await caller.ops.disputeRate24h()).toEqual({ disputesOpened24h: 1, tradesCreated24h: 3, rate: '1/3' });

    await sql`UPDATE p2p.p2p_trades SET created_at = now() - interval '2 days' WHERE id = ${escrowed.id}`;
    expect(await caller.ops.disputeRate24h()).toEqual({ disputesOpened24h: 1, tradesCreated24h: 2, rate: '1/2' });

    const dumped = JSON.stringify({
      offers: await caller.ops.offers({ status: 'active', limit: 10 }),
      trades: await caller.ops.trades({ status: 'disputed', limit: 10 }),
      counts: await caller.ops.counts(),
      rate: await caller.ops.disputeRate24h(),
    });
    expect(dumped).not.toContain(SEALED);
    expect(dumped).not.toContain(CHAT);
    expect(dumped).not.toContain('account_reference');
    expect(dumped).not.toContain('fingerprint');
    expect(dispute.id).toEqual(expect.any(String));
  });

  it('refuses ops reads without admin:compliance, including a trade party', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    await take(offer.id);
    const caller = desk().createCaller(sign(['p2p:read', 'p2p:write'], TAKER));
    await expect(caller.ops.offers({ status: 'active', limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.ops.trades({ status: 'escrowed', limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.ops.counts()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.ops.disputeRate24h()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a blank ops page size', async () => {
    const caller = desk().createCaller(sign(['admin:compliance'], MODERATOR));
    await expect(caller.ops.offers({ status: 'active' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('p2p.ops_offers_limit_unset'),
    });
    await expect(caller.ops.trades({ status: 'escrowed' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('p2p.ops_trades_limit_unset'),
    });
  });

  it('re-arms an open dispute once, records the actor, and does not call the ledger', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await take(offer.id);
    await p2p.markFiatSent(trade.id, TAKER);
    const dispute = await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'waiting' });
    const postsBefore = posts;
    const caller = desk().createCaller(sign(['p2p:read'], MODERATOR));
    const first = await caller.disputes.escalate({
      disputeId: dispute.id,
      reason: 'needs a person',
      clientRequestId: 'escalate-001',
    });
    expect(first.replay).toBe(false);
    expect(first.actorId).toBe(MODERATOR);
    expect(first.escalations).toBe(1);
    const [row] = await sql<Array<{ escalated_by: string; escalations: number; delta_ms: string }>>`
      SELECT d.escalated_by, d.escalations,
             (EXTRACT(EPOCH FROM (t.deadline_at - now())) * 1000)::text AS delta_ms
        FROM p2p.p2p_disputes d
        JOIN p2p.p2p_trades t ON t.id = d.trade_id
       WHERE d.id = ${dispute.id}
    `;
    expect(row!.escalated_by).toBe(MODERATOR);
    expect(row!.escalations).toBe(1);
    const delta = Number(row!.delta_ms);
    expect(delta).toBeGreaterThan(3_500_000);
    expect(delta).toBeLessThanOrEqual(3_600_000);
    expect(posts).toBe(postsBefore);

    const again = await caller.disputes.escalate({
      disputeId: dispute.id,
      reason: 'needs a person',
      clientRequestId: 'escalate-001',
    });
    expect(again.replay).toBe(true);
    expect(again.escalations).toBe(1);
    expect(again.deadlineAt).toBe(first.deadlineAt);
    expect(posts).toBe(postsBefore);
    const [still] = await sql<Array<{ escalations: number }>>`
      SELECT escalations FROM p2p.p2p_disputes WHERE id = ${dispute.id}
    `;
    expect(still!.escalations).toBe(1);

    await expect(
      desk()
        .createCaller(sign(['p2p:read'], TAKER))
        .disputes.escalate({
          disputeId: dispute.id,
          reason: 'party',
          clientRequestId: 'escalate-002',
        }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(posts).toBe(postsBefore);
  });

  it('refuses to escalate a resolved dispute', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await take(offer.id);
    await p2p.markFiatSent(trade.id, TAKER);
    const dispute = await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'waiting' });
    await p2p.resolveDispute({ tradeId: trade.id, moderatorId: MODERATOR, resolution: 'refund', notes: 'return it' });
    const postsBefore = posts;
    await expect(
      desk()
        .createCaller(sign(['p2p:read'], MODERATOR))
        .disputes.escalate({
          disputeId: dispute.id,
          reason: 'too late',
          clientRequestId: 'escalate-003',
        }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/already resolved/) });
    expect(posts).toBe(postsBefore);
  });

  it('with the flag on, refuses a ruling that has no valid approval and leaves escrow where it is', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await take(offer.id);
    await p2p.markFiatSent(trade.id, TAKER);
    const dispute = await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'waiting' });
    const postsBefore = posts;
    const caller = desk({ disputeResolveRequiresApproval: true }).createCaller(sign(['p2p:read', 'admin:compliance'], MODERATOR));
    await expect(caller.disputes.resolve({ tradeId: trade.id, resolution: 'release', notes: 'paid' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('p2p.dispute_resolve_no_four_eyes'),
    });
    const [row] = await sql<Array<{ status: string; four_eyes: boolean | null; trade_status: string }>>`
      SELECT d.status, d.four_eyes, t.status AS trade_status
        FROM p2p.p2p_disputes d JOIN p2p.p2p_trades t ON t.id = d.trade_id
       WHERE d.id = ${dispute.id}
    `;
    expect(row).toMatchObject({ status: 'open', four_eyes: null, trade_status: 'disputed' });
    expect(posts).toBe(postsBefore);
  });

  it('consumes one matching approval and refuses a second use or a different ruling', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await take(offer.id);
    await p2p.markFiatSent(trade.id, TAKER);
    const dispute = await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'waiting' });
    const other = await take(offer.id);
    await p2p.markFiatSent(other.id, TAKER);
    const otherDispute = await p2p.openDispute({ tradeId: other.id, openedBy: TAKER, reason: 'other' });

    let used = 0;
    const hash = disputeResolvePayloadHash({ disputeId: dispute.id, winner: 'buyer', note: 'paid' });
    const approvals: ActionApprovalConsumer = {
      async consume(input) {
        if (input.approvalId !== 'appr-ops-1') {
          throw new ActionApprovalConsumeError('approval not found', 'action_approval.missing');
        }
        if (used > 0) throw new ActionApprovalConsumeError('approval already consumed', 'action_approval.consume_failed');
        if (
          input.payloadHash !== hash ||
          input.targetId !== dispute.id ||
          input.targetService !== 'svc-p2p' ||
          input.operationId !== 'op-ops-1'
        ) {
          throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
        }
        used += 1;
        return actionApprovalSchema.parse({
          approvalId: 'appr-ops-1',
          actionType: 'p2p.dispute_resolve',
          targetService: 'svc-p2p',
          targetId: dispute.id,
          expectedVersion: '1',
          payloadHash: hash,
          requesterId: MODERATOR,
          approverId: APPROVER,
          policyVersion: 'v1',
          createdAt: '2026-10-18T00:00:00.000Z',
          expiresAt: '2026-10-18T01:00:00.000Z',
          status: 'CONSUMED',
          operationId: 'op-ops-1',
        });
      },
    };
    const caller = desk({ disputeResolveRequiresApproval: true, approvals }).createCaller(
      sign(['p2p:read', 'admin:compliance'], MODERATOR),
    );
    const postsBefore = posts;
    await expect(
      caller.disputes.resolve({
        tradeId: trade.id,
        resolution: 'release',
        notes: 'different',
        approvalId: 'appr-ops-1',
        operationId: 'op-ops-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('p2p.dispute_resolve_approval_mismatch') });
    expect(used).toBe(0);
    expect(posts).toBe(postsBefore);
    const [open] = await sql<Array<{ status: string }>>`SELECT status FROM p2p.p2p_disputes WHERE id = ${dispute.id}`;
    expect(open!.status).toBe('open');

    const resolved = await caller.disputes.resolve({
      tradeId: trade.id,
      resolution: 'release',
      notes: 'paid',
      approvalId: 'appr-ops-1',
      operationId: 'op-ops-1',
    });
    expect(resolved.status).toBe('released');
    expect(used).toBe(1);
    expect(posts).toBe(postsBefore + 1);
    const [ruled] = await sql<Array<{ four_eyes: boolean }>>`SELECT four_eyes FROM p2p.p2p_disputes WHERE id = ${dispute.id}`;
    expect(ruled!.four_eyes).toBe(true);
    expect(formatAmount((await ledger.balance(userAvailable(TAKER, ASSET))).amount)).toBe('19.8');

    await expect(
      caller.disputes.resolve({
        tradeId: other.id,
        resolution: 'release',
        notes: 'paid',
        approvalId: 'appr-ops-1',
        operationId: 'op-ops-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('p2p.dispute_resolve_approval_consumed') });
    const [otherRow] = await sql<Array<{ status: string; trade_status: string }>>`
      SELECT d.status, t.status AS trade_status
        FROM p2p.p2p_disputes d JOIN p2p.p2p_trades t ON t.id = d.trade_id
       WHERE d.id = ${otherDispute.id}
    `;
    expect(otherRow).toMatchObject({ status: 'open', trade_status: 'disputed' });
  });

  it('with the flag off, resolves as before and records fourEyes false', async () => {
    await fund(MAKER, '1000');
    const offer = await sell();
    const trade = await take(offer.id);
    await p2p.markFiatSent(trade.id, TAKER);
    const dispute = await p2p.openDispute({ tradeId: trade.id, openedBy: TAKER, reason: 'waiting' });
    let consumed = 0;
    const approvals: ActionApprovalConsumer = {
      async consume() {
        consumed += 1;
        throw new Error('must not consume');
      },
    };
    const resolved = await desk({ approvals })
      .createCaller(sign(['p2p:read'], MODERATOR))
      .disputes.resolve({
        tradeId: trade.id,
        resolution: 'refund',
        notes: 'return',
        approvalId: 'ignored',
        operationId: 'ignored',
      });
    expect(resolved.status).toBe('cancelled');
    expect(consumed).toBe(0);
    const [row] = await sql<Array<{ four_eyes: boolean; resolution: string }>>`
      SELECT four_eyes, resolution FROM p2p.p2p_disputes WHERE id = ${dispute.id}
    `;
    expect(row).toEqual({ four_eyes: false, resolution: 'refund' });
  });
});
