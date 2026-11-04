// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { OwnAgent, OwnAgentEvalRun, OwnAgentEvals } from '@intafaced/contracts/agents-own';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What svc-agents holds for the agent, and every start the page sent. */
let held: OwnAgentEvals;
const starts: Array<Record<string, unknown>> = [];
/** When set, the next start's answer is lost on the way back (a gateway error): its outcome is unknown. */
let loseNext = false;
const EMPTY: OwnAgentEvals = { testSet: [], latest: null, runs: [] };

const RUN: OwnAgentEvalRun = {
  id: '33333333-3333-4333-8333-333333333333',
  requestId: 'own-eval:a:visit:2',
  cases: [{ input: 'TEST case', expected: 'TEST answer' }],
  repeats: 2,
  threshold: '50',
  passed: 0,
  total: 2,
  score: '0',
  verdict: 'fail',
  label: 'TEST',
  results: [1, 2].map((repeat) => ({
    caseIndex: 0,
    repeat,
    input: 'TEST case',
    expected: 'TEST answer',
    reply: 'TEST reply: TEST case',
    passed: false,
    label: 'TEST' as const,
  })),
  createdAt: '2026-11-04T15:00:00.000Z',
};

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = {
    query: async () => ({ ok: true, data: structuredClone(held) }),
    mutate: async (_service: string, _procedure: string, input: Record<string, unknown>) => {
      starts.push(input);
      if (loseNext) {
        loseNext = false;
        return { ok: false, reason: 'unreachable', message: 'Gateway error' };
      }
      if (!input.threshold) return { ok: false, reason: 'error', message: 'agents.eval.threshold_unset' };
      const { cases, results: _results, ...summary } = RUN;
      held = { testSet: RUN.cases, latest: RUN, runs: [{ ...summary, cases: cases.length }] };
      return { ok: true, data: RUN };
    },
  };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { EvaluationsPage } = await import('./AgentEvaluations');

const AGENT = { id: '11111111-1111-4111-8111-111111111111', name: 'TEST helper' } as OwnAgent;

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<EvaluationsPage agent={AGENT} />));
  await vi.waitFor(() => expect(host.querySelector('[role="region"]')?.textContent).toContain('Start an evaluation'));
  return host;
}
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
const field = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll('label')].find((l) => label.test(l.querySelector('span')?.textContent ?? ''))!.querySelector('input')!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (el: HTMLElement) => act(async () => el.click());

describe("an own agent's Evaluations page", () => {
  it('warns while there is no test set, shows the refusal by name with no run, then the TEST results and the same run on send again', async () => {
    held = EMPTY;
    starts.length = 0;
    const host = await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This agent has no test set yet.');

    await click(button(host, 'Add a case'));
    await type(field(host, /^Case 1 input/), 'TEST case');
    await type(field(host, /^Case 1 expected/), 'TEST answer');
    await type(field(host, /^Repeats/), '2');
    await click(button(host, 'Start evaluation'));
    const refusal = host.querySelector('form [role="alert"]')!;
    await vi.waitFor(() => expect(refusal.textContent).toContain('Set a pass threshold first.'));
    expect(refusal.querySelector('code')?.textContent).toBe('agents.eval.threshold_unset');
    // The blank threshold went as typed: blank, never a default.
    expect(starts[0]).toMatchObject({ threshold: '', repeats: '2', cases: [{ input: 'TEST case', expected: 'TEST answer' }] });

    await type(field(host, /^Pass threshold/), '50');
    await click(button(host, 'Start evaluation'));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="eval-verdict"]')?.textContent).toBe('Fail'));
    expect(host.querySelector('[data-testid="eval-score"]')?.textContent).toBe('0%');
    expect([...host.querySelectorAll('[data-testid="result-label"]')].map((td) => td.textContent)).toEqual(['TEST', 'TEST']);
    expect(host.textContent).not.toContain('This agent has no test set yet.');
    // The saved test set is where the form starts again.
    expect(field(host, /^Case 1 input/).value).toBe('TEST case');
    expect(field(host, /^Case 1 expected/).value).toBe('TEST answer');
    // Two presses of Start are two request ids.
    expect(starts[1]!.requestId).not.toBe(starts[0]!.requestId);

    await click(button(host, 'Send again'));
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        `Sent again with request id ${RUN.requestId}: the service answered with the same run, so nothing ran twice.`,
      ),
    );
    expect(starts[2]).toEqual({ id: AGENT.id, requestId: RUN.requestId, cases: RUN.cases, repeats: '2', threshold: '50' });
  });

  it('sends a start whose answer was lost again as the same request; an edit makes the next start a new one', async () => {
    held = EMPTY;
    starts.length = 0;
    const host = await mount();
    await click(button(host, 'Add a case'));
    await type(field(host, /^Case 1 input/), 'TEST case');
    await type(field(host, /^Case 1 expected/), 'TEST answer');
    await type(field(host, /^Repeats/), '2');
    await type(field(host, /^Pass threshold/), '');
    // A clear refusal settles its request: the next press is a new one.
    await click(button(host, 'Start evaluation'));
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    await type(field(host, /^Pass threshold/), '50');
    loseNext = true;
    await click(button(host, 'Start evaluation'));
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]!.requestId).not.toBe(starts[0]!.requestId);
    // Its answer was lost: pressing Start again sends the same request id, so it can never run twice.
    await click(button(host, 'Start evaluation'));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="eval-verdict"]')).not.toBeNull());
    expect(starts[2]!.requestId).toBe(starts[1]!.requestId);
  });
});
