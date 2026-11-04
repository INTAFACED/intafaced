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
    { name: 'ledger.transfer', module: 'ledger', movesMoney: true, dataClass: null, shape: null, refusals: [] },
    { name: 'trade.place', module: 'trade', movesMoney: true, dataClass: null, shape: null, refusals: [] },
  ],
} as OwnAgentCatalogue;

const ALL = ['caps_set', 'tool_declared', 'moves_no_value', 'consent', 'baseline', 'rule', 'door_wired'] as const;
const dryRun = (requestId: string, input: Record<string, string>): OwnAgentTestRun => ({
  id: '33333333-3333-4333-8333-333333333333',
  requestId,
  kind: 'dry_run',
  mode: 'test',
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
const engineRun = (requestId: string, ask: string): OwnAgentTestRun => ({
  id: '44444444-4444-4444-8444-444444444444',
  requestId,
  kind: 'engine_run',
  mode: 'test',
  ask,
  reply: `TEST reply: ${ask}`,
  engine: 'test',
  liveEngine: 'live',
  log: [
    { step: 'asked', text: ask, label: 'TEST' },
    { step: 'answered', text: `TEST reply: ${ask}`, label: 'TEST' },
    { step: 'billed', text: '0 USDT', label: 'TEST' },
  ],
  cost: '0',
  assetId: 'USDT',
  label: 'TEST',
  createdAt: '2026-11-04T16:01:00.000Z',
});
const toolTest = (requestId: string, tool: string): OwnAgentTestRun => ({
  id: '55555555-5555-4555-8555-555555555555',
  requestId,
  kind: 'tool_test',
  mode: 'test',
  tool,
  input: {},
  checks: [{ check: 'moves_no_value', passed: false, code: 'agents.own.money_tool' }],
  effect: { kind: 'would_move', tool, module: tool.split('.')[0]!, input: {} },
  cost: '0',
  assetId: 'USDT',
  label: 'TEST',
  createdAt: '2026-11-04T16:02:00.000Z',
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
      if (procedure === 'own.testRuns')
        return {
          ok: true,
          data: [
            toolTest('own-tool-test:a:v:1', 'trade.place'),
            engineRun('own-test:a:v:1', 'TEST question'),
            dryRun('own-dry:a:v:1', { kbQuery: 'TEST', limit: '5' }),
          ],
        };
      if (procedure === 'own.analytics') return { ok: true, data: analytics(input.includeTest === true) };
      return { ok: false, reason: 'error', message: 'unexpected' };
    },
    mutate: async (_service: string, procedure: string, input: Record<string, unknown>) => {
      calls.push({ procedure, input });
      if (loseNext) {
        loseNext = false;
        return { ok: false, reason: 'unreachable', message: 'Gateway error' };
      }
      if (procedure === 'own.testRun') {
        if (!String(input.ask).trim()) return { ok: false, reason: 'error', message: 'agents.test.ask_blank' };
        return { ok: true, data: engineRun(input.requestId as string, input.ask as string) };
      }
      if (procedure === 'own.toolTest') return { ok: true, data: toolTest(input.requestId as string, input.tool as string) };
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

describe('a run on the test engine (J-agents-04 #1)', () => {
  it('sends the question and shows mode test, the test engine, billing 0, the reply and every log row labelled TEST', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Run a test');
    await type(field(host, 'Ask the agent'), 'TEST question');
    await click(button(host, 'Run a test'));
    const run = await vi.waitFor(() => host.querySelector<HTMLElement>('[aria-label="Engine run"]')!);
    expect(calls.filter((call) => call.procedure === 'own.testRun').at(-1)!.input).toMatchObject({ id: AGENT.id, ask: 'TEST question' });
    const text = (id: string) => run.querySelector(`[data-testid="${id}"]`)!.textContent;
    expect(text('run-mode')).toBe('Test');
    expect(text('run-engine')).toBe('Test engine');
    expect(text('live-engine')).toBe('Live model');
    expect(text('run-cost')).toBe('0 USDT');
    expect(run.querySelector('[aria-label="Reply"]')!.textContent).toBe('ReplyTEST TEST reply: TEST question');
    expect([...run.querySelectorAll('[data-testid="log-label"]')].map((cell) => cell.textContent)).toEqual(['TEST', 'TEST', 'TEST']);
  });

  it('a blank question is refused by name', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Run a test');
    await click(button(host, 'Run a test'));
    const alert = await vi.waitFor(() => host.querySelector<HTMLElement>('[role="alert"]')!);
    expect(alert.textContent).toBe('Write a question for the agent first. agents.test.ask_blank');
    expect(host.querySelector('[aria-label="Engine run"]')).toBeNull();
  });
});

describe('the request id a test press sends', () => {
  const sent = (procedure: string) => calls.filter((call) => call.procedure === procedure).map((call) => call.input);
  it('a lost run is sent again with the same request id; another question gets a new one', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Run a test');
    await type(field(host, 'Ask the agent'), 'TEST one');
    loseNext = true;
    await click(button(host, 'Run a test'));
    await click(button(host, 'Run a test'));
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Engine run"]')).not.toBeNull());
    const [lost, again] = sent('own.testRun').slice(-2);
    expect(again!.requestId).toBe(lost!.requestId);
    await type(field(host, 'Ask the agent'), 'TEST two');
    await click(button(host, 'Run a test'));
    await vi.waitFor(() => expect(sent('own.testRun').at(-1)!.ask).toBe('TEST two'));
    expect(sent('own.testRun').at(-1)!.requestId).not.toBe(lost!.requestId);
  });

  it('a lost tool test is sent again with the same request id; another tool gets a new one', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Test the action');
    loseNext = true;
    await click(button(host, 'Test the action'));
    await click(button(host, 'Test the action'));
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Would do"]')).not.toBeNull());
    const [lost, again] = sent('own.toolTest').slice(-2);
    expect(again).toEqual(lost);
    const select = [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.startsWith('Action that moves value'))!
      .querySelector('select')!;
    await act(async () => {
      select.value = 'trade.place';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button(host, 'Test the action'));
    await vi.waitFor(() => expect(sent('own.toolTest').at(-1)!.tool).toBe('trade.place'));
    expect(sent('own.toolTest').at(-1)!.requestId).not.toBe(lost!.requestId);
  });
});

describe('a test of a tool that would move value (J-agents-04 #2)', () => {
  it('offers only the tools that move value, and shows what one would do and that nothing was sent to the ledger', async () => {
    const host = await mount(<TestPanel agent={AGENT} />, 'Test the action');
    const select = [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.startsWith('Action that moves value'))!
      .querySelector('select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Transfer funds', 'Place an order']);
    await act(async () => {
      select.value = 'trade.place';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button(host, 'Test the action'));
    const would = await vi.waitFor(() => host.querySelector<HTMLElement>('[aria-label="Would do"]')!);
    expect(calls.filter((call) => call.procedure === 'own.toolTest').at(-1)!.input).toMatchObject({ id: AGENT.id, tool: 'trade.place' });
    expect(would.querySelector('[data-testid="would-effect"]')!.textContent).toBe(
      'Would place an order in trade in your name: it moves value.',
    );
    expect(would.querySelector('[data-testid="would-refused"] code')!.textContent).toBe('agents.own.money_tool');
    expect(would.querySelector('[data-testid="would-cost"]')!.textContent).toBe('0 USDT');
    expect(would.textContent).toContain('Nothing was sent to the ledger.');
  });
});

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
    expect([...host.querySelectorAll('[data-testid="test-run-cost"]')].map((cell) => cell.textContent)).toEqual(Array(3).fill('0 USDT'));
    // Every kind of test run in one list, each in its own words: what was tested and what it did or would do.
    const rows = [...host.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].slice(1, 4).map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['Tool test', 'Place an order', 'Would move value'],
      ['Test engine run', 'TEST question', 'Answered on the test engine'],
      ['Dry run', 'Search help articles', 'Would run'],
    ]);
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
