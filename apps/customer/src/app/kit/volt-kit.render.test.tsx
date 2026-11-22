// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The balance's figure (number-flow) reads the motion preference when it loads, and happy-dom has none to give (the
// render-record run gives it a browser's answer). Here it is drawn as its static text; the real figure is in the pictures.
vi.mock('@intafaced/ui', async (original) => {
  const real = await original<typeof import('@intafaced/ui')>();
  return {
    ...real,
    HeroNumber: ({ value, prefix }: { value: string; prefix?: string }) => <span data-slot="hero-number">{`${prefix ?? ''}${value}`}</span>,
  };
});

// The candle chart's engine reads resolved colours from the page, which happy-dom cannot give (it throws "Failed to parse
// color" after the test); here the chart is its labelled frame with its candles counted. The drawn chart is in the pictures.
vi.mock('../../screens/trade/chart/PriceChart', () => ({
  PriceChart: ({ candles, labels }: { candles: readonly unknown[]; labels: { chart: string } }) => (
    <div className="pc-root" role="img" aria-label={labels.chart} data-candles={candles.length} />
  ),
}));

// Signed out, the boot refresh answered: the kit page needs no session, and nothing on it reads.
vi.mock('../../features/session/session', async (original) => {
  const real = await original<typeof import('../../features/session/session')>();
  const api = {
    query: () => new Promise(() => undefined),
    mutate: () => new Promise(() => undefined),
    canWrite: () => false,
    call(
      this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },
      record: { kind: string; module: string; path: string; output: unknown },
      input?: unknown,
      opts?: unknown,
    ) {
      return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [
        record.module,
        record.path,
        input,
        record.output,
        opts,
      ]);
    },
  };
  const value = {
    session: null,
    userId: null,
    api,
    restoring: false,
    restoreFailed: false,
    retryRestore: () => undefined,
    commit: () => undefined,
    clear: () => undefined,
    logout: async () => ({ ok: true, data: { ok: true } }),
    retryLogout: async () => ({ ok: true, data: { ok: true } }),
    notice: null,
    subAccountWaiting: false,
    mode: 'Personal',
    profiles: { list: [], business: null, select: () => undefined },
    enterSubAccount: async () => ({ ok: false }),
    leaveSubAccount: async () => ({ ok: false }),
  };
  return { ...real, useSession: () => value as never, useApi: () => api as never };
});

import { App } from '../App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await import('./VoltKit');
}, 60_000);

let host: HTMLDivElement;
let root: Root;
const html = document.documentElement;

beforeEach(() => {
  delete html.dataset.look;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(path: string) {
  history.replaceState(null, '', path);
  await act(async () => root.render(<App />));
  await act(async () => {
    await vi.waitFor(() =>
      expect(Boolean(host.querySelector('[data-testid="volt-kit"]')) || Boolean(host.textContent?.includes('Page not found'))).toBe(true),
    );
  });
}

// The blocks intafaced issue 9302 lists, in its order, with the parts issues 9326 and 9563 add.
const BLOCKS = [
  'colour',
  'type',
  'balance',
  'object',
  'money-parts',
  'pay-parts',
  'buttons',
  'inputs',
  'controls',
  'overlays',
  'steps',
  'list',
  'rows',
  'bars',
  'rail',
  'icons',
  'chart',
  'time-line',
  'chart-box',
  'candles',
  'book',
  'people',
  'qr',
  'states',
  'sheet',
];

describe('the Volt kit page (intafaced issue 9302), with Volt the only look (issue 9315)', () => {
  it('/kit draws every block the issue lists, each from the shipped parts, with no switch on the root', async () => {
    expect(html.dataset.look).toBeUndefined();
    expect(html.dataset.direction).toBeUndefined();
    await open('/kit');
    const kit = host.querySelector('[data-testid="volt-kit"]');
    expect(kit).not.toBeNull();
    expect([...kit!.querySelectorAll('[data-block]')].map((b) => b.getAttribute('data-block'))).toEqual(BLOCKS);
    expect(kit!.querySelector('[data-testid="volt-stack"]'), 'the money object is Home’s own VoltStack').not.toBeNull();
    expect(kit!.querySelector('.home-total [data-slot="hero-number"]'), 'the balance is a HeroNumber in Home’s total').not.toBeNull();
    expect(kit!.querySelector('.lt-chart .lt-chart-area[data-soft]'), 'the chart is the soft AreaChart').not.toBeNull();
    expect(kit!.querySelectorAll('.lt-people .lt-person').length, 'quick send: add, then five people').toBe(6);
    expect(kit!.querySelector('.mobile-doors'), 'the tab bar is the shipped MobileTabs').not.toBeNull();
    expect(kit!.querySelectorAll('[data-slot="button"][data-variant="primary"]').length).toBeGreaterThan(0);
  });

  it('/kit shows every part issue 9326 names: type roles, controls, overlays, stepper, sparkline, rail, icons, candles, book', async () => {
    await open('/kit');
    const kit = host.querySelector('[data-testid="volt-kit"]')!;
    const block = (id: string) => kit.querySelector(`[data-block="${id}"]`)!;
    expect([...block('type').querySelectorAll('[data-type-role]')].map((e) => e.getAttribute('data-type-role'))).toEqual([
      'hero',
      'figure',
      'title',
      'heading',
      'body',
      'label',
      'micro',
    ]);
    const controls = block('controls');
    expect(controls.querySelector('[data-slot="field"][data-invalid]'), 'a text field with its error').not.toBeNull();
    expect(controls.querySelectorAll('[role="checkbox"]').length, 'checkboxes').toBe(2);
    expect(controls.querySelectorAll('[role="switch"]').length, 'switches').toBe(2);
    expect(controls.querySelector('[aria-label="Delivery speed"]'), 'a choice group').not.toBeNull();
    expect(controls.querySelectorAll('[role="tab"]').length, 'tabs').toBe(3);
    const overlays = block('overlays');
    for (const k of ['open-menu', 'tooltip', 'open-popover', 'open-review'])
      expect(overlays.querySelector(`[data-kit="${k}"]`), k).not.toBeNull();
    expect(overlays.querySelector('[data-slot="autocomplete-input"]'), 'the search field').not.toBeNull();
    expect(block('steps').querySelector('.lt-stepper'), 'the stepper').not.toBeNull();
    expect(block('steps').querySelectorAll('svg[aria-label]').length, 'two sparklines').toBe(2);
    expect(block('rail').querySelector('.lit-rail'), 'the computer rail').not.toBeNull();
    expect(block('icons').querySelectorAll('li svg').length, 'every shell icon').toBe(24);
    expect(block('candles').querySelector('.pc-root')?.getAttribute('data-candles'), 'the candle chart, with its 40 TEST candles').toBe(
      '40',
    );
    const codes = block('qr').querySelectorAll('figure.lt-qr');
    expect(codes, 'two QR codes, md and sm').toHaveLength(2);
    expect(codes[0]!.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Scan to open the TEST payment link');
    expect(codes[1]!.querySelector('figcaption')?.textContent, 'the small one shows its text').toMatch(/^ethereum:0x/);
    expect(block('qr').querySelector('[role="alert"]')?.textContent, 'and a text too long draws its failure line').toMatch(/too long/);
    const small = block('candles').querySelectorAll('figure.lt-candles');
    expect(small, 'the small candle chart, drawn and empty').toHaveLength(2);
    expect(
      small[0]!.querySelectorAll('svg[role="img"] [data-testid="kit-candle"]'),
      'its 32 TEST candles, eight left out as a gap',
    ).toHaveLength(32);
    expect(small[1]!.querySelector('[role="status"]')?.textContent, 'its honest empty line').toMatch(/^No trades/);
    const boxes = block('chart-box').querySelectorAll('.lt-chart-box');
    expect(boxes, 'the chart box, drawn and holding a state').toHaveLength(2);
    expect(
      boxes[0]!.querySelector('[role="img"][aria-label] > [data-testid="kit-chart-host"]'),
      'the named picture and its drawing element',
    ).not.toBeNull();
    expect(
      boxes[0]!.querySelector('[data-testid="kit-chart-host"] canvas'),
      'the library was handed the element and drew into it',
    ).not.toBeNull();
    expect(boxes[1]!.querySelector('[role="status"]')?.textContent, 'the state in its place').toMatch(/^No trades yet/);
    expect(block('book').querySelector('[data-widget], [role="table"], table, [data-testid]'), 'the order book').not.toBeNull();
    const lines = block('time-line').querySelectorAll('figure.lt-timeline');
    expect(lines, 'the line over time, drawn and empty').toHaveLength(2);
    expect(
      lines[0]!.querySelectorAll('svg[data-chart="kit-time-line"] [data-run]'),
      'two runs, broken by the hours with no figure',
    ).toHaveLength(2);
    expect(lines[0]!.querySelector('.lt-timeline-zero'), 'its zero line').not.toBeNull();
    const plot = lines[0]!.querySelector<HTMLElement>('.lt-timeline-plot[tabindex="0"]');
    expect(plot, 'its plot takes the keyboard').not.toBeNull();
    await act(async () => {
      plot!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(lines[0]!.querySelector('[role="status"]')?.textContent, 'the readout names the last point').toMatch(
      /^21 Nov 23:00 UTC: \$.+ TEST$/,
    );
    expect(lines[0]!.querySelector('.lt-timeline-cursor'), 'and the cursor marks it').not.toBeNull();
    expect(lines[1]!.querySelector('[role="status"]')?.textContent, 'its honest empty line').toMatch(/^No points/);
  });

  it('/kit shows the markets list: chips filter, headers sort with aria-sort, and only the rows near the view are drawn', async () => {
    await open('/kit');
    const list = host.querySelector('[data-testid="volt-kit"] [data-block="list"]')!;
    const rows = () => [...list.querySelectorAll<HTMLElement>('tbody tr[data-symbol]')];
    const table = list.querySelector('table')!;
    expect(table.getAttribute('aria-rowcount'), 'all 120 TEST rows are counted').toBe('121');
    expect(rows().length, 'only a window of them is drawn').toBeLessThan(120);
    expect(rows()[0]?.querySelector('svg[role="img"][aria-label]'), 'each row has a named sparkline').not.toBeNull();

    const price = list.querySelector<HTMLButtonElement>('button[aria-label="Sort by Price"]')!;
    expect(price.closest('th')?.getAttribute('aria-sort')).toBe('none');
    await act(async () => price.click());
    expect(price.closest('th')?.getAttribute('aria-sort'), 'a figure sorts largest first').toBe('descending');
    const prices = rows().map((r) => r.querySelectorAll('td')[1]!.textContent!);
    expect(prices.slice(0, 3)).toEqual(prices.slice(0, 3).sort((a, b) => Number(b) - Number(a)));

    const chips = list.querySelector('[role="group"][aria-label="Filter by change"]')!;
    const chip = (name: string) => [...chips.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!;
    expect(chip('All').getAttribute('aria-pressed')).toBe('true');
    await act(async () => chip('Losers').click());
    expect(chip('Losers').getAttribute('aria-pressed')).toBe('true');
    expect(rows().length, '40 losers is a short list: every row is drawn').toBe(40);
    expect(rows().every((r) => r.querySelectorAll('td')[2]!.textContent!.startsWith('-'))).toBe(true);
    await act(async () => chip('Losers').click());
    expect(chips.querySelector('[aria-pressed="true"]'), 'pressing the chip in force again turns the filter off').toBeNull();

    // happy-dom lays nothing out (each measured row is 0 tall), so the drawn window may start anywhere in the list.
    const start = Number(rows()[0]!.dataset.index);
    const first = rows()[0]!.querySelector<HTMLElement>('.lt-row-link')!;
    first.focus();
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement?.closest('tr')?.dataset.index, 'ArrowDown moves to the next row').toBe(String(start + 1));
  });

  it('/kit shows the money parts issue 9563 adds, and the info tip opens on focus, tap and hover and closes on Escape', async () => {
    await open('/kit');
    const block = host.querySelector('[data-testid="volt-kit"] [data-block="money-parts"]')!;
    expect(block.querySelector('[data-slot="asset-icon"][data-asset="BTC"] svg'), 'a listed asset draws its art').not.toBeNull();
    expect(
      block.querySelector('[data-slot="asset-icon"][data-asset="XYZ"]')?.getAttribute('data-fallback'),
      'an unknown asset is lettered',
    ).toBe('lettered');
    expect(block.querySelector('[data-slot="hero-figure"] .lit-figure[data-size="hero"]'), 'the hero figure').not.toBeNull();
    expect(block.querySelector('[data-slot="hero-figure"][data-unknown]')?.getAttribute('aria-label'), 'no figure is a dash').toBe(
      'Not available',
    );
    expect(block.querySelector('details.lit-fold [data-part="count"]')?.textContent, 'the fold counts its items').toBe('3');
    expect(block.querySelectorAll('.lit-stack a.lit-stack__card').length, 'the stack: two cards, each a link').toBe(2);

    const tip = block.querySelector<HTMLButtonElement>('[data-testid="kit-tip"]')!;
    const bubble = () => block.querySelector('.lit-tip__bubble');
    const described = document.getElementById(tip.getAttribute('aria-describedby')!);
    expect(described?.textContent, 'the text is the button’s description, with no hover').toContain('in US dollars');
    expect(bubble()).toBeNull();
    await act(async () => tip.focus());
    expect(tip.getAttribute('aria-expanded'), 'focus opens it').toBe('true');
    await act(async () => tip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(bubble(), 'Escape closes it').toBeNull();
    await act(async () => tip.click());
    expect(bubble()?.textContent, 'a tap opens it').toContain('in US dollars');
    await act(async () => tip.click());
    expect(bubble(), 'a second tap closes it').toBeNull();

    const hide = [...block.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Hide balances')!;
    await act(async () => hide.click());
    const hero = block.querySelector('[data-slot="hero-figure"][data-hidden]');
    expect(hero?.getAttribute('aria-label'), 'hidden, the figure is masked and said so').toBe('Balance hidden');
    expect(hero?.textContent).not.toContain('12,468');
  });
  it('/kit shows the pay parts issue 9563 adds: the money box keeps a decimal string, Max fills it, and a confirmation is announced and closes', async () => {
    await open('/kit');
    const block = host.querySelector('[data-testid="volt-kit"] [data-block="pay-parts"]')!;
    const box = block.querySelector<HTMLElement>('[data-testid="kit-amount"]')!;
    const input = box.querySelector<HTMLInputElement>('input')!;
    expect(input.getAttribute('inputmode'), 'a decimal keyboard, never type=number').toBe('decimal');
    expect(input.type).toBe('text');
    expect(box.querySelector('[data-part="unit"]')?.textContent?.trim(), 'its unit beside it').toBe('USDT');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent, 'what is available describes it').toMatch(
      /^Available 9,218\.50 USDT/,
    );
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const type = (text: string) =>
      act(async () => {
        setValue.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await type('12.3');
    expect(input.value).toBe('12.3');
    await type('12.345');
    expect(input.value, 'a decimal past the asset’s is refused').toBe('12.3');
    await type('12.3.');
    expect(input.value, 'a second mark is refused').toBe('12.3');
    await type('7.');
    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(input.value, 'an unfinished mark is dropped on leaving').toBe('7');
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
    paste.clipboardData = { getData: () => '1,234.567 USDT' };
    await act(async () => input.dispatchEvent(paste));
    expect(input.value, 'a paste drops separators and words, cut down to two decimals').toBe('1234.56');
    await act(async () => box.querySelector<HTMLButtonElement>('[data-part="max"]')!.click());
    expect(input.value, 'Max fills in what is available').toBe('9218.50');

    const refused = block.querySelectorAll('.lit-amount')[1]!;
    expect(refused.querySelector('input')?.getAttribute('aria-invalid'), 'a refused amount is marked invalid').toBe('true');
    expect(refused.querySelector('[role="alert"]')?.textContent).toMatch(/^More than your/);

    const handle = block.querySelector('.lit-field-control [data-part="box"]')!;
    expect(handle.querySelector('[data-part="before"][aria-hidden="true"]')?.textContent, 'the handle box shows its @').toBe('@');
    expect(handle.querySelector('button')?.textContent, 'and its Paste key inside it').toBe('Paste');

    const payee = block.querySelector('[data-testid="kit-payee"]')!;
    expect(payee.querySelector('[data-part="face"]')?.textContent).toBe('M');
    expect(payee.querySelector('[data-part="tick"]'), 'confirmed').not.toBeNull();
    expect(
      [...block.querySelectorAll('.lit-note')].map((n) => n.getAttribute('role')),
      'polite unless it failed',
    ).toEqual(['status', 'status', 'alert']);

    const region = document.querySelector('[data-slot="toast-region"]')!;
    expect(region.getAttribute('aria-live'), 'the polite region is in the page before any toast').toBe('polite');
    expect(region.children).toHaveLength(0);
    await act(async () => block.querySelector<HTMLButtonElement>('[data-kit="show-volt-toast"]')!.click());
    expect(region.querySelector('[data-part="title"]')?.textContent, 'a confirmation arrives in it').toBe('Link copied');
    await act(async () => region.querySelector<HTMLButtonElement>('[data-part="close"]')!.click());
    expect(region.children, 'and its close key closes it').toHaveLength(0);
  });

  it('a confirmation closes by itself after its time', async () => {
    vi.useFakeTimers();
    try {
      const { ToastProvider, useToast } = await import('@intafaced/ui/lit');
      let raise: ReturnType<typeof useToast>['add'] = () => '';
      function Raiser() {
        raise = useToast().add;
        return null;
      }
      await act(async () =>
        root.render(
          <ToastProvider closeLabel="Dismiss">
            <Raiser />
          </ToastProvider>,
        ),
      );
      const region = host.querySelector('[data-slot="toast-region"]')!;
      await act(async () => void raise({ title: 'Copied', timeout: 2000 }));
      expect(region.textContent).toContain('Copied');
      await act(async () => void vi.advanceTimersByTime(1999));
      expect(region.textContent, 'still there just before its time').toContain('Copied');
      await act(async () => void vi.advanceTimersByTime(1));
      expect(region.children, 'gone at its time').toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
