import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, Segmented } from './index.js';
import { Stat, type MenuItemSpec } from './controls.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const css = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../templates/templates.css'), 'utf8');

describe('the desk overlay parts', () => {
  it('a busy button says so and stays focusable', () => {
    const out = html(<Button busy>Save</Button>);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toMatch(/\sdisabled=""/);
  });

  it('their styles read only lit roles and logical sides', () => {
    const at = css.indexOf('/* ---- overlay parts (components/controls.tsx');
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at);
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\bpx\b/i);
    expect(block).not.toMatch(/\b(left|right|top|bottom)\s*:/);
  });
});

describe('the headline figure', () => {
  it('says how fresh it is, in words, with its as-of time', () => {
    const at = Date.parse('2026-11-22T10:00:00Z');
    const live = html(<Stat label="Margin posted" value="10.0000 USDT" asOf={at} now={at + 1000} staleAfterMs={30_000} />);
    expect(live).toContain('role="group"');
    expect(live).toContain('Live');
    expect(live).toContain('dateTime="2026-11-22T10:00:00.000Z"');
    expect(html(<Stat label="Margin posted" value="1" asOf={at} now={at + 60_000} staleAfterMs={30_000} />)).toContain('Stale');
    expect(html(<Stat label="Margin posted" value={null} refused />)).toContain('Refused');
  });

  it('an unknown value is the dash, never 0', () => {
    const out = html(<Stat label="Margin calls" value={null} />);
    expect(out).toContain('—');
    expect(out).not.toContain('>0<');
  });

  it('a money figure is marked as money and stays left to right; a count is not money', () => {
    const money = html(<Stat label="Free balance" value="4,100 USDT" money />);
    expect(money).toContain('data-slot="money"');
    expect(money).toContain('<span dir="ltr" data-ltr="">4,100 USDT</span>');
    expect(html(<Stat label="Margin posted" value={null} money />)).toContain('data-slot="money"');
    expect(html(<Stat label="Open positions" value="3" />)).not.toContain('data-slot="money"');
  });
});

describe('choices listed but not open now', () => {
  it('a Segmented option can be listed and disabled, and the others stay pressable', () => {
    const out = html(
      <Segmented
        label="Order type"
        value="market"
        onChange={() => undefined}
        options={[
          { value: 'market', label: 'Market' },
          { value: 'limit', label: 'Limit', disabled: true },
        ]}
      />,
    );
    expect(out).toContain('role="group" aria-label="Order type"');
    expect(out).toContain('<button type="button" aria-pressed="true"><span class="lit-segmented-label">Market</span></button>');
    expect(out).toContain('<button type="button" aria-pressed="false" disabled=""><span class="lit-segmented-label">Limit</span></button>');
  });

  it('a Menu item may carry its reason on a second line', () => {
    const item: MenuItemSpec = {
      key: 'twap',
      disabled: true,
      onSelect: () => undefined,
      label: (
        <span className="lt-stack-tight">
          <span>TWAP</span>
          <span className="lt-note">Not offered on this book</span>
        </span>
      ),
    };
    expect(html(<>{item.label}</>)).toBe(
      '<span class="lt-stack-tight"><span>TWAP</span><span class="lt-note">Not offered on this book</span></span>',
    );
  });

  it('a Menu floats above desk layers on an opaque tile-radius surface so underlying numbers never bleed through or clip items', () => {
    expect(css).toMatch(/\.lt-menu-layer \{[^}]*z-index: 50;/);
    expect(css).toMatch(/\.lt-menu \{[^}]*background: var\(--lit-solid-bg-raised\);/);
    expect(css).toMatch(/\.lt-menu \{[^}]*border-radius: var\(--lit-radius-tile\);/);
    expect(css).toMatch(/\.lt-desk > \[data-region='ticket'\] \.lt-tabs \{[^}]*flex-wrap: wrap;/);
  });
});
