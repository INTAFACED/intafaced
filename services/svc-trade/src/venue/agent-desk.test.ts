import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { UserVenue } from '@intafaced/venue-contracts';
import { AgentAccountError } from './agent-account.js';
import { InMemoryAgentAccountStore, NO_LIMITS } from './agent-account-store.js';
import { InMemoryAgentConnectionStore } from './agent-connection-store.js';
import { InMemoryAgentDeskAuditStore } from './agent-desk-store.js';
import { AgentDesk } from './agent-desk.js';
import type { AgentKeyCallReader, AgentKeyReader } from './agent-key-read-client.js';

// J-agents-21 #15: the founder's desk over every outside connection, and its quarantine.

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const OTHER_KEY = '44444444-4444-4444-8444-444444444444';
const FOUNDER = { userId: '55555555-5555-4555-8555-555555555555' } as Principal;
const T0 = new Date('2026-11-14T01:00:00Z');

async function setup(opts: { keys?: AgentKeyReader; calls?: AgentKeyCallReader; venue?: UserVenue | null } = {}) {
  const accounts = new InMemoryAgentAccountStore();
  const connections = new InMemoryAgentConnectionStore();
  const audit = new InMemoryAgentDeskAuditStore();
  await accounts.insertOnce(
    {
      userId: USER,
      accountId: ACCOUNT,
      venueId: 'test-venue',
      owner: '0xabc',
      subAccount: '0xsub',
      name: 'agent-1',
      asset: 'USDC',
      cap: parseAmount('200'),
      limits: NO_LIMITS,
      agentAddress: '0xagent',
      fundAmount: parseAmount('100'),
      status: 'open',
      createdAt: T0,
      openedAt: T0,
      closedAt: null,
    },
    {
      userId: USER,
      accountId: ACCOUNT,
      moveId: ACCOUNT,
      direction: 'into_sub_account',
      amount: parseAmount('100'),
      state: 'done',
      createdAt: T0,
    },
  );
  await connections.connectOnce({ keyId: KEY, userId: USER, accountId: ACCOUNT, createdAt: T0, endedAt: null });
  const venue =
    opts.venue === undefined
      ? ({
          venue: { id: 'test-venue', displayName: 'TEST venue', test: true },
          balances: async () => ({
            value: [{ asset: 'USDC', free: parseAmount('80'), locked: parseAmount('20'), total: parseAmount('100') }],
          }),
        } as unknown as UserVenue)
      : opts.venue;
  const desk = new AgentDesk({
    connections,
    accounts,
    audit,
    keys: opts.keys ?? { read: async (_u, keyId) => ({ state: 'found', keyId, kind: 'agent', scopes: ['trade:write'], revoked: false }) },
    calls: opts.calls ?? {
      calls: async (_u, keyId) => ({
        state: 'found',
        keyId,
        asOf: T0.toISOString(),
        calls: [
          {
            requestId: 'r1',
            method: 'POST',
            path: '/api/v1/venue/agent-accounts/orders',
            status: 200,
            outsideIpList: false,
            at: T0.toISOString(),
          },
        ],
      }),
    },
    venue: venue ? async () => venue : null,
    now: () => T0,
  });
  return { desk, connections, audit };
}

describe('AgentDesk (J-agents-21 #15)', () => {
  it('lists each connection with its person, cap, balance as the venue reports it, key state and last action', async () => {
    const { desk } = await setup();
    const view = await desk.connections();
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      keyId: KEY,
      userId: USER,
      accountId: ACCOUNT,
      cap: '200',
      asset: 'USDC',
      balance: { known: true, value: '100' },
      keyState: 'live',
      lastAction: { known: true, value: { method: 'POST', path: '/api/v1/venue/agent-accounts/orders', status: 200 } },
      quarantine: null,
      endedAt: null,
    });
    expect(view.more).toBe(false);
  });

  it('reads unknown, never a guess, when identity or the venue does not answer', async () => {
    const { desk } = await setup({
      keys: { read: async () => null },
      calls: { calls: async () => null },
      venue: null,
    });
    const [row] = (await desk.connections()).rows;
    expect(row).toMatchObject({ keyState: 'unknown', lastAction: { known: false }, balance: { known: false } });
  });

  it('quarantine ends the connection and writes one audit row naming the founder and the reason; a repeat reads it back', async () => {
    const { desk, connections, audit } = await setup();
    const first = await desk.quarantine(FOUNDER, { keyId: KEY, reason: 'TEST suspicious calls', requestId: 'agents-desk:q:1' });
    expect(first.replayed).toBe(false);
    expect(first.quarantine).toMatchObject({ operatorId: FOUNDER.userId, reason: 'TEST suspicious calls', keyId: KEY, userId: USER });
    expect(await connections.active(KEY)).toBeNull();
    const again = await desk.quarantine(FOUNDER, { keyId: KEY, reason: 'another reason', requestId: 'agents-desk:q:2' });
    expect(again.replayed).toBe(true);
    expect(again.quarantine.reason).toBe('TEST suspicious calls');
    expect(audit.rows).toHaveLength(1);
    const [row] = (await desk.connections()).rows;
    expect(row?.quarantine).toMatchObject({ operatorId: FOUNDER.userId, reason: 'TEST suspicious calls' });
    expect(row?.endedAt).toBe(T0.toISOString());
    expect((await desk.audit()).rows).toHaveLength(1);
  });

  it('refuses without a reason, for a bad request, and for a key that trades no agent account; nothing is written', async () => {
    const { desk, connections, audit } = await setup();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e instanceof AgentAccountError ? e.code : String(e)),
      );
    expect(await code(desk.quarantine(FOUNDER, { keyId: KEY, reason: ' ', requestId: 'agents-desk:q:1' }))).toBe(
      'agents.desk_reason_required',
    );
    expect(await code(desk.quarantine(FOUNDER, { keyId: 'nope', reason: 'TEST reason', requestId: 'agents-desk:q:1' }))).toBe(
      'agents.desk_request_invalid',
    );
    expect(await code(desk.quarantine(FOUNDER, { keyId: OTHER_KEY, reason: 'TEST reason', requestId: 'agents-desk:q:1' }))).toBe(
      'agents.key_not_connected',
    );
    expect(audit.rows).toHaveLength(0);
    expect(await connections.active(KEY)).not.toBeNull();
  });

  it('names the person of one key, by its newest connection, for the console to revoke at identity', async () => {
    const { desk } = await setup();
    expect(await desk.connection(KEY.toUpperCase())).toEqual({ keyId: KEY, userId: USER, accountId: ACCOUNT });
    await expect(desk.connection(OTHER_KEY)).rejects.toMatchObject({ code: 'agents.key_not_connected' });
    await expect(desk.connection('nope')).rejects.toMatchObject({ code: 'agents.desk_request_invalid' });
  });

  it('reads a key identity has no record of as missing, apart from a revoked one', async () => {
    const { desk } = await setup({ keys: { read: async () => ({ state: 'none' }) } });
    expect((await desk.connections()).rows[0]?.keyState).toBe('missing');
  });
});
