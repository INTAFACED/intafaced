import { describe, expect, it } from 'vitest';
import {
  MODULES,
  MODULE_IDS,
  MONEY_KILL_RESIDUAL_DOOR_IDS,
  MONEY_PUBLIC_DOORS,
  assertCustodialMoneyKillsComplete,
  assertMoneyKillResidualsPresent,
  assertMoneyRoutesHaveKillMapping,
  edgeKillableMoneyModules,
  moneyKillControlFor,
  moneyRouteKillModules,
} from './index.js';

/** Live money prefixes as of this catalogue — fixtures, not a second route table. */
const LIVE_MONEY_UPSTREAMS = [
  { prefix: '/api/trade', module: 'trade' },
  { prefix: '/api/v1', module: 'trade' },
  { prefix: '/api/token', module: 'token' },
  { prefix: '/api/agents', module: 'agents' },
  { prefix: '/api/bank', module: 'bank' },
  { prefix: '/api/p2p', module: 'p2p' },
  { prefix: '/api/pay', module: 'pay' },
  { prefix: '/api/market', module: 'market' },
  { prefix: '/api/mining', module: 'mining-pool' },
] as const;

describe('money kill surface (D26-P2-10)', () => {
  it('lists at least one public door per live edge money module', () => {
    for (const module of edgeKillableMoneyModules()) {
      const doors = MONEY_PUBLIC_DOORS.filter((d) => d.module === module);
      expect(doors.length, `${module} must have a named money door`).toBeGreaterThan(0);
    }
  });

  it('every door path is under /api/ and uses a commitment method', () => {
    for (const door of MONEY_PUBLIC_DOORS) {
      expect(door.path.startsWith('/api/'), door.id).toBe(true);
      expect(['POST', 'PUT', 'PATCH', 'DELETE']).toContain(door.method);
      expect(door.what.length, door.id).toBeGreaterThan(8);
    }
  });

  it('door ids are unique', () => {
    const ids = MONEY_PUBLIC_DOORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every custodial module has an honest kill control — never silent', () => {
    expect(assertCustodialMoneyKillsComplete()).toEqual([]);
    for (const id of MODULE_IDS) {
      if (!MODULES[id].custodial) continue;
      const control = moneyKillControlFor(id);
      expect(control.kind, id).toBeTruthy();
    }
  });

  it('residual money families stay catalogued (deepen after #1683)', () => {
    expect(assertMoneyKillResidualsPresent()).toEqual([]);
    expect(MONEY_KILL_RESIDUAL_DOOR_IDS.length).toBeGreaterThan(10);
  });

  it('ledger is freeze-only — never a pretend module kill', () => {
    expect(moneyKillControlFor('ledger')).toEqual({
      kind: 'ledger-freeze',
      surface: '/admin/ledger/freeze',
    });
  });

  it('matching is halted by killing trade, not by a fake matching module flag', () => {
    expect(moneyKillControlFor('matching')).toMatchObject({
      kind: 'via-sibling',
      haltVia: 'trade',
    });
  });

  it('live money modules use the shared edge kill surface', () => {
    for (const module of ['trade', 'pay', 'bank', 'p2p', 'token', 'market', 'agents'] as const) {
      expect(moneyKillControlFor(module)).toEqual({ kind: 'edge-module', module });
    }
  });

  it('every live money edge prefix has a catalogue kill mapping', () => {
    expect(assertMoneyRoutesHaveKillMapping(LIVE_MONEY_UPSTREAMS)).toEqual([]);
    expect(moneyRouteKillModules()).toContain('pay');
    expect(moneyRouteKillModules()).toContain('agents');
  });

  it('refuses a new money prefix that has no catalogue kill mapping', () => {
    const failures = assertMoneyRoutesHaveKillMapping([...LIVE_MONEY_UPSTREAMS, { prefix: '/api/pay/v2', module: 'pay' }]);
    expect(failures.some((f) => f.includes('/api/pay/v2') && f.includes('no kill mapping'))).toBe(true);
  });

  it('refuses an undeployed custodial module that suddenly has an edge prefix', () => {
    const failures = assertMoneyRoutesHaveKillMapping([...LIVE_MONEY_UPSTREAMS, { prefix: '/api/launch', module: 'launch' }]);
    expect(failures.some((f) => f.includes('/api/launch') && f.includes('not-deployed'))).toBe(true);
  });

  it('refuses a mistyped edge module even when other money doors still match', () => {
    const failures = assertMoneyRoutesHaveKillMapping([...LIVE_MONEY_UPSTREAMS, { prefix: '/api/payy', module: 'payy' }]);
    expect(failures).toContain('money route prefix "/api/payy" names unknown module "payy" — no kill mapping');
  });

  it('refuses an empty upstream table (vacuous green is a hole)', () => {
    expect(assertMoneyRoutesHaveKillMapping([])).toEqual(['no edge upstreams provided — money-route kill mapping would pass vacuously']);
  });

  it('identity / academy prefixes are not money routes — no mapping required', () => {
    expect(
      assertMoneyRoutesHaveKillMapping([
        ...LIVE_MONEY_UPSTREAMS,
        { prefix: '/api/identity', module: 'identity' },
        { prefix: '/api/academy', module: 'academy' },
      ]),
    ).toEqual([]);
  });
});
