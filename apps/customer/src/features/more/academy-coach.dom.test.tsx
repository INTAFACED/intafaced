// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { ok: true; data: unknown } | { ok: false; reason: string; message: string; code?: string };
const calls: Array<{ input: { question: string; requestId: string; lessonSlug?: string } }> = [];
let answers: Answer[] = [];
const route = {
  task: 'coach.answer',
  maxOutputTokens: 1024,
  inputPerMillion: '0',
  outputPerMillion: '0',
  assetId: 'IFC',
  engine: 'sandbox',
};

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = {
    query: async (_s: string, _p: string, _i: unknown, schema: { parse: (v: unknown) => unknown }) => ({
      ok: true,
      data: schema.parse([route]),
    }),
    mutate: async (_s: string, _p: string, input: (typeof calls)[number]['input'], schema: { parse: (v: unknown) => unknown }) => {
      calls.push({ input });
      const next = answers.shift()!;
      return next.ok ? { ok: true, data: schema.parse(next.data) } : next;
    },
  };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { AcademyCoach } = await import('./AcademyCoach');

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AcademyCoach lessonSlug="foundations-risk-first" />));
  await vi.waitFor(() => expect(host.querySelector('[data-testid="coach-cost"]')).not.toBeNull());
  const ask = async (text: string) => {
    const box = host.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('form')!.requestSubmit());
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent ?? '').not.toContain('Asking'));
  };
  return { host, ask, done: () => (root.unmount(), host.remove()) };
}

const answered = {
  status: 'answered',
  answer: 'TEST answer',
  citations: [{ slug: 'foundations-position-sizing', title: 'Position sizing without inventing numbers' }],
  nextLesson: { slug: 'foundations-invalidation-first', title: 'Invalidation before entry' },
  engine: 'sandbox',
  sessionId: '11111111-1111-4111-8111-111111111111',
  runKey: 'agents:run:11111111-1111-4111-8111-111111111111:coach:x',
  assetId: 'IFC',
  charge: { state: 'settled', billedAmount: '0' },
  replayed: false,
};

describe('Academy Coach panel (J-agents-17)', () => {
  it('shows the priced cost line marked TEST before anything is sent', async () => {
    calls.length = 0;
    const { host, done } = await mount();
    const cost = host.querySelector('[data-testid="coach-cost"]')!;
    expect(cost.textContent).toContain('Per million input tokens');
    expect(cost.querySelectorAll('.lit-test')).toHaveLength(2);
    expect(calls).toHaveLength(0);
    done();
  });

  it('answers with lesson links, the next lesson, and a TEST billed figure', async () => {
    answers = [{ ok: true, data: answered }];
    calls.length = 0;
    const { host, ask, done } = await mount();
    await ask('TEST why does position size matter?');
    const region = host.querySelector('[aria-label="Coach answer"]')!;
    expect([...region.querySelectorAll('ul a')].map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['/academy/foundations-position-sizing', 'Position sizing without inventing numbers'],
    ]);
    expect(region.querySelector('a[rel="next"]')!.getAttribute('href')).toBe('/academy/foundations-invalidation-first');
    expect(region.querySelector('[data-testid="coach-billed"] .lit-test')!.textContent).toBe('TEST');
    expect(calls[0]!.input).toMatchObject({ lessonSlug: 'foundations-risk-first', question: 'TEST why does position size matter?' });
    expect(calls[0]!.input.requestId).toMatch(/^coach:[0-9a-f]{32}$/);
    done();
  });

  it('says not covered with no citation list', async () => {
    answers = [{ ok: true, data: { status: 'not_covered', citations: [] } }];
    const { host, ask, done } = await mount();
    await ask('TEST how do rockets reach Mars?');
    const region = host.querySelector('[aria-label="Coach answer"]')!;
    expect(region.textContent).toContain('The curriculum does not cover this.');
    expect(region.querySelectorAll('a')).toHaveLength(0);
    done();
  });

  it.each([
    ['agents.advice_forbidden', 'The Coach does not give financial advice.'],
    ['agents.coach_engine_unavailable', 'The Coach engine is unavailable on this deployment.'],
    ['agents.request_id_replay', 'Ask in different words to get a new answer.'],
    ['agents.run_in_progress', 'The Coach is still answering this question.'],
  ])('maps the typed refusal %s to its words and shows the code', async (code, words) => {
    answers = [{ ok: true, data: { status: 'refused', code } }];
    const { host, ask, done } = await mount();
    await ask('TEST question');
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-refusal-code')).toBe(code);
    expect(alert.textContent).toContain(words);
    expect(alert.textContent).toContain(code);
    done();
  });

  it('maps a forbidden scope answer to its typed refusal', async () => {
    answers = [{ ok: false, reason: 'forbidden', message: 'agents.execute_scope_unset' }];
    const { host, ask, done } = await mount();
    await ask('TEST question');
    expect(host.querySelector('[role="alert"]')!.getAttribute('data-refusal-code')).toBe('agents.execute_scope_unset');
    done();
  });

  it('recovers a lost reply by re-reading with the same request id, never a new one', async () => {
    answers = [
      { ok: false, reason: 'uncertain', message: 'lost' },
      { ok: true, data: { ...answered, replayed: true } },
    ];
    calls.length = 0;
    const { host, ask, done } = await mount();
    await ask('TEST why does position size matter?');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('The answer did not arrive');
    const again = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Check again')!;
    await act(async () => again.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Coach answer"]')).not.toBeNull());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toEqual(calls[0]!.input);
    expect(host.textContent).toContain('This is the stored answer to the same question.');
    done();
  });
});
