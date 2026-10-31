// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const { WorkerDetailView } = await import('./MiningWorkerDetail');
const { WorkersView } = await import('./MiningRooms');
type Resource<T> = import('../../shared/resource').Resource<T>;
type WorkerOne = import('./mining-reads').WorkerOne;
type MinerWorkers = import('./mining-reads').MinerWorkers;
type ApiResult<T> = import('../../shared/api').ApiResult<T>;

const ID = 'worker:11111111-1111-4111-8111-111111111111:Rig-Q';
const ONE: WorkerOne = {
  asOf: '2026-10-31T00:01:00.000Z',
  id: ID,
  name: 'Rig-Q',
  windowMinutes: 60,
  hashing: 'hashing',
  hashrate: '3',
  hashrateReason: null,
  connectivity: 'online',
  lastShareAt: '2026-10-31T00:00:30.000Z',
  state: 'active',
  quietSeconds: 60,
  alertLimitMode: null,
  alertLimit: null,
  alertLimitReason: 'mining.alert_limit_unset',
  maintenanceSince: null,
};
const NO_CHANGES = {
  resource: { status: 'ready' as const, data: { asOf: ONE.asOf, evaluatedAt: null, rows: [] } },
  reload: () => undefined,
};

async function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, done: () => (root.unmount(), host.remove()) };
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === text) as HTMLButtonElement;

describe('mining worker room in the browser', () => {
  it('the alert panel stays mounted through the reload after a save, so "saved" still shows, and shows the new answer', async () => {
    let finish: (data: WorkerOne) => void = () => undefined;
    const onSet = vi.fn(async (): Promise<ApiResult<{ workerId: string; mode: 'manual'; manualLimit: string }>> => ({
      ok: true,
      data: { workerId: ID, mode: 'manual', manualLimit: '2.5' },
    }));
    function Harness() {
      const [resource, setResource] = useState<Resource<WorkerOne>>({ status: 'ready', data: ONE });
      finish = (data) => setResource({ status: 'ready', data });
      return (
        <WorkerDetailView
          worker={{ resource, reload: () => setResource({ status: 'loading' }) }}
          changes={NO_CHANGES}
          minutes={60}
          onSetAlertLimit={onSet}
        />
      );
    }
    const { host, done } = await mount(<Harness />);
    const manual = host.querySelector<HTMLInputElement>('input[value="manual"]')!;
    await act(async () => manual.click());
    const field = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '2.5');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(host, 'Save alert limit').click());
    expect(onSet).toHaveBeenCalledWith('manual', '2.5');
    // The worker read is loading again; the panel is still there and says the save worked.
    expect(host.querySelector('[data-testid="mining-worker-connectivity"]')).toBeNull();
    expect(host.querySelector('[data-testid="mining-worker-alert-limit"]')).not.toBeNull();
    expect(host.textContent).toContain('Alert limit saved');
    await act(async () => finish({ ...ONE, alertLimitMode: 'manual', alertLimit: '2.5', alertLimitReason: null }));
    expect(host.querySelector('[data-testid="mining-worker-alert-limit"]')?.getAttribute('data-mode')).toBe('manual');
    expect(host.querySelector('[data-testid="mining-worker-alert-limit"]')?.textContent).toBe('2.5');
    expect(host.textContent).toContain('Alert limit saved');
    done();
  });

  it('the alert panel keeps the last answer while a new window loads, and leaves when the read fails', async () => {
    let set: (resource: Resource<WorkerOne>) => void = () => undefined;
    function Harness() {
      const [resource, setResource] = useState<Resource<WorkerOne>>({ status: 'ready', data: ONE });
      set = setResource;
      return <WorkerDetailView worker={{ resource, reload: () => undefined }} changes={NO_CHANGES} minutes={60} />;
    }
    const { host, done } = await mount(<Harness />);
    await act(async () => set({ status: 'loading' }));
    expect(host.querySelector('[data-testid="mining-worker-alert-limit"]')?.getAttribute('data-code')).toBe('mining.alert_limit_unset');
    await act(async () =>
      set({ status: 'failed', failure: { ok: false, reason: 'error', message: 'x', code: 'mining.worker_not_found', status: 412 } }),
    );
    expect(host.querySelector('[data-testid="mining-worker-alert-limit"]')).toBeNull();
    done();
  });
});

describe('mining roster picks in the browser', () => {
  const row = (id: string, name: string) => ({
    id,
    name,
    createdAt: '2026-10-10T08:00:00.000Z',
    hashrate: null,
    hashrateReason: 'no_shares_in_window' as const,
    minDifficulty: null,
    mode: 'pooled' as const,
    state: 'offline' as const,
    stateReason: null,
  });
  const roster: MinerWorkers = {
    asOf: '2026-10-18T03:00:00.000Z',
    windowMinutes: 60,
    workers: [row('w1', 'rig-a'), row('w2', 'rig-b')],
    defaultDifficulty: null,
    defaultDifficultyReason: 'mining.default_difficulty_unset',
    nextCursor: 'c1',
  } as MinerWorkers;
  const read = { resource: { status: 'ready' as const, data: roster }, reload: () => undefined };
  const box = (host: HTMLElement, name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!;
  const tick = async (host: HTMLElement, name: string) => act(async () => box(host, name).click());

  it('clears the ticked workers on a page change, a filter change and after an applied maintenance change', async () => {
    const onSetMaintenance = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: { asOf: roster.asOf, rows: ids.map((workerId) => ({ workerId, since: roster.asOf })) },
    }));
    const onPage = vi.fn();
    const onFilter = vi.fn();
    const { host, done } = await mount(
      <WorkersView
        read={read}
        minutes={60}
        onMinutes={() => undefined}
        onPage={onPage}
        onFilter={onFilter}
        onSetMaintenance={onSetMaintenance}
      />,
    );
    const on = () => button(host, 'Put in maintenance');

    await tick(host, 'rig-a');
    expect(box(host, 'rig-a').checked).toBe(true);
    expect(on().disabled).toBe(false);
    await act(async () => button(host, 'Next page').click());
    expect(onPage).toHaveBeenCalledWith('c1');
    expect(box(host, 'rig-a').checked).toBe(false);
    expect(on().disabled).toBe(true);

    await tick(host, 'rig-b');
    const filter = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'rig');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onFilter).toHaveBeenCalledWith('rig');
    expect(box(host, 'rig-b').checked).toBe(false);
    expect(on().disabled).toBe(true);

    await tick(host, 'rig-a');
    await tick(host, 'rig-b');
    await act(async () => on().click());
    expect(onSetMaintenance).toHaveBeenCalledWith(['w1', 'w2'], true);
    expect(box(host, 'rig-a').checked).toBe(false);
    expect(box(host, 'rig-b').checked).toBe(false);
    expect(on().disabled).toBe(true);
    expect(host.querySelector('[data-testid="mining-maintenance-status"]')?.textContent).toContain('Maintenance saved. 2');
    done();
  });
});
