import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY_RECIPIENTS_ADD, IDENTITY_RECIPIENTS_LIST } from '@intafaced/contracts/identity-recipients-procedures';
import { AdminSessionError, founderEdgeCall, founderEdgeRecordCall, type AdminSessionConfig } from './founder-session.js';

/**
 * `founderEdgeRecordCall` is `founderEdgeCall` through the call's record: the call-records codemod
 * moves each `founderEdgeCall(config, module, path, method, input, token, signIn)` to
 * `founderEdgeRecordCall(config, RECORD, input, token, signIn)`, and nothing sent or answered changes.
 */
const config: AdminSessionConfig = { origin: 'https://admin.example.test', edgeUrl: 'https://edge.example.test', key: Buffer.alloc(32, 7) };
const ADDED = { handle: 'alice', label: 'Alice', addedAt: '2026-11-21T00:00:00.000Z' };

afterEach(() => vi.unstubAllGlobals());
function record(answer: () => Response) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', fn);
  return () => fn.mock.calls.map(([url, init]) => [url, { ...init, signal: undefined }]);
}

describe('founderEdgeRecordCall: founderEdgeCall through its record', () => {
  it('a read sends the same request with the same token and gets the same answer', async () => {
    const byName = record(() => Response.json({ result: { data: [ADDED] } }));
    const named = await founderEdgeCall(config, 'identity', 'recipients.list', 'GET', { limit: 5 }, 'token-1');
    const sentByName = byName();
    const byRecord = record(() => Response.json({ result: { data: [ADDED] } }));
    expect(await founderEdgeRecordCall(config, IDENTITY_RECIPIENTS_LIST, { limit: 5 }, 'token-1')).toEqual(named);
    expect(byRecord()).toEqual(sentByName);
    expect(sentByName[0]?.[0]).toBe(
      `https://edge.example.test/api/identity/trpc/recipients.list?input=${encodeURIComponent('{"limit":5}')}`,
    );
  });

  it("a write sends the same body and the sign-in browser's user-agent, as the call by name does", async () => {
    const input = { handle: 'alice', label: 'Alice', idempotencyKey: 'recipient-add-1' };
    const signIn = { userAgent: 'Browser TEST' };
    const byName = record(() => Response.json({ result: { data: { json: ADDED } } }));
    const named = await founderEdgeCall(config, 'identity', 'recipients.add', 'POST', input, undefined, signIn);
    const sentByName = byName();
    const byRecord = record(() => Response.json({ result: { data: { json: ADDED } } }));
    expect(await founderEdgeRecordCall(config, IDENTITY_RECIPIENTS_ADD, input, undefined, signIn)).toEqual(named);
    expect(byRecord()).toEqual(sentByName);
    expect(sentByName[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
  });

  it('a refusal throws as it did by name, and an answer the record refuses throws as an unreadable one', async () => {
    const refusal = () =>
      Response.json(
        { error: { message: 'no', data: { code: 'CONFLICT', cause: { code: 'identity.recipient_conflict' } } } },
        { status: 409 },
      );
    record(refusal);
    const named = await founderEdgeCall(config, 'identity', 'recipients.list', 'GET', {}).catch((e: unknown) => e);
    record(refusal);
    const recorded = await founderEdgeRecordCall(config, IDENTITY_RECIPIENTS_LIST, {}).catch((e: unknown) => e);
    expect(recorded).toBeInstanceOf(AdminSessionError);
    expect(recorded).toEqual(named);
    record(() => Response.json({ result: { data: [{ handle: 1 }] } }));
    await expect(founderEdgeRecordCall(config, IDENTITY_RECIPIENTS_LIST, {})).rejects.toMatchObject({
      code: 'admin.upstream_invalid',
      status: 502,
    });
  });
});
