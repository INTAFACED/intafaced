// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every call the room sent. */
const calls: Array<{ kind: string; target: string; body?: unknown }> = [];
let doorOff = false;
let connected = false;

const ACCOUNT = {
  accountId: '11111111-1111-4111-8111-111111111111',
  status: 'open',
  owner: '0x00000000000000000000000000000000000000aa',
  subAccount: '0x00000000000000000000000000000000000000bb',
  name: 'assistant-111111111111',
  asset: 'USDC',
  cap: '200.00',
  room: '50.00',
  balances: { asOf: '2026-11-14T00:00:00.000Z', value: [{ asset: 'USDC', free: '150', locked: '0', total: '150.00' }] },
  next: null,
  test: true,
};
const KEY_ID = '22222222-2222-4222-8222-222222222222';
const RECORD = {
  id: KEY_ID,
  name: 'TEST assistant',
  prefix: 'ifc_agent_TEST',
  scopes: ['trade:read', 'trade:write'],
  kind: 'agent',
  revoked: false,
};

vi.mock('../session/session', () => {
  const api = {
    rest: async (path: string, _schema: unknown, opts: { method?: string; body?: unknown } = {}) => {
      calls.push({ kind: opts.method ?? 'GET', target: path, body: opts.body });
      if (doorOff) return { ok: false, reason: 'not_mounted', message: 'off', code: 'trade.user_venue_off' };
      if (path === '/venue/agent-accounts/terms') return { ok: true, data: { ceiling: '1000.00', asset: 'USDC' } };
      if (path === '/venue/agent-accounts') return { ok: true, data: { accounts: [ACCOUNT] } };
      if (path === '/venue/agent-accounts/connections')
        return {
          ok: true,
          data: { connections: connected ? [{ keyId: KEY_ID, accountId: ACCOUNT.accountId, subAccount: ACCOUNT.subAccount }] : [] },
        };
      if (path === `/venue/agent-accounts/${ACCOUNT.accountId}/connections`) {
        connected = true;
        return { ok: true, data: { keyId: KEY_ID, accountId: ACCOUNT.accountId, subAccount: ACCOUNT.subAccount } };
      }
      return { ok: false, reason: 'error', message: 'unexpected' };
    },
    query: async (_m: string, procedure: string) => {
      calls.push({ kind: 'query', target: procedure });
      if (procedure === 'developerKeys.list') return { ok: true, data: { keys: [] } };
      return { ok: false, reason: 'error', message: 'unexpected' };
    },
    mutate: async (_m: string, procedure: string, input: { scopes: string[]; kind: string }) => {
      calls.push({ kind: 'mutate', target: procedure, body: input });
      if (procedure === 'developerKeys.create') {
        if (input.scopes.includes('trade:withdraw'))
          return { ok: false, reason: 'error', message: 'An agent key cannot hold …', code: 'auth.agent_scope_forbidden' };
        return { ok: true, data: { record: RECORD, key: 'ifc_agent_TEST_key', signingSecret: 'TEST_signing_secret' } };
      }
      return { ok: false, reason: 'error', message: 'unexpected' };
    },
  };
  return { useSession: () => ({ api, userId: 'user-1' }) };
});
vi.mock('../session/webauthn', () => ({
  requestPasskeyAssertion: async () => ({ ok: true, data: { id: 'TEST' } }),
}));
// Step-up is its own tested component (StepUpConfirm); here it answers at once with one approval.
vi.mock('../money/StepUpConfirm', () => ({
  StepUpConfirm: ({ onApproved, request }: { onApproved: (id: string) => void; request: () => { scope: string } }) => (
    <button type="button" data-scope={request().scope} onClick={() => onApproved('approval-1')}>
      TEST confirm
    </button>
  ),
}));
vi.mock('../protocol/wallet/WalletProvider', () => ({
  useWallet: () => ({ status: 'disconnected', address: null, sign: async () => ({ status: 'rejected' }) }),
}));

const { AgentConnect } = await import('./AgentConnect');

/** Lets every answer the mocked services already gave reach the page: they resolve as microtasks, never on a clock. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

async function render() {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<AgentConnect />));
  await settle();
  return host;
}
const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
async function click(el: HTMLElement) {
  await act(async () => el.click());
  await settle();
}

describe('Connect your assistant (J-agents-21 #2, #6)', () => {
  beforeEach(() => {
    calls.length = 0;
    doorOff = false;
    connected = false;
  });

  it('says what the assistant can and cannot do, the owner ceiling, and offers Create agent account', async () => {
    const host = await render();
    expect(host.querySelector('[data-testid="agent-connect__can"]')?.textContent).toContain(
      'Trade spot and perps in its own agent account',
    );
    const cannot = host.querySelector('[data-testid="agent-connect__cannot"]')?.textContent ?? '';
    for (const word of ['Move money', 'Withdraw', 'Bank', 'Pay', 'Use cards']) expect(cannot).toContain(word);
    expect(host.querySelector('[data-testid="agent-connect__ceiling"]')?.textContent).toContain('1000.00 USDC');
    expect(button(host, 'Create agent account')).toBeTruthy();
    expect(host.querySelector('[data-testid="agent-connect__accounts"]')?.textContent).toContain('150.00 USDC');
  });

  it('with the venue door off still shows the room, its Create control switched off and why', async () => {
    doorOff = true;
    const host = await render();
    expect(host.querySelector('[data-testid="agent-connect__cannot"]')).toBeTruthy();
    expect(host.textContent).toContain('venue connection is off');
    expect(button(host, 'Create agent account').disabled).toBe(true);
  });

  it('Create agent account with no wallet connected says so and sends nothing', async () => {
    const host = await render();
    await click(button(host, 'Create agent account'));
    const form = host.querySelector('[data-testid="agent-connect__create"] form') as HTMLFormElement;
    (form.querySelector('input[name=cap]') as HTMLInputElement).value = '200';
    (form.querySelector('input[name=fund]') as HTMLInputElement).value = '150';
    const before = calls.length;
    await act(async () => form.requestSubmit());
    expect(host.querySelector('[data-testid="agent-connect__create"] [role=alert]')?.textContent).toContain('Connect the wallet');
    expect(calls.slice(before).filter((c) => c.kind === 'POST')).toEqual([]);
  });

  it('refuses a withdraw scope at create, then binds a trade-only agent key and shows its secret and MCP setup once', async () => {
    const host = await render();
    const form = () => host.querySelector('[data-testid="agent-connect__connect"] form') as HTMLFormElement;
    (form().querySelector('input[name=name]') as HTMLInputElement).value = 'TEST assistant';
    const withdraw = form().querySelector('input[value="trade:withdraw"]') as HTMLInputElement;
    await click(withdraw);
    await act(async () => form().requestSubmit());
    await settle();
    expect(host.querySelector('[data-testid="agent-connect__refusal"]')?.textContent).toContain('auth.agent_scope_forbidden');
    expect(calls.some((c) => c.target.endsWith('/connections') && c.kind === 'POST')).toBe(false);

    await click(form().querySelector('input[value="trade:withdraw"]') as HTMLInputElement);
    (form().querySelector('input[name=name]') as HTMLInputElement).value = 'TEST assistant';
    await act(async () => form().requestSubmit());
    await settle();
    const created = calls.filter((c) => c.target === 'developerKeys.create').at(-1)?.body as { scopes: string[]; kind: string };
    expect(created).toMatchObject({ kind: 'agent', scopes: ['trade:read', 'trade:write'] });
    const confirm = button(host, 'TEST confirm');
    expect(confirm.dataset.scope).toBe('trade.step_up.venue.agentConnect');
    await click(confirm);
    expect(calls.find((c) => c.target === `/venue/agent-accounts/${ACCOUNT.accountId}/connections`)?.body).toEqual({
      keyId: KEY_ID,
      stepUpApprovalId: 'approval-1',
    });
    const secret = host.querySelector('[data-testid="agent-connect__secret"]')!;
    expect(secret.textContent).toContain('Agent');
    expect(host.querySelector('[data-testid="agent-connect__bound"]')?.textContent).toContain(ACCOUNT.name);
    expect(host.querySelector('[data-testid="agent-connect__scopes"]')?.textContent).toBe('Permissions: trade:read, trade:write');
    expect(host.querySelector('[data-testid="agent-connect__key"]')?.textContent).toBe('ifc_agent_TEST_key');
    const mcp = JSON.parse(host.querySelector('[data-testid="agent-connect__mcp"]')?.textContent ?? '{}');
    expect(mcp.mcpServers.intafaced.env).toMatchObject({
      INTAFACED_AGENT_KEY: 'ifc_agent_TEST_key',
      INTAFACED_AGENT_SIGNING_SECRET: 'TEST_signing_secret',
    });

    // Shown once: after Done the key is gone from the page; the connection is listed without it.
    await click(secret.querySelector('input[type=checkbox]') as HTMLInputElement);
    await click(button(host, 'Done'));
    expect(host.textContent).not.toContain('ifc_agent_TEST_key');
    expect(host.querySelector('[data-testid="agent-connect__connections"]')?.textContent).toContain(ACCOUNT.name);
  });
});
