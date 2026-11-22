// RoomBar (a room's bar that stays under the top bar) and the arrow keys of the kit's rows of pressed buttons
// (Segmented, ToggleChips, SectionTabs), for /coin/:asset (intafaced issue 9564, J-portfolio-10 #1 and #2).
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { obscuredInsets } from '../../a11y/focus.js';
import { LegalSlotsSwitch, RoomFrame } from '../templates/frame.js';
import { arrowTarget, moveFocusByArrow } from './arrow-focus.js';
import { RoomBar, SectionTabs } from './b2-basics.js';
import { Segmented, ToggleChips } from './index.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const css = readFileSync(fileURLToPath(new URL('../templates/templates.css', import.meta.url)), 'utf8');
const RANGES = ['1D', '1W', '1M', '6M', '1Y', 'All'] as const;

describe('RoomBar', () => {
  it('is drawn by the frame first in the room, before the title, with its own marks', () => {
    const out = html(
      <RoomFrame
        template="monitor"
        title="Bitcoin"
        state={{ kind: 'ready' }}
        bar={
          <RoomBar marks={{ 'data-testid': 'coin-bar' }}>
            <span>Bitcoin</span>
            <span>BTC</span>
          </RoomBar>
        }
      >
        <p>body</p>
      </RoomFrame>,
    );
    expect(out).toContain(
      '<div class="lt-room" data-template="monitor" data-state="ready" data-mode="simple"><div class="lt-room-bar" data-region="room-bar" data-testid="coin-bar"><span>Bitcoin</span><span>BTC</span></div><header class="lt-title-row">',
    );
  });

  it('with the legal band on, the bar comes after the band, so it stacks under it', () => {
    const out = html(
      <LegalSlotsSwitch.Provider value={true}>
        <RoomFrame
          template="monitor"
          title="Bitcoin"
          state={{ kind: 'ready' }}
          legal={['crypto-risk-band']}
          market="uk"
          bar={<RoomBar>x</RoomBar>}
        >
          <p>body</p>
        </RoomFrame>
      </LegalSlotsSwitch.Provider>,
    );
    expect(out.indexOf('lt-band-slot')).toBeGreaterThan(-1);
    expect(out.indexOf('lt-room-bar')).toBeGreaterThan(out.indexOf('lt-band-slot'));
  });

  it('a room with no bar draws none', () => {
    expect(
      html(
        <RoomFrame template="monitor" title="Bitcoin" state={{ kind: 'ready' }}>
          <p>body</p>
        </RoomFrame>,
      ),
    ).not.toContain('lt-room-bar');
  });

  it('sticks at the top bar’s measured bottom edge, the token before the first measure, and under the band when on', () => {
    expect(css).toMatch(
      /\.lt-room-bar \{\s*position: sticky;\s*inset-block-start: var\(--a11y-obscured-top, var\(--lit-topbar-h\)\);\s*z-index: 2;/,
    );
    expect(css).toMatch(
      /\.lt-room\[data-band\] > \.lt-room-bar \{\s*inset-block-start: var\(--a11y-obscured-top, calc\(var\(--lit-topbar-h\) \+ var\(--lit-legal-band-min-h\)\)\);/,
    );
    // Opaque, so what scrolls under it does not show through; logical sides only.
    expect(css).toMatch(/\.lt-room-bar \{[^}]*background: var\(--lit-page\);[^}]*border-block-end: 1px solid var\(--lit-line\);/);
  });

  it('the measured edge is the top bar’s bottom: a fixed banner’s reach plus the sticky top bar’s height, and the band under it', () => {
    // The app's bars as trackObscuringBars measures them: the local stack's banner (fixed, 28 high) and the top bar
    // (sticky, 48 high, stuck under the banner), so its bottom edge, where the room bar sits, is 76.
    const banner = { edge: 'top', height: 28, reach: 28 };
    const topBar = { edge: 'top', height: 48 };
    expect(obscuredInsets([banner, topBar]).top).toBe(76);
    expect(obscuredInsets([topBar]).top).toBe(48);
    // With the legal band on, the band (sticky, in the flow) stacks under the top bar and the room bar under both.
    expect(obscuredInsets([banner, topBar, { edge: 'top', height: 44 }]).top).toBe(120);
  });
});

describe('arrow keys in a row of pressed buttons', () => {
  it('the arrow along the row moves one, wrapping; Home and End go to the ends; other keys do nothing', () => {
    expect(arrowTarget('ArrowRight', 3, 6)).toBe(4);
    expect(arrowTarget('ArrowLeft', 4, 6)).toBe(3);
    expect(arrowTarget('ArrowRight', 5, 6)).toBe(0);
    expect(arrowTarget('ArrowLeft', 0, 6)).toBe(5);
    expect(arrowTarget('Home', 3, 6)).toBe(0);
    expect(arrowTarget('End', 3, 6)).toBe(5);
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) expect(arrowTarget(key, 3, 6)).toBeNull();
  });

  it('right to left, the left arrow goes forward', () => {
    expect(arrowTarget('ArrowLeft', 3, 6, true)).toBe(4);
    expect(arrowTarget('ArrowRight', 3, 6, true)).toBe(2);
  });

  it('nothing to move to when focus is not on one of the row’s buttons', () => {
    expect(arrowTarget('ArrowRight', -1, 6)).toBeNull();
    expect(arrowTarget('ArrowRight', 0, 0)).toBeNull();
  });

  /** A row of buttons as the handler sees it, with `focus` recorded. */
  function row(direction: 'ltr' | 'rtl' = 'ltr') {
    const focused: string[] = [];
    const buttons = RANGES.map((label) => ({ label, focus: () => focused.push(label) }));
    const el = {
      querySelectorAll: (selector: string) => {
        expect(selector, 'only the row’s own enabled buttons').toBe(':scope > button:not(:disabled)');
        return buttons;
      },
      ownerDocument: { defaultView: { getComputedStyle: () => ({ direction }) } },
    };
    const press = (key: string, from: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => {
      const preventDefault = vi.fn();
      moveFocusByArrow({
        key,
        target: buttons.find((b) => b.label === from),
        currentTarget: el,
        preventDefault,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...mods,
      } as unknown as React.KeyboardEvent<HTMLElement>);
      return preventDefault.mock.calls.length > 0;
    };
    return { focused, press };
  }

  it('moves focus from 6M to 1Y and back, keeping the arrow from scrolling the page, and never presses', () => {
    const r = row();
    expect(r.press('ArrowRight', '6M')).toBe(true);
    expect(r.press('ArrowLeft', '1Y')).toBe(true);
    expect(r.press('End', '1D')).toBe(true);
    expect(r.focused).toEqual(['1Y', '6M', 'All']);
  });

  it('leaves other keys and modified arrows to the browser', () => {
    const r = row();
    expect(r.press('Enter', '6M')).toBe(false);
    expect(r.press('Tab', '6M')).toBe(false);
    expect(r.press('ArrowRight', '6M', { shiftKey: true })).toBe(false);
    expect(r.press('ArrowRight', '6M', { altKey: true })).toBe(false);
    expect(r.focused).toEqual([]);
  });

  it('follows the row’s own direction', () => {
    const r = row('rtl');
    r.press('ArrowLeft', '6M');
    expect(r.focused).toEqual(['1Y']);
  });
});

describe('the rows that take the arrow keys', () => {
  it('Segmented: a named group of pressed buttons, its marks, each pill’s full name and tooltip, one pressed', () => {
    const out = html(
      <Segmented
        label="Chart range"
        marks={{ 'data-testid': 'coin-ranges' }}
        options={RANGES.map((r) => ({ value: r, label: r, name: r === '6M' ? 'Six months' : undefined }))}
        value="1D"
        onChange={() => undefined}
      />,
    );
    expect(out).toMatch(/^<div data-testid="coin-ranges" class="lit-segmented" role="group" aria-label="Chart range">/);
    expect(out).toContain('<button type="button" aria-pressed="true">1D</button>');
    expect(out).toContain('<button type="button" aria-pressed="false" aria-label="Six months" title="Six months">6M</button>');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    // Every pill stays a Tab stop: no roving tabindex changes how Tab moves.
    expect(out).not.toContain('tabindex');
  });

  it('Segmented, ToggleChips and SectionTabs each answer the arrow keys on the row', () => {
    const rows = [
      <Segmented key="s" label="Range" options={[{ value: 'a', label: 'A' }]} value="a" onChange={() => undefined} />,
      <ToggleChips key="c" label="Filter" options={[{ value: 'a', label: 'A' }]} value={null} onChange={() => undefined} />,
      <SectionTabs key="t" label="Sections" items={[{ value: 'a', label: 'A' }]} value="a" onChange={() => undefined} />,
    ];
    for (const el of rows) {
      const props = (el.type as (p: unknown) => React.ReactElement<{ onKeyDown?: unknown }>)(el.props);
      expect(props.props.onKeyDown, String((el.type as { name: string }).name)).toBe(moveFocusByArrow);
    }
  });
});
