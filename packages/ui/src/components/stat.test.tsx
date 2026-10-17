import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HideBalancesProvider } from './numbers.js';
import { Stat } from './stat.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (out: string) => out.replace(/<[^>]+>/g, '');

// TEST timestamps, fixed.
const NOW = Date.UTC(2026, 9, 17, 14, 5, 0);
const AS_OF = '2026-10-17T14:03:07Z';

describe('Stat default', () => {
  const out = html(<Stat label="Test balance" value="1,234.50" unit="USD" hint="TEST DATA" />);
  it('is a labelled group', () => {
    expect(out).toContain('role="group"');
    const id = /aria-labelledby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<span id="${id}"`);
    expect(out).toContain('data-slot="stat"');
    expect(out).toContain('data-density="comfortable"');
    expect(out).toContain('data-size="md"');
  });
  it('draws value, unit and hint; value is tabular and weight 500', () => {
    expect(text(out)).toContain('1,234.50');
    expect(text(out)).toContain('USD');
    expect(text(out)).toContain('TEST DATA');
    expect(out).toContain('tabular-nums');
    expect(out).toContain('font-medium');
    expect(out).not.toMatch(/font-bold|font-semibold/);
    expect(out).not.toContain('data-freshness');
  });
});

describe('Stat unknown', () => {
  it('null value draws the dash and never 0', () => {
    const out = html(<Stat label="Test balance" value={null} />);
    expect(text(out)).toContain('—');
    expect(text(out)).not.toMatch(/\b0\b/);
  });
  it('null delta draws nothing; null value with a delta string keeps the dash', () => {
    const out = html(<Stat label="x" value={null} delta={null} />);
    expect(out).not.toContain('data-slot="change-text"');
  });
});

describe('Stat sizes and density', () => {
  it.each([
    ['sm', 'text-md'],
    ['md', 'text-lg'],
    ['lg', 'text-xl'],
  ] as const)('size %s uses %s', (size, cls) => {
    const out = html(<Stat label="x" value="1" size={size} />);
    expect(out).toContain(cls);
    expect(out).toContain(`data-size="${size}"`);
  });
  it('dense data attribute and align end', () => {
    const out = html(<Stat label="x" value="1" density="dense" align="end" />);
    expect(out).toContain('data-density="dense"');
    expect(out).toContain('items-end');
    expect(out).toContain('text-right');
  });
});

describe('Stat delta', () => {
  it('up is up-coloured with a glyph and the sign in the text', () => {
    const out = html(<Stat label="x" value="1" delta="+1.24%" />);
    expect(out).toContain('data-direction="up"');
    expect(out).toContain('text-up-text');
    expect(out).toContain('▲');
    expect(text(out)).toContain('+1.24%');
  });
  it('down is down-coloured', () => {
    const out = html(<Stat label="x" value="1" delta="−0.28%" />);
    expect(out).toContain('data-direction="down"');
    expect(out).toContain('text-down-text');
    expect(out).toContain('▼');
  });
});

describe('Stat sensitive', () => {
  it('masks value and delta under hidden balances', () => {
    const out = html(
      <HideBalancesProvider hidden>
        <Stat label="x" value="1,234.50" delta="+1.24%" sensitive />
      </HideBalancesProvider>,
    );
    expect(text(out)).not.toContain('1,234.50');
    expect(text(out)).not.toContain('1.24');
    expect(text(out)).toContain('••••');
  });
  it('shows the value when not sensitive, even under hidden balances', () => {
    const out = html(
      <HideBalancesProvider hidden>
        <Stat label="x" value="83,281.8" />
      </HideBalancesProvider>,
    );
    expect(text(out)).toContain('83,281.8');
  });
  it('shows the value when balances are not hidden', () => {
    const out = html(
      <HideBalancesProvider hidden={false}>
        <Stat label="x" value="9.99" sensitive />
      </HideBalancesProvider>,
    );
    expect(text(out)).toContain('9.99');
  });
});

describe('Stat loading', () => {
  const out = html(<Stat label="Test balance" value="1,234.50" loading delta="+1%" asOf={AS_OF} />);
  it('is aria-busy with a skeleton of the value height and no figure', () => {
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('data-slot="skeleton"');
    expect(out).toContain('h-7');
    expect(out).toContain('data-state="loading"');
    expect(text(out)).not.toContain('1,234.50');
    expect(out).not.toContain('status-chip');
    expect(text(out)).toContain('Test balance');
  });
});

describe('Stat freshness', () => {
  it('shows a live chip with the as-of time', () => {
    const out = html(<Stat label="x" value="1" asOf={AS_OF} now={NOW} staleAfterMs={300_000} timeZone="UTC" locale="en-GB" />);
    expect(out).toContain('data-freshness="live"');
    expect(out).toContain('data-slot="status-chip"');
    expect(text(out)).toContain('Live · as of 14:03:07');
  });
  it('shows stale from fixed timestamps', () => {
    const out = html(<Stat label="x" value="1" asOf={AS_OF} now={NOW} staleAfterMs={60_000} timeZone="UTC" />);
    expect(out).toContain('data-freshness="stale"');
    expect(text(out)).toContain('Stale');
  });
  it('refused without asOf still shows the chip, with the reason for screen readers', () => {
    const out = html(<Stat label="x" value={null} refused reason="Feed refused" now={NOW} />);
    expect(out).toContain('data-freshness="refused"');
    expect(out).toContain('<span class="sr-only">Feed refused</span>');
  });
});

describe('no bare zero for null', () => {
  it('Stat and KeyValue never turn null into 0', async () => {
    const { KeyValue } = await import('./key-value.js');
    const { Badge } = await import('./badge.js');
    const { StatusChip } = await import('./status-chip.js');
    for (const el of [
      <Stat key="s" label="x" value={null} delta={null} />,
      <KeyValue key="k" items={[{ label: 'x', value: null }]} />,
      <Badge key="b">None</Badge>,
      <StatusChip key="c" kind="unknown" />,
    ]) {
      expect(html(el).replace(/<[^>]+>/g, '')).not.toMatch(/(^|[^\w.])0([^\w.]|$)/);
    }
  });
});
