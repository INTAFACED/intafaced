import { describe, expect, it } from 'vitest';
import {
  ACTION_LOG_HEADER,
  actionLogRows,
  agentEnabled,
  agentUse,
  costRange,
  runCosts,
  sortCatalogue,
  AGENT_CATALOGUE,
  filterCatalogue,
  SESSION_AGENT_IDS,
  type ActionRow,
} from './agents-catalogue';
import { toCsv } from './depth-csv';

const row = (over: Partial<ActionRow>): ActionRow => ({
  id: 'a',
  sessionId: 's1',
  agentId: 'navigator',
  sequence: 0,
  kind: 'completion',
  status: 'executed',
  tool: null,
  task: 'chat',
  inputTokens: '10',
  outputTokens: '5',
  cost: '0.1',
  refusalCode: null,
  occurredAt: '2026-10-10T10:00:00.000Z',
  ...over,
});

describe('agent catalogue', () => {
  it('lists the five session agents first and marks the rest by how they are used', () => {
    expect(SESSION_AGENT_IDS).toEqual(['navigator', 'support', 'scanner', 'merchant', 'copy-intel']);
    expect(AGENT_CATALOGUE.find((a) => a.id === 'portfolio')?.kind).toBe('unwired');
    expect(AGENT_CATALOGUE.find((a) => a.id === 'risk-compliance')?.kind).toBe('staff');
  });
  it('filters by kind and by name or label', () => {
    const label = (id: string) => (id === 'coach' ? 'Curriculum coach' : id);
    expect(filterCatalogue(AGENT_CATALOGUE, { query: '', kind: 'session' }, label)).toHaveLength(5);
    expect(filterCatalogue(AGENT_CATALOGUE, { query: 'curriculum', kind: 'all' }, label).map((a) => a.id)).toEqual(['coach']);
    expect(filterCatalogue(AGENT_CATALOGUE, { query: 'nav', kind: 'room' }, label)).toEqual([]);
  });
});

describe('what this account used', () => {
  it('counts sessions and outcomes and adds cost exactly', () => {
    const use = agentUse([
      row({ id: '1', cost: '0.1' }),
      row({ id: '2', sequence: 1, cost: '0.2', status: 'refused' }),
      row({ id: '3', sessionId: 's2', cost: '0.3', status: 'failed', occurredAt: '2026-10-12T10:00:00.000Z' }),
      row({ id: '4', agentId: 'support', sessionId: 's3', occurredAt: '2026-10-13T10:00:00.000Z' }),
    ]);
    expect(use.map((u) => u.agentId)).toEqual(['support', 'navigator']);
    const nav = use.find((u) => u.agentId === 'navigator')!;
    expect(nav).toMatchObject({ sessions: 2, actions: 3, executed: 1, refused: 1, failed: 1, spend: '0.6' });
    expect(nav.lastUsed).toBe('2026-10-12T10:00:00.000Z');
  });
  it('is empty without rows', () => {
    expect(agentUse([])).toEqual([]);
  });
});

describe('action log export', () => {
  it('writes one record per action with the header', () => {
    const csv = toCsv(ACTION_LOG_HEADER, actionLogRows([row({ tool: '=cmd' })]));
    expect(csv.split('\r\n')[0]).toBe(ACTION_LOG_HEADER.join(','));
    expect(csv).toContain("'=cmd");
  });
});

describe('catalogue status, sort and run history', () => {
  const stored = [
    { agentId: 'navigator', name: null, purpose: null, enabled: true, version: 1 },
    { agentId: 'support', name: null, purpose: null, enabled: false, version: 2 },
  ];
  it('takes a session agent’s status from its stored row, and an unstored one cannot be used', () => {
    const byId = (id: string) => AGENT_CATALOGUE.find((agent) => agent.id === id)!;
    expect(agentEnabled(byId('navigator'), stored)).toBe(true);
    expect(agentEnabled(byId('support'), stored)).toBe(false);
    expect(agentEnabled(byId('scanner'), stored)).toBe(false);
    expect(agentEnabled(byId('coach'), stored)).toBe(true);
    expect(agentEnabled(byId('portfolio'), stored)).toBe(false);
    expect(agentEnabled(byId('risk-compliance'), stored)).toBe(false);
  });
  it('sorts by the shown name, or keeps the catalogue order', () => {
    const label = (id: string) => ({ navigator: 'Navigator', support: 'Support helper', coach: 'Curriculum coach' })[id] ?? id;
    const three = AGENT_CATALOGUE.filter((agent) => ['navigator', 'support', 'coach'].includes(agent.id));
    expect(sortCatalogue(three, 'name', label).map((agent) => agent.id)).toEqual(['coach', 'navigator', 'support']);
    expect(sortCatalogue(three, 'catalogue', label).map((agent) => agent.id)).toEqual(['navigator', 'support', 'coach']);
  });
  it('ranges only completed engine runs of that agent, exactly, and has no range without history', () => {
    const rows = [
      row({ id: '1', cost: '0.000000000000000001' }),
      row({ id: '2', cost: '0.25' }),
      row({ id: '3', cost: '9', status: 'refused' }),
      row({ id: '4', cost: '7', kind: 'tool_call' }),
      row({ id: '5', cost: '5', agentId: 'support' }),
    ];
    expect(costRange(runCosts(rows, 'navigator'))).toEqual({ low: '0.000000000000000001', high: '0.25' });
    expect(costRange(runCosts(rows, 'scanner'))).toBeNull();
  });
});
