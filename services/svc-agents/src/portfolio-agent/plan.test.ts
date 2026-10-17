import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyPortfolioAuditLog } from './audit.js';
import { isPortfolioAgentKilled } from './kill-switch.js';
import { planRebalance } from './plan.js';
import type { PortfolioPort, TargetWeight } from './port.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AT = new Date('2026-08-16T12:00:00.000Z');

const SAME_PLANE_TARGETS: readonly TargetWeight[] = [
  { asset: 'IFC', plane: 'custodial', weight: '0.6' },
  { asset: 'USDT', plane: 'custodial', weight: '0.4' },
];

function livePort(weights: { asset: string; plane: 'custodial' | 'sovereign'; weight: string }[]): PortfolioPort {
  return {
    read: () => ({
      holdings: weights,
      unread: [],
    }),
  };
}

describe('planRebalance', () => {
  it('plans same-plane deltas without placing — status planned', () => {
    const { result, audit } = planRebalance(
      { userId: 'user-1', targets: SAME_PLANE_TARGETS },
      {
        killed: false,
        portfolio: livePort([
          { asset: 'IFC', plane: 'custodial', weight: '0.8' },
          { asset: 'USDT', plane: 'custodial', weight: '0.2' },
        ]),
        now: () => AT,
        audit: emptyPortfolioAuditLog(),
      },
    );
    expect(result).toEqual({
      status: 'planned',
      userId: 'user-1',
      legs: [
        {
          asset: 'IFC',
          plane: 'custodial',
          currentWeight: '0.8',
          targetWeight: '0.6',
          deltaWeight: '-0.2',
          intent: 'reduce',
        },
        {
          asset: 'USDT',
          plane: 'custodial',
          currentWeight: '0.2',
          targetWeight: '0.4',
          deltaWeight: '0.2',
          intent: 'increase',
        },
      ],
    });
    expect(audit.table).toBe('agent_actions');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.payload).toEqual(result);
    expect(audit.entries[0]?.status).toBe('executed');
  });

  it('missing owner targets → portfolio.target_unset and still audits', () => {
    const { result, audit } = planRebalance(
      { userId: 'user-1' },
      { killed: false, portfolio: livePort([{ asset: 'IFC', plane: 'custodial', weight: '1' }]), now: () => AT },
    );
    expect(result).toMatchObject({ status: 'refused', code: 'portfolio.target_unset' });
    expect(audit.entries[0]?.refusalCode).toBe('portfolio.target_unset');
  });

  it('does not invent equal-weight targets when the owner omitted them', () => {
    const { result } = planRebalance(
      { userId: 'user-1', targets: [] },
      {
        killed: false,
        portfolio: livePort([
          { asset: 'IFC', plane: 'custodial', weight: '0.5' },
          { asset: 'USDT', plane: 'custodial', weight: '0.5' },
        ]),
        now: () => AT,
      },
    );
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('portfolio.target_unset');
    expect(JSON.stringify(result)).not.toMatch(/0\.5/);
  });

  it('kill-switch off → portfolio.killed', () => {
    expect(isPortfolioAgentKilled({ AGENTS_PORTFOLIO_ENABLED: '0' })).toBe(true);
    const { result, audit } = planRebalance(
      { userId: 'user-1', targets: SAME_PLANE_TARGETS },
      { env: { AGENTS_PORTFOLIO_ENABLED: 'false' }, portfolio: livePort([]), now: () => AT },
    );
    expect(result).toMatchObject({ status: 'refused', code: 'portfolio.killed' });
    expect(audit.entries).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/"status":"(placed|held)"/);
  });

  it('unset / empty kill-switch is killed (default off)', () => {
    expect(isPortfolioAgentKilled({})).toBe(true);
    expect(isPortfolioAgentKilled({ AGENTS_PORTFOLIO_ENABLED: '' })).toBe(true);
    const { result } = planRebalance(
      { userId: 'user-1', targets: SAME_PLANE_TARGETS },
      { env: {}, portfolio: livePort([{ asset: 'IFC', plane: 'custodial', weight: '1' }]), now: () => AT },
    );
    expect(result).toMatchObject({ status: 'refused', code: 'portfolio.killed' });
  });
});

describe('honesty: dark port, unread ≠ zero, no placeOrder, cross-plane', () => {
  it('unset PortfolioPort is a named dark refuse — no invented zeros', () => {
    const { result, audit } = planRebalance({ userId: 'user-1', targets: SAME_PLANE_TARGETS }, { killed: false, now: () => AT });
    expect(result).toMatchObject({ status: 'refused', code: 'portfolio.port_dark' });
    expect(JSON.stringify(result)).not.toMatch(/"weight":"0"/);
    expect(audit.entries[0]?.payload).toEqual(expect.objectContaining({ code: 'portfolio.port_dark' }));
  });

  it('an empty-asset holding refuses unread and does not emit the increase its weight would fund', () => {
    const { result, audit } = planRebalance(
      {
        userId: 'user-1',
        targets: [{ asset: 'USDT', plane: 'custodial', weight: '1' }],
      },
      {
        killed: false,
        portfolio: livePort([
          { asset: '', plane: 'custodial', weight: '0.4' },
          { asset: 'USDT', plane: 'custodial', weight: '0.6' },
        ]),
        now: () => AT,
      },
    );
    expect(result).toEqual({
      status: 'refused',
      code: 'portfolio.holding_unread',
      userMessageKey: 'agents.refused.module_not_allowed',
    });
    expect(audit.entries[0]?.payload).toEqual({
      status: 'refused',
      code: 'portfolio.holding_unread',
      userMessageKey: 'agents.refused.module_not_allowed',
      userId: 'user-1',
      unread: [{ asset: '', plane: 'custodial', weight: '0.4', reason: 'empty_asset' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/"intent":"increase"/);
    expect(JSON.stringify(audit.entries[0]?.payload)).not.toMatch(/"intent":"increase"/);
  });

  it('zero-as-absent is not used: unread holdings refuse, they are not weight 0', () => {
    const port: PortfolioPort = {
      read: () => ({
        holdings: [{ asset: 'USDT', plane: 'custodial', weight: '1' }],
        unread: [{ asset: 'IFC', plane: 'sovereign', reason: 'indexer.readmodels_dark' }],
      }),
    };
    const { result } = planRebalance({ userId: 'user-1', targets: SAME_PLANE_TARGETS }, { killed: false, portfolio: port, now: () => AT });
    expect(result).toMatchObject({ status: 'refused', code: 'portfolio.holding_unread' });
    expect(JSON.stringify(result)).not.toContain('"weight":"0"');
    expect(JSON.stringify(result)).not.toMatch(/IFC.\{[^}]*weight/);
  });

  it('rebalance inside each plane with both plane totals unchanged is planned', () => {
    const { result } = planRebalance(
      {
        userId: 'user-1',
        targets: [
          { asset: 'IFC', plane: 'custodial', weight: '0.2' },
          { asset: 'USDT', plane: 'custodial', weight: '0.4' },
          { asset: 'IFC', plane: 'sovereign', weight: '0.1' },
          { asset: 'USDT', plane: 'sovereign', weight: '0.3' },
        ],
      },
      {
        killed: false,
        portfolio: livePort([
          { asset: 'IFC', plane: 'custodial', weight: '0.4' },
          { asset: 'USDT', plane: 'custodial', weight: '0.2' },
          { asset: 'IFC', plane: 'sovereign', weight: '0.3' },
          { asset: 'USDT', plane: 'sovereign', weight: '0.1' },
        ]),
        now: () => AT,
      },
    );
    expect(result).toEqual({
      status: 'planned',
      userId: 'user-1',
      legs: [
        {
          asset: 'IFC',
          plane: 'custodial',
          currentWeight: '0.4',
          targetWeight: '0.2',
          deltaWeight: '-0.2',
          intent: 'reduce',
        },
        {
          asset: 'USDT',
          plane: 'custodial',
          currentWeight: '0.2',
          targetWeight: '0.4',
          deltaWeight: '0.2',
          intent: 'increase',
        },
        {
          asset: 'IFC',
          plane: 'sovereign',
          currentWeight: '0.3',
          targetWeight: '0.1',
          deltaWeight: '-0.2',
          intent: 'reduce',
        },
        {
          asset: 'USDT',
          plane: 'sovereign',
          currentWeight: '0.1',
          targetWeight: '0.3',
          deltaWeight: '0.2',
          intent: 'increase',
        },
      ],
    });
  });

  it('cross-plane (custodial → sovereign) refuses — does not invent a bridge', () => {
    const { result, audit } = planRebalance(
      {
        userId: 'user-1',
        targets: [
          { asset: 'IFC', plane: 'sovereign', weight: '0.5' },
          { asset: 'USDT', plane: 'custodial', weight: '0.5' },
        ],
      },
      {
        killed: false,
        portfolio: livePort([{ asset: 'USDT', plane: 'custodial', weight: '1' }]),
        now: () => AT,
      },
    );
    expect(result).toMatchObject({ status: 'refused', code: 'portfolio.cross_plane_blocked' });
    expect(audit.entries[0]?.refusalCode).toBe('portfolio.cross_plane_blocked');
  });

  it('plan tree has no placeOrder, no hold, and no ledger post', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const src = files.map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n');
    const planOnly = files
      .filter((f) => f !== 'holdings.ts' && f !== 'trade-prices.ts')
      .map((f) => readFileSync(join(HERE, f), 'utf8'))
      .join('\n');
    expect(src).not.toMatch(/\bplaceOrder\s*\(/);
    expect(src).not.toMatch(/\bholdOrder\s*\(/);
    expect(src).not.toMatch(/\bholdFunds\s*\(/);
    expect(src).not.toMatch(/\bholdBalance\b/);
    expect(planOnly).not.toMatch(/ledger-client/);
    expect(src).not.toMatch(/createLedgerClient/);
    expect(src).not.toMatch(/\.post\s*\(/);
    expect(src).not.toMatch(/trade\.order/);
    expect(src).not.toMatch(/export (async )?function (place|hold)\b/);
  });
});
