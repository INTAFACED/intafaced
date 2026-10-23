// @vitest-environment happy-dom
// The Layouts menu on the workbench: the preset switch writes the desk, and saving under a taken name asks before it replaces
// the layout that holds it. The account store is stubbed; the record it would hold is a TEST layout, not a published figure.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutsValue } from '@intafaced/contracts/layouts-preferences';
import { DEFAULT_DESK, PRESET_DESK } from './model';

const state = vi.hoisted(() => ({
  layouts: { status: 'ready', value: null as unknown, commit: null as unknown, reload: () => undefined } as Record<string, unknown>,
  templates: { status: 'ready', value: [] as unknown[], commit: null as unknown, reload: () => undefined } as Record<string, unknown>,
}));

vi.mock('../../../features/session/session', () => ({
  useSession: () => ({ userId: 'u1', api: { query: () => new Promise(() => undefined), mutate: () => new Promise(() => undefined) } }),
}));
vi.mock('./store', () => ({
  useLayoutRecord: () => state.layouts,
  useChartTemplates: () => state.templates,
  refusalWords: () => 'not-saved',
}));
vi.mock('../../../app/location', () => ({ navigate: vi.fn() }));
// The menu shows the market's last price; the test reads no feed, so the ticker is loading and the price line is absent.
vi.mock('../../../data', () => ({ useTickers: () => ({ status: 'loading' }), fmtPrice: () => '' }));

import { LayoutsMenu } from './LayoutsMenu';

const TEST_SNAPSHOT = {
  symbol: 'BTC/USDT',
  interval: '15m',
  mode: 'candles',
  scheme: 'standard',
  desk: PRESET_DESK.advanced,
  firstGroup: 'blue',
  grid: {
    layout: 'single',
    sync: { symbol: true, interval: true, crosshair: false, range: false },
    cells: [],
    sizes: { cols: [1, 1], rows: [1, 1] },
  },
  studies: [],
  drawings: null,
};

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  const record: LayoutsValue = {
    layouts: [{ id: 'layout-scalp', name: 'Scalp', savedAt: '2026-10-22T09:00:00.000Z', snapshot: TEST_SNAPSHOT as never }],
    deleted: [],
  };
  state.layouts = { status: 'ready', value: record, commit: vi.fn(async () => ({ ok: true })), reload: () => undefined };
  state.templates = { status: 'ready', value: [], commit: vi.fn(async () => ({ ok: true })), reload: () => undefined };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

function render(setDesk = vi.fn(), onRemount = vi.fn()) {
  root = createRoot(host);
  act(() =>
    root!.render(
      <LayoutsMenu
        workbench="main"
        symbol="BTC/USDT"
        markets={[]}
        setting={{ interval: '15m', mode: 'candles', scheme: 'standard' }}
        desk={DEFAULT_DESK}
        setDesk={setDesk}
        limits={{ drawingCap: 50, brushPointCap: 2000 }}
        onRemount={onRemount}
      />,
    ),
  );
  return { setDesk, onRemount };
}

const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
const click = (node: Element | undefined) => {
  if (!node) throw new Error('control not found');
  act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
/** Types into a text field the way a person does: the native value setter, then an input event React reads. */
function type(label: string, text: string) {
  const input = [...host.querySelectorAll('input')].find((node) => node.closest('label')?.textContent?.includes(label));
  if (!input) throw new Error(`field ${label} not found`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('LayoutsMenu', () => {
  it('switches the desk preset: Classic and Advanced write the desk, and the pressed one stays with the desk', () => {
    const { setDesk } = render();
    click(button('Layouts'));
    click(button('Classic'));
    expect(setDesk).toHaveBeenLastCalledWith({ ...PRESET_DESK.classic, side: 'right' });
    click(button('Advanced'));
    expect(setDesk).toHaveBeenLastCalledWith({ ...PRESET_DESK.advanced, side: 'right' });
    expect(host.querySelector('[data-preset="advanced"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the side the watchlist is on when the preset changes', () => {
    const { setDesk } = render();
    click(button('Layouts'));
    click(button('Watchlist on the left'));
    expect(setDesk).toHaveBeenLastCalledWith({ ...DEFAULT_DESK, side: 'left' });
  });

  it('asks before replacing a layout that holds the name, then replaces it under the same id', async () => {
    render();
    click(button('Layouts'));
    type('Layout name', ' scalp ');
    click(button('Save as'));
    // The name is taken: nothing is written yet, and the menu asks.
    expect(host.textContent).toContain('A layout called scalp already exists. Replace it?');
    expect((state.layouts.commit as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    click(button('Replace'));
    await act(async () => undefined);
    const commit = state.layouts.commit as ReturnType<typeof vi.fn>;
    expect(commit).toHaveBeenCalledTimes(1);
    // The menu commits an updater: it runs on the record as it stands when the write is sent.
    const update = commit.mock.calls[0]![0] as (latest: LayoutsValue) => LayoutsValue;
    const next = update(state.layouts.value as LayoutsValue);
    expect(next.layouts).toHaveLength(1);
    expect(next.layouts[0]).toMatchObject({ id: 'layout-scalp', name: 'scalp' });
  });

  it('asks before a template wipes the studies already on the chart; cancelling writes nothing', () => {
    const studies = { studies: [{ id: 's1', kind: 'sma' }], remembered: {}, legendAlways: false };
    localStorage.setItem('charts-studies:u1:main', JSON.stringify(studies));
    state.templates = {
      status: 'ready',
      value: [
        {
          id: 'template-a',
          name: 'Trend desk',
          savedAt: '2026-10-22T09:00:00.000Z',
          symbol: 'BTC/USDT',
          interval: '1h',
          mode: 'candles',
          studies: [],
          drawings: null,
        },
      ],
      commit: vi.fn(async () => ({ ok: true })),
      reload: () => undefined,
    };
    const { onRemount } = render();
    click(button('Layouts'));
    click(button('Apply'));
    expect(host.textContent).toContain('Applying this template replaces the studies and drawings on BTC/USDT. Apply it?');
    click(button('Cancel'));
    expect(JSON.parse(localStorage.getItem('charts-studies:u1:main')!)).toEqual(studies);
    expect(onRemount).not.toHaveBeenCalled();
  });

  it('cancelling the replace prompt writes nothing', () => {
    render();
    click(button('Layouts'));
    type('Layout name', 'Scalp');
    click(button('Save as'));
    click(button('Cancel'));
    expect((state.layouts.commit as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(host.textContent).not.toContain('Replace it?');
  });
});
