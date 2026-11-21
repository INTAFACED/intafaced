import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { UserVenue } from '@intafaced/venue-contracts';
import { AgentAccountError } from './agent-account.js';
import { InMemoryAgentAccountStore, NO_LIMITS } from './agent-account-store.js';
import { InMemoryAgentConnectionStore } from './agent-connection-store.js';
import { InMemoryAgentDeskAuditStore } from './agent-desk-store.js';
import { AgentDesk } from './agent-desk.js';
import { agentDeskAdminRouter } from './agent-desk-admin.js';
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
            errorCode: null,
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

const SECRET = 'an-agent-desk-answer-schema-test-edge-secret';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });
function founderContext() {
  const raw = encodePrincipal({
    sub: FOUNDER.userId,
    userId: FOUNDER.userId,
    sid: '66666666-6666-4666-8666-666666666666',
    scopes: ['admin:read', 'admin:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-agent-desk',
  });
}

describe('admin.agentDesk.* answer schemas (weed project-state#3594)', () => {
  it('send each answer exactly as the desk gave it: the schema strips and refuses nothing', async () => {
    const { desk } = await setup();
    const caller = agentDeskAdminRouter(desk).createCaller(founderContext());
    const quarantine = { keyId: KEY, reason: 'outside assistant misbehaving', requestId: 'req-quarantine-1' };
    expect(await caller.agentDesk.connections()).toStrictEqual(await desk.connections());
    expect(await caller.agentDesk.connection({ keyId: KEY })).toStrictEqual(await desk.connection(KEY));
    const sent = await caller.agentDesk.quarantine(quarantine);
    expect(sent.replayed).toBe(false);
    // The desk's own answer to the same call again is the replay of it: the same row, marked replayed.
    expect({ ...sent, replayed: true }).toStrictEqual(await desk.quarantine(FOUNDER, quarantine));
    expect(await caller.agentDesk.audit()).toStrictEqual(await desk.audit());
    // Unknown values and a quarantined row still leave whole.
    const unread = await setup({ keys: { read: async () => ({ state: 'unavailable' }) } as unknown as AgentKeyReader, venue: null });
    await unread.desk.quarantine(FOUNDER, quarantine);
    expect(await agentDeskAdminRouter(unread.desk).createCaller(founderContext()).agentDesk.connections()).toStrictEqual(
      await unread.desk.connections(),
    );
  });
});
