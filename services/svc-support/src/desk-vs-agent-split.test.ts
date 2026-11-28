import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_SUPPORT_ASSIST,
  DESK_DOES_NOT,
  DESK_OWNS,
  DESK_STAGE,
  OPS_SUPPORT_MOUNTAIN,
  deskVsAgentSplit,
} from './desk-vs-agent-split.js';
import { supportHealthHonesty, supportStoreHonesty } from './identity-grounding-honesty.js';
import { mountedSupportApp } from './testing/mounted-app.js';
import { describeSupportSettlement } from './settlement-refuse.js';

describe('D26-P1-O3 desk vs agent surface split', () => {
  it('names distinct mountains and keeps the desk standalone', () => {
    const split = deskVsAgentSplit();
    expect(split.deskMountain).toBe(OPS_SUPPORT_MOUNTAIN);
    expect(split.agentAssist).toBe(AGENTS_SUPPORT_ASSIST);
    expect(split.deskMountain).not.toBe(split.agentAssist);
    expect(split.deskStandalone).toBe(true);
    expect(split.stage).toBe(DESK_STAGE);
    expect(split.accountStateSource).toBe('svc-identity');
    expect(DESK_OWNS).toContain('ticket_events_audit');
    expect(DESK_DOES_NOT).toContain('invent_ledger_balances');
    expect(DESK_DOES_NOT).toContain('metered_agent_sessions');
  });

  it('the mounted /ready advertises the split, the settlement refusal and the honest identity and store states', async () => {
    const { app, get } = await mountedSupportApp('an-internal-service-secret-long-enough');
    const split = deskVsAgentSplit();
    const health = supportHealthHonesty({ serviceName: 'svc-support', identitySecret: 'an-internal-service-secret-long-enough' });
    const ready = await get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      ready: true,
      stage: split.stage,
      accountStateSource: split.accountStateSource,
      deskMountain: split.deskMountain,
      agentAssist: split.agentAssist,
      deskStandalone: split.deskStandalone,
      canSettle: describeSupportSettlement().canSettle,
      store: supportStoreHonesty(),
      identityGroundingWired: health.identityGroundingWired,
      identitySecretSet: health.identitySecretSet,
      identityGroundingRefuse: health.identityGroundingRefuse,
      identity: health.identity,
    });
    expect(ready.body.canSettle).toBe(false);
    await app.close();
  });

  it('desk service cannot reach the ledger client (no invent balances)', async () => {
    // Nothing in svc-support can import the ledger client: it is not a dependency, and pnpm resolves only declared ones.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('@intafaced/ledger-client');
    const ledgerClient = '@intafaced/ledger-client';
    await expect(import(/* @vite-ignore */ ledgerClient)).rejects.toThrow();
  });
});
