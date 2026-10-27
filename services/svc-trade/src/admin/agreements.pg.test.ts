/**
 * D-account-07 backend acceptance against real Postgres: versioned risk agreements and margin terms, acceptances,
 * eligibility rules and assessments, the operator doors, and the gate in front of PositionService.open.
 * Real Postgres via TEST_DATABASE_URL. Every text, question and number below is TEST content.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { CommittedOperationAdmission } from '@intafaced/contracts';
import {
  MemoryLedger,
  parseAmount,
  positionCollateralAccount,
  recipes,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { AuthError } from '@intafaced/auth';
import { PositionService } from '../controls/test-admission.js';
import { principalFor } from '../spot/testing.js';
import { memoryMarkBook } from '../futures/mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from '../futures/profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from '../futures/initial-margin.test-harness.js';
import { derivativesAccessGate } from '../futures/derivatives-access.js';
import { assertIdentityLevel, sqlEligibilityStore } from '../futures/derivatives-eligibility.js';
import { acceptAgreement, sqlRiskAgreementStore } from '../futures/risk-agreements.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { TradeOpsAdmin } from './service.js';
import { tradeOpsAdminRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const operator = () => principalFor(OP, ['admin:read']);
const operatorWriter = () => principalFor(OP, ['admin:read', 'admin:write']);
const REASON = 'publish the test agreement';

const TEXTS = [
  { region: 'de', title: 'TEST title DE', body: 'TEST body DE' },
  { region: 'GB', title: 'TEST title GB', body: 'TEST body GB' },
];
const QUESTIONS = [
  {
    id: 'q1',
    prompt: 'TEST one',
    options: [
      { id: 'a', text: 'TEST a' },
      { id: 'b', text: 'TEST b' },
    ],
    correctOptionId: 'a',
  },
  {
    id: 'q2',
    prompt: 'TEST two',
    options: [
      { id: 'a', text: 'TEST a' },
      { id: 'b', text: 'TEST b' },
    ],
    correctOptionId: 'b',
  },
];

describe('risk agreements, margin terms and derivatives eligibility (D-account-07)', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let admin: TradeOpsAdmin;
  const savedCap = process.env.TRADE_OPERATOR_EXPORT_CAP;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE
      trade.operator_audit,
      trade.operator_requests,
      trade.risk_agreement_acceptances,
      trade.risk_agreement_texts,
      trade.risk_agreement_versions,
      trade.derivatives_eligibility_assessments,
      trade.derivatives_eligibility_rules
      RESTART IDENTITY CASCADE`;
    book = new MemoryApprovalBook();
    admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger: new MemoryLedger(),
      reconcileOrder: async () => {
        throw new Error('unused');
      },
      cancelOrder: async () => {
        throw new Error('unused');
      },
    });
  });

  afterEach(() => {
    if (savedCap === undefined) delete process.env.TRADE_OPERATOR_EXPORT_CAP;
    else process.env.TRADE_OPERATOR_EXPORT_CAP = savedCap;
  });

  function allow(
    approvalId: string,
    actionType: string,
    targetId: string,
    expectedVersion: string,
    body: unknown,
    approverId = APPROVER,
  ): void {
    book.put({
      approvalId,
      actionType,
      targetService: 'svc-trade',
      targetId,
      expectedVersion,
      payloadHash: payloadHash(body),
      requesterId: OP,
      approverId,
    });
  }

  /** The exact body the approval is bound to; the service builds the same one. */
  function agreementBody(kind: string, expectedVersion: string, texts = TEXTS, reason = REASON) {
    const norm = texts
      .map((t) => ({ region: t.region.trim().toUpperCase(), title: t.title.trim(), body: t.body.trim() }))
      .sort((a, b) => (a.region < b.region ? -1 : 1));
    return {
      actionType: 'trade.agreement_publish',
      kind,
      expectedVersion,
      texts: norm.map((t) => ({ region: t.region, title: t.title, bodySha256: bodyHash(t.body) })),
      reason,
    };
  }

  function bodyHash(body: string): string {
    return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  }

  async function publishAgreement(kind: 'derivatives_risk' | 'margin_terms', expectedVersion: string, tag: string, texts = TEXTS) {
    const approvalId = `ap-${tag}`;
    allow(approvalId, 'trade.agreement_publish', `agreement:${kind}`, expectedVersion, agreementBody(kind, expectedVersion, texts));
    return admin.agreements.agreementPublish(operatorWriter(), {
      kind,
      texts,
      expectedVersion,
      reason: REASON,
      approvalId,
      clientRequestId: `req-${tag}`,
    });
  }

  function rulesBody(expectedVersion: string, over: Record<string, unknown> = {}) {
    return {
      actionType: 'trade.derivatives_eligibility_rules_set',
      expectedVersion,
      questions: QUESTIONS,
      passMark: 2,
      minKycTier: 'basic',
      reason: REASON,
      ...over,
    };
  }

  async function publishRules(expectedVersion: string, tag: string, over: Record<string, unknown> = {}) {
    allow(
      `ap-${tag}`,
      'trade.derivatives_eligibility_rules_set',
      'derivatives_eligibility_rules',
      expectedVersion,
      rulesBody(expectedVersion, over),
    );
    return admin.agreements.eligibilityRulesSet(operatorWriter(), {
      questions: QUESTIONS,
      passMark: 2,
      minKycTier: 'basic',
      ...over,
      expectedVersion,
      reason: REASON,
      approvalId: `ap-${tag}`,
      clientRequestId: `req-${tag}`,
    } as never);
  }

  const auditRows = (kind: string) =>
    db.sql<Array<{ kind: string; operator_id: string; approver_id: string | null; object_id: string; detail: Record<string, unknown> }>>`
      SELECT kind, operator_id, approver_id, object_id, detail FROM trade.operator_audit WHERE kind = ${kind} ORDER BY occurred_at`;

  describe('publishing an agreement', () => {
    it('reads blank before anything is published', async () => {
      const view = await admin.agreements.agreementGet(operator(), 'derivatives_risk');
      expect(view).toMatchObject({ current: null, currentTexts: [], history: [], reason: 'no_agreement_published' });
      await expect(sqlRiskAgreementStore(db.sql).current('derivatives_risk')).resolves.toBeNull();
    });

    it('stores v1 per jurisdiction with normalised regions, a text id and a hash, and one audit row', async () => {
      const result = await publishAgreement('derivatives_risk', '0', 'v1');
      expect(result).toMatchObject({ kind: 'derivatives_risk', version: 1, operatorId: OP, approverId: APPROVER });
      if (result.version === null) throw new Error('unreachable');
      expect(result.texts.map((t) => [t.region, t.textId])).toEqual([
        ['DE', 'derivatives_risk:v1:DE'],
        ['GB', 'derivatives_risk:v1:GB'],
      ]);
      const current = await sqlRiskAgreementStore(db.sql).current('derivatives_risk');
      expect(current?.version).toBe(1);
      expect(current?.texts.map((t) => t.body)).toEqual(['TEST body DE', 'TEST body GB']);
      const audit = await auditRows('agreement.publish');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ operator_id: OP, approver_id: APPROVER, object_id: 'agreement:derivatives_risk' });
      expect(JSON.stringify(audit[0]!.detail)).not.toContain('TEST body');
    });

    it('is idempotent on clientRequestId: a replay returns the first result and writes no second version', async () => {
      const first = await publishAgreement('derivatives_risk', '0', 'v1');
      const replay = await admin.agreements.agreementPublish(operatorWriter(), {
        kind: 'derivatives_risk',
        texts: TEXTS,
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'ap-unused-second-approval',
        clientRequestId: 'req-v1',
      });
      expect(replay).toEqual(first);
      const [{ n }] = await db.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM trade.risk_agreement_versions`;
      expect(n).toBe(1);
      await expect(
        admin.agreements.agreementPublish(operatorWriter(), {
          kind: 'derivatives_risk',
          texts: [{ region: 'DE', title: 'other', body: 'other' }],
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'x',
          clientRequestId: 'req-v1',
        }),
      ).rejects.toMatchObject({ code: 'client_request_conflict' });
    });

    it('refuses a blank title or body, a repeated or malformed region, an unknown kind and no texts; the approval is not spent', async () => {
      const attempt = (texts: Array<{ region: string; title: string; body: string }>, kind: string = 'derivatives_risk') => {
        allow('ap-blank', 'trade.agreement_publish', `agreement:${kind}`, '0', agreementBody(kind, '0', texts.length ? texts : TEXTS));
        return admin.agreements.agreementPublish(operatorWriter(), {
          kind: kind as never,
          texts,
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'ap-blank',
          clientRequestId: `req-${Math.random()}`,
        });
      };
      await expect(attempt([{ region: 'DE', title: 'TEST', body: '   ' }])).rejects.toMatchObject({ code: 'agreement_text_blank' });
      await expect(attempt([{ region: 'DE', title: '', body: 'TEST' }])).rejects.toMatchObject({ code: 'agreement_text_blank' });
      await expect(attempt([])).rejects.toMatchObject({ code: 'agreement_text_blank' });
      await expect(
        attempt([
          { region: 'DE', title: 'a', body: 'a' },
          { region: ' de', title: 'b', body: 'b' },
        ]),
      ).rejects.toMatchObject({ code: 'agreement_region_invalid' });
      await expect(attempt([{ region: 'D E!', title: 'a', body: 'a' }])).rejects.toMatchObject({ code: 'agreement_region_invalid' });
      await expect(attempt(TEXTS, 'bogus')).rejects.toMatchObject({ code: 'agreement_kind_unknown' });
      const [{ n }] = await db.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM trade.risk_agreement_versions`;
      expect(n).toBe(0);
      // the approval was never consumed: the real publish still goes through with it
      allow('ap-blank', 'trade.agreement_publish', 'agreement:derivatives_risk', '0', agreementBody('derivatives_risk', '0'));
      await expect(
        admin.agreements.agreementPublish(operatorWriter(), {
          kind: 'derivatives_risk',
          texts: TEXTS,
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'ap-blank',
          clientRequestId: 'req-after-blank',
        }),
      ).resolves.toMatchObject({ version: 1 });
    });

    it('is four-eyes: no approval, a reused approval, a payload mismatch and a self-approval all refuse', async () => {
      const call = (approvalId: string, clientRequestId: string, expectedVersion = '0') =>
        admin.agreements.agreementPublish(operatorWriter(), {
          kind: 'derivatives_risk',
          texts: TEXTS,
          expectedVersion,
          reason: REASON,
          approvalId,
          clientRequestId,
        });
      await expect(call('missing', 'r1')).rejects.toMatchObject({ code: 'approval_missing' });
      allow(
        'ap-wrong',
        'trade.agreement_publish',
        'agreement:derivatives_risk',
        '0',
        agreementBody('derivatives_risk', '0', TEXTS, 'a different reason'),
      );
      await expect(call('ap-wrong', 'r2')).rejects.toMatchObject({ code: 'approval_mismatch' });
      allow('ap-self', 'trade.agreement_publish', 'agreement:derivatives_risk', '0', agreementBody('derivatives_risk', '0'), OP);
      await expect(call('ap-self', 'r3')).rejects.toMatchObject({ code: 'approval_mismatch' });
      allow('ap-ok', 'trade.agreement_publish', 'agreement:derivatives_risk', '0', agreementBody('derivatives_risk', '0'));
      await expect(call('ap-ok', 'r4')).resolves.toMatchObject({ version: 1 });
      await expect(call('ap-ok', 'r5', '1')).rejects.toMatchObject({ code: 'approval_reused' });
      await expect(
        admin.agreements.agreementPublish(operator(), {
          kind: 'derivatives_risk',
          texts: TEXTS,
          expectedVersion: '1',
          reason: REASON,
          approvalId: 'x',
          clientRequestId: 'r6',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      const [{ n }] = await db.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM trade.risk_agreement_versions`;
      expect(n).toBe(1);
    });

    it('a stale expectedVersion refuses agreement_stale', async () => {
      await publishAgreement('derivatives_risk', '0', 'v1');
      allow('ap-stale', 'trade.agreement_publish', 'agreement:derivatives_risk', '0', agreementBody('derivatives_risk', '0'));
      await expect(
        admin.agreements.agreementPublish(operatorWriter(), {
          kind: 'derivatives_risk',
          texts: TEXTS,
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'ap-stale',
          clientRequestId: 'req-stale',
        }),
      ).rejects.toMatchObject({ code: 'agreement_stale' });
    });

    it('a published version cannot be edited or removed; an operator edit is a new version and old acceptances stay linked', async () => {
      await publishAgreement('derivatives_risk', '0', 'v1');
      const store = sqlRiskAgreementStore(db.sql);
      await acceptAgreement(store, {
        userId: ALICE,
        kind: 'derivatives_risk',
        version: 1,
        region: 'DE',
        now: new Date('2026-10-20T10:00:00Z'),
      });

      await expect(db.sql`UPDATE trade.risk_agreement_texts SET body = 'edited' WHERE kind = 'derivatives_risk'`).rejects.toThrow(
        /append-only/,
      );
      await expect(db.sql`DELETE FROM trade.risk_agreement_texts WHERE kind = 'derivatives_risk'`).rejects.toThrow(/append-only/);
      await expect(db.sql`UPDATE trade.risk_agreement_versions SET reason = 'edited'`).rejects.toThrow(/append-only/);
      await expect(db.sql`UPDATE trade.risk_agreement_acceptances SET accepted_at = now()`).rejects.toThrow(/append-only/);
      await expect(db.sql`DELETE FROM trade.risk_agreement_acceptances`).rejects.toThrow(/append-only/);

      const v2Texts = [{ region: 'DE', title: 'TEST title DE v2', body: 'TEST body DE v2' }];
      const v2 = await publishAgreement('derivatives_risk', '1', 'v2', v2Texts);
      expect(v2).toMatchObject({ version: 2 });
      const view = await admin.agreements.agreementGet(operator(), 'derivatives_risk');
      expect(view.current).toMatchObject({ version: 2 });
      expect(view.history.map((h) => [h.version, h.regions])).toEqual([
        [2, ['DE']],
        [1, ['DE', 'GB']],
      ]);
      // the old acceptance is still on v1 with the v1 text id; a v2 acceptance would be its own row
      const [old] = await db.sql<Array<{ version: number; text_id: string; body: string }>>`
        SELECT a.version::int AS version, a.text_id, t.body FROM trade.risk_agreement_acceptances a
          JOIN trade.risk_agreement_texts t ON t.text_id = a.text_id WHERE a.user_id = ${ALICE}`;
      expect(old).toEqual({ version: 1, text_id: 'derivatives_risk:v1:DE', body: 'TEST body DE' });
      expect(await store.getAcceptance(ALICE, 'derivatives_risk', 2)).toBeNull();
      expect(await store.getAcceptance(ALICE, 'derivatives_risk', 1)).toMatchObject({ textId: 'derivatives_risk:v1:DE' });
      // v2 has no GB text: an acceptance from GB is refused as a region now
      await expect(
        acceptAgreement(store, { userId: ALICE, kind: 'derivatives_risk', version: 2, region: 'GB', now: new Date() }),
      ).rejects.toMatchObject({ code: 'trade.agreement_region_unavailable' });
    });

    it('margin terms are their own versioned kind', async () => {
      await publishAgreement('derivatives_risk', '0', 'r1');
      await publishAgreement('margin_terms', '0', 'm1');
      const store = sqlRiskAgreementStore(db.sql);
      expect((await store.current('margin_terms'))?.version).toBe(1);
      expect((await store.current('derivatives_risk'))?.version).toBe(1);
    });

    it('works through the tRPC router with the same typed refusals', async () => {
      const caller = tradeOpsAdminRouter(admin).createCaller({ principal: operatorWriter() } as never);
      allow('ap-trpc', 'trade.agreement_publish', 'agreement:margin_terms', '0', agreementBody('margin_terms', '0'));
      const published = await caller.agreements.publish({
        kind: 'margin_terms',
        texts: TEXTS,
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'ap-trpc',
        clientRequestId: 'req-trpc',
      });
      expect(published).toMatchObject({ version: 1 });
      await expect(
        caller.agreements.publish({
          kind: 'margin_terms',
          texts: TEXTS,
          expectedVersion: '0',
          reason: REASON,
          approvalId: 'nope',
          clientRequestId: 'req-trpc-2',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect((await caller.agreements.get({ kind: 'margin_terms' })).current).toMatchObject({ version: 1 });
    });
  });

  describe('acceptances (Postgres store)', () => {
    it('is idempotent on (user, kind, version): a repeat and ten concurrent accepts leave one row with the first time', async () => {
      await publishAgreement('derivatives_risk', '0', 'v1');
      const store = sqlRiskAgreementStore(db.sql);
      const t1 = new Date('2026-10-20T10:00:00Z');
      const first = await acceptAgreement(store, { userId: ALICE, kind: 'derivatives_risk', version: 1, region: 'DE', now: t1 });
      const second = await acceptAgreement(store, {
        userId: ALICE,
        kind: 'derivatives_risk',
        version: 1,
        region: 'DE',
        now: new Date('2026-10-21T10:00:00Z'),
      });
      expect(first).toMatchObject({ created: true, acceptedAt: t1.toISOString() });
      expect(second).toMatchObject({ created: false, acceptedAt: t1.toISOString() });

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          acceptAgreement(store, { userId: BOB, kind: 'derivatives_risk', version: 1, region: 'GB', now: new Date() }),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.acceptedAt)).size).toBe(1);
      const [{ n }] = await db.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM trade.risk_agreement_acceptances`;
      expect(n).toBe(2);
    });

    it('records the jurisdiction text id the user saw; an acceptance of a text that was never published cannot be stored', async () => {
      await publishAgreement('derivatives_risk', '0', 'v1');
      const store = sqlRiskAgreementStore(db.sql);
      await acceptAgreement(store, { userId: ALICE, kind: 'derivatives_risk', version: 1, region: 'gb', now: new Date() });
      const [row] = await db.sql<Array<{ region: string; text_id: string }>>`SELECT region, text_id FROM trade.risk_agreement_acceptances`;
      expect(row).toEqual({ region: 'GB', text_id: 'derivatives_risk:v1:GB' });
      await expect(
        db.sql`INSERT INTO trade.risk_agreement_acceptances (user_id, kind, version, region, text_id, accepted_at)
               VALUES (${BOB}, 'derivatives_risk', 1, 'FR', 'derivatives_risk:v1:FR', now())`,
      ).rejects.toThrow();
    });
  });

  describe('compliance list and export', () => {
    async function seedAcceptances() {
      await publishAgreement('derivatives_risk', '0', 'v1');
      const store = sqlRiskAgreementStore(db.sql);
      await acceptAgreement(store, {
        userId: ALICE,
        kind: 'derivatives_risk',
        version: 1,
        region: 'DE',
        now: new Date('2026-10-20T10:00:00Z'),
      });
      await acceptAgreement(store, {
        userId: BOB,
        kind: 'derivatives_risk',
        version: 1,
        region: 'GB',
        now: new Date('2026-10-20T11:00:00Z'),
      });
    }

    it('lists acceptances with filters and a stable cursor', async () => {
      await seedAcceptances();
      const all = await admin.agreements.list(operator(), { limit: 10 });
      expect(all.rows.map((r) => r.userId)).toEqual([ALICE, BOB]);
      const one = await admin.agreements.list(operator(), { limit: 1 });
      expect(one.rows).toHaveLength(1);
      expect(one.nextCursor).not.toBeNull();
      const next = await admin.agreements.list(operator(), { limit: 1, cursor: one.nextCursor });
      expect(next.rows.map((r) => r.userId)).toEqual([BOB]);
      expect(next.nextCursor).toBeNull();
      expect((await admin.agreements.list(operator(), { limit: 10, region: 'gb' })).rows.map((r) => r.userId)).toEqual([BOB]);
      expect(
        (await admin.agreements.list(operator(), { limit: 10, userId: ALICE, kind: 'derivatives_risk', version: 1 })).rows,
      ).toHaveLength(1);
      expect((await admin.agreements.list(operator(), { limit: 10, kind: 'margin_terms' })).rows).toEqual([]);
      await expect(admin.agreements.list(operator(), { limit: 10, cursor: 'garbage' })).rejects.toMatchObject({ code: 'cursor_invalid' });
      await expect(admin.agreements.list(operator(), { limit: 10, from: 'not a date' })).rejects.toMatchObject({ code: 'filter_invalid' });
    });

    it('needs admin:read', async () => {
      await expect(admin.agreements.list(principalFor(OP, ['trade:read']), { limit: 10 })).rejects.toBeInstanceOf(AuthError);
    });

    it('export refuses when the export cap is blank, then returns an audited CSV', async () => {
      await seedAcceptances();
      delete process.env.TRADE_OPERATOR_EXPORT_CAP;
      await expect(admin.agreements.export(operator(), { reason: 'quarterly review' })).rejects.toMatchObject({ code: 'export_cap_unset' });
      process.env.TRADE_OPERATOR_EXPORT_CAP = '1';
      const capped = await admin.agreements.export(operator(), { reason: 'quarterly review' });
      expect(capped).toMatchObject({ rowCount: 1, truncated: true });
      process.env.TRADE_OPERATOR_EXPORT_CAP = '10';
      const full = await admin.agreements.export(operator(), { reason: 'quarterly review' });
      expect(full.truncated).toBe(false);
      expect(full.csv.split('\n')[0]).toBe('userId,kind,version,region,textId,acceptedAt');
      expect(full.csv).toContain(`${ALICE},derivatives_risk,1,DE,derivatives_risk:v1:DE,2026-10-20T10:00:00.000Z`);
      await expect(admin.agreements.export(operator(), { reason: 'x' })).rejects.toMatchObject({ code: 'reason_required' });
      expect(await auditRows('agreement.export')).toHaveLength(2);
    });
  });

  describe('eligibility rules', () => {
    it('reads blank before anything is published', async () => {
      expect(await admin.agreements.eligibilityRulesGet(operator())).toMatchObject({
        version: null,
        reason: 'trade.identity_level_unset',
        questions: [],
        passMark: null,
        minKycTier: null,
      });
      // with nothing published the blank tier refuses every open: it never means "no requirement"
      await expect(assertIdentityLevel(sqlEligibilityStore(db.sql), { userId: ALICE, tier: 'full' })).rejects.toMatchObject({
        code: 'trade.identity_level_unset',
      });
    });

    it('refuses incomplete content with eligibility_rules_incomplete and spends no approval', async () => {
      const call = (over: Record<string, unknown>, tag: string) => {
        allow(`ap-${tag}`, 'trade.derivatives_eligibility_rules_set', 'derivatives_eligibility_rules', '0', rulesBody('0', over));
        return admin.agreements.eligibilityRulesSet(operatorWriter(), {
          questions: QUESTIONS,
          passMark: 2,
          minKycTier: 'basic',
          ...over,
          expectedVersion: '0',
          reason: REASON,
          approvalId: `ap-${tag}`,
          clientRequestId: `req-${tag}`,
        } as never);
      };
      await expect(call({ passMark: 0 }, 'a')).rejects.toMatchObject({ code: 'eligibility_rules_incomplete' });
      await expect(call({ passMark: 3 }, 'b')).rejects.toMatchObject({ code: 'eligibility_rules_incomplete' });
      await expect(call({ questions: [] }, 'c')).rejects.toMatchObject({ code: 'eligibility_rules_incomplete' });
      await expect(call({ minKycTier: '' }, 'd')).rejects.toMatchObject({ code: 'eligibility_rules_incomplete' });
      await expect(call({ questions: [{ ...QUESTIONS[0], correctOptionId: 'zz' }], passMark: 1 }, 'e')).rejects.toMatchObject({
        code: 'eligibility_rules_incomplete',
      });
      const [{ n }] = await db.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM trade.derivatives_eligibility_rules`;
      expect(n).toBe(0);
    });

    it('publishes rules (four-eyes, audited without the scoring key), then a stale version refuses', async () => {
      const rules = await publishRules('0', 'r1');
      expect(rules).toMatchObject({ version: 1, passMark: 2, minKycTier: 'basic', operatorId: OP, approverId: APPROVER });
      const audit = await auditRows('derivatives_eligibility_rules.set');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.detail).toMatchObject({ version: 1, questionCount: 2, passMark: 2, minKycTier: 'basic' });
      expect(JSON.stringify(audit[0]!.detail)).not.toContain('correctOptionId');
      await expect(publishRules('0', 'r2')).rejects.toMatchObject({ code: 'eligibility_rules_stale' });
      await expect(
        admin.agreements.eligibilityRulesSet(operatorWriter(), {
          questions: QUESTIONS,
          passMark: 2,
          minKycTier: 'basic',
          expectedVersion: '1',
          reason: REASON,
          approvalId: 'none',
          clientRequestId: 'req-none',
        }),
      ).rejects.toMatchObject({ code: 'approval_missing' });
      await expect(db.sql`UPDATE trade.derivatives_eligibility_rules SET pass_mark = 1`).rejects.toThrow(/append-only/);
    });

    it('the newest published rules name the identity tier, read through the durable store', async () => {
      const store = sqlEligibilityStore(db.sql);
      await publishRules('0', 'r1', { minKycTier: 'full' });
      await expect(assertIdentityLevel(store, { userId: ALICE, tier: 'basic' })).rejects.toMatchObject({
        code: 'trade.identity_level_insufficient',
        detail: { requiredTier: 'full', currentTier: 'basic' },
      });
      await expect(assertIdentityLevel(store, { userId: ALICE, tier: 'full' })).resolves.toBeUndefined();
      await publishRules('1', 'r2', { minKycTier: 'basic' });
      await expect(assertIdentityLevel(store, { userId: ALICE, tier: 'basic' })).resolves.toBeUndefined();
    });
  });

  describe('the gate in front of PositionService.open', () => {
    const MARKS = memoryMarkBook();
    const profitSource = profitSourceFromConfig(formatAccountRef(recipeProfitFundingAccount('USDT')));
    const input = {
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long' as const,
      size: 1n,
      leverage: TEST_MAX_LEVERAGE_AMOUNT,
      clientOpenId: 'open-1',
    };

    const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const NOW = new Date('2026-10-20T12:00:00Z');
    const savedFutures = process.env.TRADE_FUTURES_ENABLED;
    const savedJobs = process.env.TRADE_FUTURES_JOBS_ENABLED;

    // The gate runs after the market lookup and the admitted-open replay, so the market exists here.
    beforeEach(async () => {
      await db.sql`TRUNCATE trade.positions, trade.markets RESTART IDENTITY CASCADE`;
      await db.sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at
        ) VALUES (${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now())
      `;
    });

    afterEach(() => {
      if (savedFutures === undefined) delete process.env.TRADE_FUTURES_ENABLED;
      else process.env.TRADE_FUTURES_ENABLED = savedFutures;
      if (savedJobs === undefined) delete process.env.TRADE_FUTURES_JOBS_ENABLED;
      else process.env.TRADE_FUTURES_JOBS_ENABLED = savedJobs;
    });

    function positions(
      gate?: Parameters<typeof derivativesAccessGate>[0] | ((s: never) => Promise<void>),
      extra: { ledger?: LedgerClient; accountAdmission?: TradingAdmissionPort } = {},
    ) {
      return new PositionService(db.sql, extra.ledger ?? new MemoryLedger(), {
        marks: MARKS.source(),
        profitSource,
        maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
        now: () => NOW,
        ...(extra.accountAdmission ? { accountAdmission: extra.accountAdmission } : {}),
        ...(gate ? { assertDerivativesAccess: typeof gate === 'function' ? (gate as never) : derivativesAccessGate(gate) } : {}),
      });
    }

    it('production wiring on an empty deployment refuses on the blank tier, never on an agreement or quiz', async () => {
      const service = positions({ eligibility: sqlEligibilityStore(db.sql) });
      await expect(service.open(input, principalFor(ALICE), { region: 'DE' })).rejects.toMatchObject({
        code: 'trade.identity_level_unset',
      });
      // rules naming the caller's tier, quiz never taken: the open moves on to the mark, which this test never sets
      await publishRules('0', 'empty-tier', { minKycTier: 'basic' });
      await expect(service.open(input, principalFor(ALICE), { region: 'DE' })).rejects.toMatchObject({ code: 'trade.mark_missing' });
    });

    it('with real stores the only refusal is the identity tier the rules name', async () => {
      const eligibility = sqlEligibilityStore(db.sql);
      const service = positions({ eligibility });
      const alice = principalFor(ALICE);
      // an agreement published and never accepted does not refuse
      await publishAgreement('derivatives_risk', '0', 'v1');
      await publishRules('0', 'r1', { minKycTier: 'full' });
      // tier basic is below the rule's full; the open refuses before the mark is read
      await expect(service.open(input, alice, { region: 'FR' })).rejects.toMatchObject({ code: 'trade.identity_level_insufficient' });
      // the gate passed at tier full with no quiz taken: the open moves on to the mark, which this test never sets
      const full = { ...alice, tier: 'full' as const };
      await expect(service.open(input, full, { region: 'DE' })).rejects.toMatchObject({ code: 'trade.mark_missing' });
    });

    it('a closing or reducing action never reaches the gate', async () => {
      const gate = vi.fn(async () => {
        throw new Error('gate must not run for a reducing or closing action');
      });
      const service = positions(gate);
      // reduce-only open: skips the gate (and refuses on its own: there is no position to reduce)
      await expect(service.open({ ...input, reduceOnly: true }, principalFor(ALICE))).rejects.toMatchObject({
        code: 'trade.reduce_only_would_increase',
      });
      // a normal open does run it
      await expect(service.open(input, principalFor(ALICE))).rejects.toThrow('gate must not run');
      expect(gate).toHaveBeenCalledTimes(1);
      // close of a position that does not exist refuses on the position, never on the gate
      await expect(service.close(ALICE, '99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({
        code: 'trade.position_not_found',
      });
      expect(gate).toHaveBeenCalledTimes(1);
    });

    it('an open admitted and locked before a crash finishes on retry after new rules raise the tier', async () => {
      process.env.TRADE_FUTURES_ENABLED = 'true';
      process.env.TRADE_FUTURES_JOBS_ENABLED = 'true';
      MARKS.set({ marketId: MARKET, symbol: 'BTC/USDT-PERP', price: '100', quality: 'mid', asOfMs: NOW.getTime() });
      const eligibility = sqlEligibilityStore(db.sql);
      await publishRules('0', 'crash-r1', { minKycTier: 'full' });

      const memory = new MemoryLedger();
      await memory.post(
        recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'crash-fund' }),
      );
      // The margin lock lands, then the process dies before the position row is written.
      let crash = true;
      const ledger = {
        ...memory,
        post: async (request: PostRequest) => {
          const tx = await memory.post(request);
          if (request.reason === 'futures.margin.lock' && crash) {
            crash = false;
            throw new Error('crashed after the margin lock');
          }
          return tx;
        },
        balance: (ref: Parameters<LedgerClient['balance']>[0]) => memory.balance(ref),
        balances: (...args: Parameters<LedgerClient['balances']>) => memory.balances(...args),
      } as LedgerClient;
      const admitted = new Map<string, { payload: unknown; admission: CommittedOperationAdmission; grantId: string }>();
      const accountAdmission: TradingAdmissionPort = {
        async admit(principal, kind, businessId, payload) {
          const admission = {
            operation: { service: 'svc-trade', kind, userId: principal.userId },
            businessId,
            payloadHash: 'sha256:agreements-test',
            status: 'committed',
            admissionId: `adm-${businessId}`,
            admittedAt: NOW.toISOString(),
            identityVersion: '0',
            restrictionVersion: '0',
          } as CommittedOperationAdmission;
          if (!admitted.has(`${principal.userId}:${businessId}`)) {
            admitted.set(`${principal.userId}:${businessId}`, { payload, admission, grantId: admission.admissionId });
          }
          return admission;
        },
        async admitStanding() {
          throw new Error('no standing instruction here');
        },
        async original(userId, businessId) {
          return admitted.get(`${userId}:${businessId}`) ?? null;
        },
        async resolve(userId, businessId) {
          return admitted.get(`${userId}:${businessId}`) ?? null;
        },
      };
      const service = positions({ eligibility }, { ledger, accountAdmission });
      const alice = { ...principalFor(ALICE), tier: 'full' as const };
      const open = { ...input, size: parseAmount('0.1') };

      await expect(service.open(open, alice, { region: 'DE' })).rejects.toThrow('crashed after the margin lock');
      expect(await db.sql`SELECT 1 FROM trade.positions WHERE user_id = ${ALICE}`).toHaveLength(0);

      // New rules above Alice's tier: a new open refuses, the admitted one does not.
      await publishRules('1', 'crash-r2', { minKycTier: 'institutional' });
      await expect(service.open({ ...open, clientOpenId: 'open-2' }, alice, { region: 'DE' })).rejects.toMatchObject({
        code: 'trade.identity_level_insufficient',
      });
      const position = await service.open(open, alice, { region: 'DE' });
      const rows = await db.sql<{ id: string; margin_current: string }[]>`
        SELECT id, margin_current FROM trade.positions WHERE user_id = ${ALICE}
      `;
      expect(rows.map((r) => r.id)).toEqual([position.id]);
      expect((await memory.balance(positionCollateralAccount(ALICE, 'USDT', position.id!))).amount).toBe(
        parseAmount(rows[0]!.margin_current),
      );
    });

    it('the gate receives the user, the principal tier and the request region', async () => {
      const gate = vi.fn(async () => {
        throw new Error('stop');
      });
      const service = positions(gate);
      await expect(service.open(input, { ...principalFor(ALICE), tier: 'full' }, { region: 'GB' })).rejects.toThrow('stop');
      expect(gate).toHaveBeenCalledWith({ userId: ALICE, tier: 'full', region: 'GB' });
    });
  });
});
