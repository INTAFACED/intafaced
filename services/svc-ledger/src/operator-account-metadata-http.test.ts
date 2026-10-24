import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { issueAccessToken } from '@intafaced/auth';
import { LedgerError } from '@intafaced/ledger-client';
import { LOOKUP_INPUT_INVALID, LOOKUP_UNRECORDED, registerOperatorHttp } from './operator-http.js';
import { ActionApprovalConsumeError, stubApprovalConsumer, type ActionApprovalConsumer } from './ledger/action-approval-consume.js';
import {
  ACCOUNT_METADATA_INVALID,
  ACCOUNT_METADATA_STALE,
  ACCOUNT_NOT_FOUND,
  LEDGER_FROZEN,
  operatorAccountMetadataRead,
  type AccountMetadataOutput,
  type AccountMetadataReadInput,
} from './ledger/operator-account-metadata.js';
import type { LookupActor } from './ledger/operator-lookup.js';
import type { OperatorAccessEntry } from './ledger/operator-owner-balances.js';
import type { LedgerService } from './service.js';

/**
 * An account's operator metadata on the operator port (J-ops-console-03 #6, #7). The read takes the lookups' authority and
 * writes its access row first; the set and the delete are treasury writes; each metadata refusal keeps its own status,
 * with 412 for the posting freeze.
 */

const tokens = {
  secret: 'a-ledger-metadata-test-secret-long-enough!',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CHANGE = {
  seq: '7',
  key: 'desk.label',
  action: 'set' as const,
  before: null,
  after: 'TEST',
  revision: 1,
  requesterId: OPERATOR,
  approverId: null,
  reason: 'LOCAL TEST label for the desk',
  recordedAt: '2026-10-24T12:00:00.000Z',
};
const READ: AccountMetadataOutput = {
  accountId: ACCOUNT,
  address: 'house:fees:trade',
  entries: [{ key: 'desk.label', value: 'TEST', revision: 1, updatedAt: '2026-10-24T12:00:00.000Z', updatedBy: OPERATOR }],
  deleted: [],
  changes: [CHANGE],
  frozen: false,
};

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes, tier: 'basic', mfa },
    tokens,
  );
  return `Bearer ${token}`;
}

/** A fake service: the read goes through the real recorded wrapper; writes keep what they were handed or throw `fail`. */
async function desk(opts: { failAccess?: boolean; readError?: Error; writeError?: Error } = {}) {
  const access: OperatorAccessEntry[] = [];
  const reads: AccountMetadataReadInput[] = [];
  const sets: Array<{ actorId: string; input: unknown }> = [];
  const deletes: Array<{ approvals: ActionApprovalConsumer; operatorId: string; input: unknown }> = [];
  const approvals = stubApprovalConsumer('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  const reader = {
    recordOperatorAccess: async (entry: OperatorAccessEntry) => {
      if (opts.failAccess) throw new Error('access log down');
      access.push(entry);
    },
    readAccountMetadata: async (input: AccountMetadataReadInput) => {
      reads.push(input);
      if (opts.readError) throw opts.readError;
      return READ;
    },
  };
  const ledger = {
    deskAccountMetadata: (actor: LookupActor, input: AccountMetadataReadInput) => operatorAccountMetadataRead(reader, actor, input),
    setAccountMetadata: async (actorId: string, input: unknown) => {
      sets.push({ actorId, input });
      if (opts.writeError) throw opts.writeError;
      return { accountId: ACCOUNT, change: CHANGE };
    },
    deleteAccountMetadata: async (a: ActionApprovalConsumer, operatorId: string, input: unknown) => {
      deletes.push({ approvals: a, operatorId, input });
      if (opts.writeError) throw opts.writeError;
      return {
        accountId: ACCOUNT,
        change: { ...CHANGE, action: 'delete' as const, before: 'TEST', after: null, revision: 2, approverId: 'b' },
      };
    },
  } as unknown as LedgerService;
  const app: FastifyInstance = Fastify({ logger: false });
  registerOperatorHttp(app, ledger, tokens, approvals);
  await app.ready();
  return { app, access, reads, sets, deletes, approvals };
}

const url = `/operator/accounts/${ACCOUNT}/metadata`;

describe('GET /operator/accounts/:accountId/metadata', () => {
  it('answers the keys, the deleted keys and the changes after recording the read under the founder', async () => {
    const { app, access, reads } = await desk();
    const res = await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:read']) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(READ);
    expect(reads).toEqual([{ accountId: ACCOUNT }]);
    expect(access).toEqual([
      { actorId: OPERATOR, requestId: expect.any(String), ownerType: 'account', ownerId: ACCOUNT, action: 'account_metadata.read' },
    ]);
    await app.close();
  });

  it('refuses a malformed id before recording, an unknown account with 404, and an unrecorded read with nothing read', async () => {
    const authorization = await bearer(['admin:read']);
    const bad = await desk();
    const malformed = await bad.app.inject({ method: 'GET', url: '/operator/accounts/not-an-id/metadata', headers: { authorization } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: LOOKUP_INPUT_INVALID });
    expect(bad.access).toHaveLength(0);
    await bad.app.close();

    const missing = await desk({ readError: new LedgerError('No ledger account has that id.', ACCOUNT_NOT_FOUND) });
    const notFound = await missing.app.inject({ method: 'GET', url, headers: { authorization } });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ code: ACCOUNT_NOT_FOUND });
    await missing.app.close();

    const unrecorded = await desk({ failAccess: true });
    const refused = await unrecorded.app.inject({ method: 'GET', url, headers: { authorization } });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: LOOKUP_UNRECORDED });
    expect(unrecorded.reads).toHaveLength(0);
    await unrecorded.app.close();
  });

  it('refuses no credential and a sign-in without a second factor', async () => {
    const { app, reads } = await desk();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:read'], false) } })).statusCode).toBe(
      401,
    );
    expect(reads).toHaveLength(0);
    await app.close();
  });
});

describe('POST /operator/accounts/:accountId/metadata/set and /delete', () => {
  const body = { key: 'desk.label', value: 'TEST', reason: 'LOCAL TEST label for the desk', revision: 0 };

  it('hands the set the account from the path and the treasury operator as the actor', async () => {
    const { app, sets } = await desk();
    const res = await app.inject({
      method: 'POST',
      url: `${url}/set`,
      headers: { authorization: await bearer(['admin:treasury']) },
      // An account id in the body does not override the path.
      payload: { ...body, accountId: '33333333-3333-4333-8333-333333333333' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountId: ACCOUNT, change: { key: 'desk.label', after: 'TEST' } });
    expect(sets).toEqual([{ actorId: OPERATOR, input: { ...body, accountId: ACCOUNT } }]);
    await app.close();
  });

  it('hands the delete the identity approvals and the approval ids', async () => {
    const { app, deletes, approvals } = await desk();
    const payload = { key: 'desk.label', reason: 'LOCAL TEST label for the desk', revision: 1, approvalId: 'appr', operationId: 'op' };
    const res = await app.inject({
      method: 'POST',
      url: `${url}/delete`,
      headers: { authorization: await bearer(['admin:treasury']) },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ change: { action: 'delete', before: 'TEST', after: null } });
    expect(deletes).toEqual([{ approvals, operatorId: OPERATOR, input: { ...payload, accountId: ACCOUNT } }]);
    await app.close();
  });

  it('a lookup sign-in cannot write', async () => {
    const { app, sets, deletes } = await desk();
    const authorization = await bearer(['admin:read']);
    expect((await app.inject({ method: 'POST', url: `${url}/set`, headers: { authorization }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${url}/delete`, headers: { authorization }, payload: body })).statusCode).toBe(403);
    expect(sets).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    await app.close();
  });

  it('answers each refusal with its own status: frozen 412, stale 409, not found 404, invalid 400, a missing approval 400', async () => {
    const authorization = await bearer(['admin:treasury']);
    for (const [error, status] of [
      [new LedgerError('Ledger posting is frozen: LOCAL TEST', LEDGER_FROZEN), 412],
      [new LedgerError('desk.label changed after it was read', ACCOUNT_METADATA_STALE), 409],
      [new LedgerError('No ledger account has that id.', ACCOUNT_NOT_FOUND), 404],
      [new LedgerError('a key is lower case', ACCOUNT_METADATA_INVALID), 400],
      [new ActionApprovalConsumeError('approvalId and operationId are required', 'action_approval.missing'), 400],
    ] as const) {
      const { app } = await desk({ writeError: error });
      for (const path of ['set', 'delete']) {
        const res = await app.inject({ method: 'POST', url: `${url}/${path}`, headers: { authorization }, payload: body });
        expect(res.statusCode, `${path} ${error.code}`).toBe(status);
        expect(res.json()).toMatchObject({ code: error.code });
      }
      await app.close();
    }
  });
});
