// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { OwnAgent, OwnAgentAnalytics, OwnAgentCatalogue, OwnAgentTestRun } from '@intafaced/contracts/agents-own';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every call the pages sent, and what svc-agents answers. */
const calls: Array<{ procedure: string; input: Record<string, unknown> }> = [];
/** When set, the next dry run's answer is lost on the way back (a gateway error): its outcome is unknown. */
let loseNext = false;

const CATALOGUE = {
  templates: [],
  tools: [
    {
      name: 'support.kb.search',
      module: 'support',
      movesMoney: false,
      dataClass: 'own_data',
      shape: { input: { kbQuery: 'text', limit: 'whole number' }, output: { articles: 'list' } },
      refusals: [],
    },
  ],
} as OwnAgentCatalogue;

const ALL = ['caps_set', 'tool_declared', 'moves_no_value', 'consent', 'baseline', 'rule', 'door_wired'] as const;
const dryRun = (requestId: string, input: Record<string, string>): OwnAgentTestRun => ({
  id: '33333333-3333-4333-8333-333333333333',
  requestId,
  kind: 'dry_run',
  tool: 'support.kb.search',
  input,
  checks: ALL.map((check) =>
    check === 'consent' && !input.limit ? { check, passed: false, code: 'agents.consent_required' } : { check, passed: true, code: null },
  ),
  effect: input.limit
    ? { kind: 'run', tool: 'support.kb.search', module: 'support', dataClass: 'own_data', input }
    : { kind: 'refused', tool: 'support.kb.search', code: 'agents.consent_required' },
  cost: '0',
  assetId: 'USDT',
  label: 'TEST',
  createdAt: '2026-11-04T16:00:00.000Z',
});
const analytics = (includeTest: boolean): OwnAgentAnalytics => ({
  includeTest,
  runs: includeTest ? 3 : 2,
  liveRuns: 2,
  executed: 1,
  refused: 1,
  failed: 0,
  testRuns: includeTest ? 1 : null,
  cost: '0.01',
  assetId: 'USDT',
});

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = {
    query: async (_service: string, procedure: string, input: Record<string, unknown>) => {
      calls.push({ procedure, input });
      if (procedure === 'own.catalogue') return { ok: true, data: structuredClone(CATALOGUE) };
      if (procedure === 'own.testRuns') return { ok: true, data: [dryRun('own-dry:a:v:1', { kbQuery: 'TEST', limit: '5' })] };
      if (procedure === 'own.analytics') return { ok: true, data: analytics(input.includeTest === true) };
      return { ok: false, reason: 'error', message: 'unexpected' };
    },
    mutate: async (_service: string, procedure: string, input: Record<string, unknown>) => {
      calls.push({ procedure, input });
      if (loseNext) {
        loseNext = false;
        return { ok: false, reason: 'unreachable', message: 'Gateway error' };
      }
      return { ok: true, data: dryRun(input.requestId as string, input.input as Record<string, string>) };
    },
  };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { AnalyticsPage, RunsPage, TestPanel } = await import('./AgentTestRuns');

const AGENT = { id: '11111111-1111-4111-8111-111111111111', name: 'TEST helper', tools: ['support.kb.search'] } as OwnAgent;

async function mount(node: React.ReactNode, ready: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await vi.waitFor(() => expect(host.textContent).toContain(ready));
  return host;
}
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
const field = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent === label)!.querySelector('input')!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (element: HTMLElement) => act(async () => element.click());
const dryRuns = () => calls.filter((call) => call.procedure === 'own.dryRun').map((call) => call.input);

describe('the dry run on the Test page (J-agents-04 #3)', () => {
  it('sends one call, shows the checks it passed and the would-be effect, and that nothing was made', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Dry run one call');
    await type(field(host, 'limit'), '5');
    await type(field(host, 'kbQuery'), 'TEST question');
    await click(button(host, 'Dry run one call'));
    const dry = await vi.waitFor(() => host.querySelector<HTMLElement>('[aria-label="Dry run"]')!);
    expect(dryRuns().at(-1)).toMatchObject({ id: AGENT.id, tool: 'support.kb.search', input: { kbQuery: 'TEST question', limit: '5' } });
    const passed = [...dry.querySelectorAll('[aria-label="Checks passed"] li')].map((li) => li.textContent);
    expect(passed).toHaveLength(7);
    expect(passed[0]).toBe('Your spending caps for this agent are set');
    expect(dry.querySelector('[aria-label="Checks not passed"]')).toBeNull();
    // The input in words by field name, whatever order it came back in.
    expect(dry.querySelector('[data-testid="dry-effect"]')!.textContent).toBe(
      'Would run “Search help articles” once in a new session of this agent, with kbQuery: TEST question; limit: 5: it reads support data and moves no value.',
    );
    expect(dry.querySelector('[data-testid="dry-cost"]')!.textContent).toBe('0 USDT');
    expect(dry.textContent).toContain('No entry, intent or reservation was made.');
  });

  it('names a failing check with its code, and the effect is that refusal', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Dry run one call');
    await click(button(host, 'Dry run one call'));
    expect(dryRuns().at(-1)).toMatchObject({ tool: 'support.kb.search', input: {} });
    const dry = await vi.waitFor(() => host.querySelector<HTMLElement>('[aria-label="Dry run"]')!);
    expect(dry.querySelector('[aria-label="Checks not passed"]')!.textContent).toBe(
      'You allowed this kind of tool agents.consent_required',
    );
    expect(dry.querySelector('[data-testid="dry-effect"]')!.textContent).toBe(
      'Would be refused at “You allowed this kind of tool”. agents.consent_required',
    );
  });

  it('a lost answer is sent again with the same request id; an edit makes the next a new one', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Dry run one call');
    loseNext = true;
    await click(button(host, 'Dry run one call'));
    await vi.waitFor(() => expect(host.textContent).not.toContain('Checks passed'));
    await click(button(host, 'Dry run one call'));
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Dry run"]')).not.toBeNull());
    const [lost, again] = dryRuns().slice(-2);
    expect(again!.requestId).toBe(lost!.requestId);
    await type(field(host, 'kbQuery'), 'TEST other');
    await click(button(host, 'Dry run one call'));
    await vi.waitFor(() => expect(dryRuns().at(-1)!.requestId).not.toBe(lost!.requestId));
  });
});

describe('the tool a dry run sends', () => {
  it('is one the agent carries now, never one it no longer carries', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<TestPanel agent={{ ...AGENT, tools: ['support.ticket.read', 'support.kb.search'] }} />));
    await vi.waitFor(() => expect(host.textContent).toContain('Dry run one call'));
    await act(async () => root.render(<TestPanel agent={AGENT} />));
    await click(button(host, 'Dry run one call'));
    await vi.waitFor(() => expect(dryRuns().at(-1)).toMatchObject({ tool: 'support.kb.search' }));
  });
});

describe('live and test runs apart (J-agents-04 #4)', () => {
  it('lists live and test runs on their own tabs, never together', async () => {
    const host = await mount(<RunsPage agent={AGENT} live={<p>LIVE LIST</p>} />, 'LIVE LIST');
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([
      ['Live runs', 'true'],
      ['Test runs', 'false'],
    ]);
    expect(host.textContent).not.toContain('Dry run');
    await click(tabs[1] as HTMLElement);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="test-run-label"]')?.textContent).toBe('TEST'));
    expect(host.textContent).not.toContain('LIVE LIST');
    expect(host.querySelector('[data-testid="test-run-cost"]')!.textContent).toBe('0 USDT');
  });

  it('asks for live analytics by default and adds test runs only when the box is ticked', async () => {
    const host = await mount(<AnalyticsPage agent={AGENT} />, 'Include test runs');
    const box = field(host, 'Include test runs');
    expect(box.checked).toBe(false);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="analytics-runs"]')?.textContent).toBe('2'));
    const asked = () => calls.filter((call) => call.procedure === 'own.analytics').map((call) => call.input.includeTest);
    expect(asked().at(-1)).toBe(false);
    await click(box);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="analytics-runs"]')?.textContent).toBe('3'));
    expect(asked().at(-1)).toBe(true);
    expect(host.querySelector('[data-testid="analytics-test-runs"]')!.textContent).toBe('1');
    expect(host.querySelector('[data-testid="analytics-cost"]')!.textContent).toBe('0.01 USDT');
  });
});
