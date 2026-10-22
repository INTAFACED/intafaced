/**
 * PP-send-request-07: compliance publishes personal transfer terms with a second person.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { memoryPartyHandles } from '../transfers/party-handles.js';
import { PUBLISH_TRANSFER_TERMS_ACTION, publishTransferTermsFields, type PublishTransferTermsInput } from '../transfers/transfer-terms.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const SID = '99999999-9999-4999-8999-999999999999';
const ACTION = PUBLISH_TRANSFER_TERMS_ACTION;
const BOB = '22222222-2222-4222-8222-222222222222';

function principal(userId: string, scopes: string[]): Principal {
  return { sub: userId, userId, sid: SID, scopes, tier: 'full', mfa: true, expiresAt: new Date(Date.now() + 60_000) } as Principal;
}

function caller(bank: BankServices, userId: string, scopes: string[], approvals?: ReturnType<typeof deskApprovals>) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, approvals ? { approvals } : {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

/** Identity stand-in: an approval is bound to one asset and its three figures. */
function deskApprovals() {
  const issued = new Map<string, string>();
  let consumed = 0;
  return {
    get consumed() {
      return consumed;
    },
    issue(input: PublishTransferTermsInput) {
      const approvalId = randomUUID();
      issued.set(approvalId, bankActionPayloadHash(ACTION, publishTransferTermsFields(input)));
      return { approvalId, operationId: randomUUID() };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      if (issued.get(input.approvalId) !== input.payloadHash || input.targetId !== ACTION) {
        throw new ActionApprovalConsumeError('approval does not match these terms', 'action_approval.consume_failed');
      }
      consumed += 1;
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: ACTION,
        targetService: 'svc-bank',
        targetId: ACTION,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: OPERATOR,
        approverId: APPROVER,
        requesterIsFounder: true,
        approverIsFounder: true,
        policyVersion: 'v1',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.operationId,
      };
    },
  };
}

/** TEST figures only; not owner values. */
function terms(over: Partial<PublishTransferTermsInput> = {}): PublishTransferTermsInput {
  return { assetId: 'USDT', perTransferLimit: '250', dailyLimit: '1000', fee: '0', ...over };
}

describe('ops.publishTransferTerms (PP-send-request-07)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.personal_transfers, bank.personal_transfer_terms, bank.spaces RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  function services(): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      handles: memoryPartyHandles({ [OWNER]: 'ada', [BOB]: 'bob' }),
    });
  }

  const compliance = (bank: BankServices, approvals: ReturnType<typeof deskApprovals>) =>
    caller(bank, OPERATOR, ['admin:compliance'], approvals);
  const stored = () => sql`SELECT asset_id, per_transfer_limit::text, daily_limit::text, fee::text FROM bank.personal_transfer_terms`;

  it('publishes the figures with a second person, names the approver, and the send path enforces them', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms();
    const published = await compliance(bank, approvals).ops.publishTransferTerms({ ...input, ...approvals.issue(input) });
    expect(published).toMatchObject({ assetId: 'USDT', perTransferLimit: '250', dailyLimit: '1000', fee: '0', approvedBy: APPROVER });
    expect(approvals.consumed).toBe(1);

    const ada = caller(bank, OWNER, ['bank:read', 'bank:write']);
    expect(await ada.transfers.quote({ assetId: 'USDT', amount: '10' })).toMatchObject({
      perTransferLimit: '250',
      dailyLimit: '1000',
      fee: '0',
    });
    await ledger.post(recipes.deposit({ userId: OWNER, assetId: 'USDT', amount: parseAmount('500'), rail: 'test', railRef: 'ada-500' }));
    const from = await bank.spaces.ensurePrimary(OWNER, 'USDT');
    await expect(
      ada.transfers.toUser({ transferId: 'terms-over-1', fromSpaceId: from.id, toUserId: BOB, amount: '250.01' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('bank.personal_transfer_limit_exceeded') });
    const sent = await ada.transfers.toUser({ transferId: 'terms-ok-1', fromSpaceId: from.id, toUserId: BOB, amount: '250' });
    expect(sent.amount).toBe('250');
    expect(formatAmount((await ledger.balance(userAvailable(BOB, 'USDT'))).amount)).toBe('250');
    expect(ledger.totalsByAsset().USDT).toBe('0');
  });

  it('publishing again replaces the figures for that asset only', async () => {
    const bank = services();
    const approvals = deskApprovals();
    for (const input of [terms(), terms({ assetId: 'USDC', perTransferLimit: '5', dailyLimit: '5' }), terms({ perTransferLimit: '100' })])
      await compliance(bank, approvals).ops.publishTransferTerms({ ...input, ...approvals.issue(input) });
    expect(await stored()).toEqual(
      expect.arrayContaining([
        {
          asset_id: 'USDT',
          per_transfer_limit: '100.000000000000000000',
          daily_limit: '1000.000000000000000000',
          fee: '0.000000000000000000',
        },
        { asset_id: 'USDC', per_transfer_limit: '5.000000000000000000', daily_limit: '5.000000000000000000', fee: '0.000000000000000000' },
      ]),
    );
    expect(await stored()).toHaveLength(2);
  });

  it('refuses with no approval, or an approval bound to other figures, and writes nothing', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms();
    await expect(compliance(bank, approvals).ops.publishTransferTerms(input)).rejects.toThrow();
    await expect(
      compliance(bank, approvals).ops.publishTransferTerms({ ...input, ...approvals.issue({ ...input, dailyLimit: '1000000' }) }),
    ).rejects.toThrow();
    expect(await stored()).toHaveLength(0);
  });

  it('refuses zero, negative or inverted limits before spending the approval', async () => {
    const bank = services();
    const approvals = deskApprovals();
    for (const bad of [terms({ perTransferLimit: '0' }), terms({ dailyLimit: '0' }), terms({ perTransferLimit: '1001' })]) {
      await expect(compliance(bank, approvals).ops.publishTransferTerms({ ...bad, ...approvals.issue(bad) })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('bank.personal_transfer_terms_invalid'),
      });
    }
    await expect(
      compliance(bank, approvals).ops.publishTransferTerms({ ...terms({ fee: '-1' }), ...approvals.issue(terms({ fee: '-1' })) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(approvals.consumed).toBe(0);
    expect(await stored()).toHaveLength(0);
  });

  it('needs admin:compliance', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const input = terms();
    for (const scopes of [['bank:write'], ['admin:treasury']])
      await expect(
        caller(bank, OPERATOR, scopes, approvals).ops.publishTransferTerms({ ...input, ...approvals.issue(input) }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    expect(approvals.consumed).toBe(0);
  });
});
