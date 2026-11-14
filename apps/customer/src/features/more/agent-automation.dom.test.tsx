// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { OwnAgent, OwnAgentAutoRun, OwnAgentSchedule, OwnAgentSchedules, OwnAgentTrigger } from '@intafaced/contracts/agents-own';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What svc-agents holds for the agent, and every mutation the pages sent. */
let schedules: OwnAgentSchedules;
let triggers: OwnAgentTrigger[];
const sent: Array<{ procedure: string; input: Record<string, unknown> }> = [];

const RUN: OwnAgentAutoRun = {
  id: '44444444-4444-4444-8444-444444444444',
  runKey: 'agents:schedule:s:1',
  ordinal: 1,
  eventId: null,
  dueAt: '2026-11-13T21:00:00.000Z',
  state: 'ran',
  code: null,
  reasonCode: null,
  sessionId: '55555555-5555-4555-8555-555555555555',
  runs: 1,
  wakes: 2,
  cost: '0.0001',
  assetId: 'USDT',
  createdAt: '2026-11-13T21:00:00.000Z',
  updatedAt: '2026-11-13T21:00:01.000Z',
};
const SCHEDULE: OwnAgentSchedule = {
  id: '33333333-3333-4333-8333-333333333333',
  agentId: '11111111-1111-4111-8111-111111111111',
  repeat: 'repeat',
  intervalMinutes: 1,
  perRunCap: '0.1',
  ask: 'TEST check',
  state: 'active',
  nextDueAt: '2026-11-13T21:01:00.000Z',
  createdAt: '2026-11-13T21:00:00.000Z',
  recent: [
    {
      ...RUN,
      id: '66666666-6666-4666-8666-666666666666',
      ordinal: 2,
      state: 'skipped',
      code: 'agents.schedule_blocked',
      reasonCode: 'agents.schedule.cap_per_run_unset',
      runs: 0,
      wakes: 1,
      cost: null,
      sessionId: null,
    },
    RUN,
  ],
};

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const api = {
    query: async (_service: string, procedure: string) => ({
      ok: true,
      data: structuredClone(procedure === 'own.schedules.list' ? schedules : triggers),
    }),
    mutate: async (_service: string, procedure: string, input: Record<string, unknown>) => {
      sent.push({ procedure, input });
      if (procedure === 'own.schedules.create') {
        if (input.repeat === 'repeat' && !input.intervalMinutes) {
          return { ok: false, reason: 'error', message: 'agents.schedule.min_interval_unset' };
        }
        schedules = { ...schedules, schedules: [SCHEDULE] };
        return { ok: true, data: SCHEDULE };
      }
      if (procedure === 'own.schedules.cancel') {
        const cancelled = { ...SCHEDULE, state: 'cancelled' as const, nextDueAt: null };
        schedules = { ...schedules, schedules: [cancelled] };
        return { ok: true, data: cancelled };
      }
      return { ok: false, reason: 'error', message: 'agents.trigger_subject_invalid' };
    },
  };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { SchedulesPage, TriggersPage } = await import('./AgentAutomation');

const AGENT = { id: '11111111-1111-4111-8111-111111111111', name: 'TEST helper' } as OwnAgent;

async function mount(node: React.ReactNode, ready: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await vi.waitFor(() => expect(host.textContent).toContain(ready));
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
const testIds = (host: HTMLElement, id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)].map((el) => el.textContent);

describe("an own agent's Schedules page", () => {
  it('shows a blank interval refused by name, then the schedule with its occurrences, and cancels it', async () => {
    schedules = { cadence: { minIntervalMinutes: 1, dailyLimit: 100 }, schedules: [] };
    sent.length = 0;
    const host = await mount(<SchedulesPage agent={AGENT} />, 'No schedule yet.');

    await type(field(host, /^Cap per run/), '0.1');
    await type(field(host, /^Ask the agent/), 'TEST check');
    await click(button(host, 'Create schedule'));
    const refusal = host.querySelector('form [role="alert"]')!;
    await vi.waitFor(() => expect(refusal.textContent).toContain('Set the minimum interval between runs first.'));
    expect(refusal.querySelector('code')?.textContent).toBe('agents.schedule.min_interval_unset');
    // The blank interval went as typed: blank, never a default.
    expect(sent[0]!.input).toMatchObject({ repeat: 'repeat', intervalMinutes: '', perRunCap: '0.1' });

    await type(field(host, /^Minimum interval/), '1');
    await click(button(host, 'Create schedule'));
    await vi.waitFor(() => expect(testIds(host, 'schedule-status')).toEqual(['Active']));
    // A refused create settles its key: the next press is a new request.
    expect(sent[1]!.input.createKey).not.toBe(sent[0]!.input.createKey);
    expect(testIds(host, 'runs-for-occurrence')).toEqual(['0 runs', '1 run']);
    expect(testIds(host, 'wakes')).toEqual(['1 woke', '2 woke']);
    expect(testIds(host, 'occurrence-outcome')).toEqual(['Skipped: no cap per run agents.schedule_blocked', 'Ran']);

    await click(button(host, 'Cancel'));
    await vi.waitFor(() => expect(testIds(host, 'schedule-status')).toEqual(['Cancelled']));
    expect(testIds(host, 'next-occurrence')).toEqual(['None']);
    expect(button(host, 'Cancel')).toBeUndefined();
  });
});

describe("an own agent's Triggers page", () => {
  it('shows the first delivery of an event with its run and a redelivery of it as ignored', async () => {
    triggers = [
      {
        id: '77777777-7777-4777-8777-777777777777',
        agentId: AGENT.id,
        subject: 'trade.fill.settled',
        perRunCap: '0.1',
        ask: 'TEST',
        state: 'active',
        createdAt: '2026-11-13T21:00:00.000Z',
        runs: [{ ...RUN, ordinal: null, eventId: 'fill-1', runKey: 'agents:trigger:t:fill-1', wakes: 1 }],
        deliveries: [
          { eventId: 'fill-1', envelopeId: 'env-2', redelivered: true, receivedAt: '2026-11-13T21:00:02.000Z' },
          { eventId: 'fill-1', envelopeId: 'env-1', redelivered: false, receivedAt: '2026-11-13T21:00:01.000Z' },
        ],
      },
    ];
    const host = await mount(<TriggersPage agent={AGENT} />, 'An order of mine fills');
    expect(testIds(host, 'delivery-outcome')).toEqual(['Redelivered event ignored', 'Ran']);
    expect(testIds(host, 'runs-for-event')).toEqual(['—', '1 run']);
  });
});
