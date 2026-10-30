import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { NO_TIER_LAWS } from '../tier-laws.js';
import { SUPPORT_DATA_TOOLS } from './data-tools.js';
import type { SupportDeskPort } from './desk-port.js';

const SECRET = 'an-agents-forwarded-principal-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

const principal = {
  sub: USER,
  userId: USER,
  sid: '22222222-2222-4222-8222-222222222222',
  scopes: ['agents:read'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 60_000),
} as Principal;

const law = { published: true as const, matrix: { basic: [...SUPPORT_DATA_TOOLS] } };

describe('support desk calls made for the user', () => {
  it('pass on the edge-signed principal unchanged and hold no signing secret', async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const desk: SupportDeskPort = {
      searchKb: async () => ({ status: 'unreachable' }),
      getKb: async () => ({ status: 'unreachable' }),
      readTicket: async (_id, headers) => {
        seen.push(headers);
        return { status: 'unreachable' };
      },
      readAccount: async () => ({ status: 'unreachable' }),
    };
    const deps: AgentsRouterDeps = {
      runtime: {} as AgentsRouterDeps['runtime'],
      gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
      meter: {} as AgentsRouterDeps['meter'],
      feeAssetId: 'IFC',
      tierLaws: { ...NO_TIER_LAWS, support: law },
      supportDesk: desk,
    };
    const raw = encodePrincipal(principal);
    const signature = signPrincipalHeader(raw, SECRET, 'DE');
    const ctx = edgeContext({
      headers: { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signature, 'x-intafaced-region': 'DE' },
      id: 'req-forward',
    });
    await createAgentsRouter(deps)
      .createCaller(ctx)
      .support.invokeDataTool({
        tool: 'support.ticket.read',
        plane: 'live',
        ticket: { ticketId: 'tkt-1', ownerUserId: USER, status: 'open', category: 'withdrawals' },
        occurredAt: '2026-08-07T22:00:00.000Z',
      });
    expect(seen).toEqual([{ 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signature, 'x-intafaced-region': 'DE' }]);
  });
});
