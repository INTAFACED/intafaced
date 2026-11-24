import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ColumnWidths, SplitBorder, SplitCell, SplitGrid } from './b2-controls.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const css = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'components.css'), 'utf8');

describe('the split grid', () => {
  it('lays two shares out with a border track between them, and one share as the whole axis', () => {
    const out = html(<SplitGrid cols={[2, 1]} rows={[1]} data-testid="grid" />);
    expect(out).toContain('class="lt-split"');
    expect(out).toContain('grid-template-columns:2fr 8px 1fr');
    expect(out).toContain('grid-template-rows:1fr');
    expect(out).toContain('data-testid="grid"');
  });

  it('places a panel on its column and row, takes the whole grid when maximised, and hides one kept mounted', () => {
    expect(html(<SplitCell col={1} row={1} />)).toContain('grid-column:3;grid-row:3');
    expect(html(<SplitCell col={1} row={0} whole />)).toContain('grid-column:1 / -1;grid-row:1 / -1');
    expect(html(<SplitCell col={0} row={0} hidden />)).toContain('display:none');
    expect(html(<SplitCell col={0} row={0} />)).not.toContain('display');
  });

  it('draws each border as a named separator on its own track', () => {
    const col = html(<SplitBorder axis="cols" aria-label="Column border" />);
    expect(col).toContain('role="separator"');
    expect(col).toContain('aria-orientation="vertical"');
    expect(col).toContain('aria-label="Column border"');
    expect(col).toContain('grid-column:2;grid-row:1 / -1');
    const row = html(<SplitBorder axis="rows" aria-label="Row border" />);
    expect(row).toContain('aria-orientation="horizontal"');
    expect(row).toContain('grid-row:2;grid-column:1 / -1');
  });

  it('gives each resized column its width and leaves the others to the table', () => {
    const out = html(
      <table>
        <ColumnWidths widths={[120, undefined]} />
      </table>,
    );
    expect(out).toContain('<colgroup><col style="width:120px"/><col/></colgroup>');
  });

  it('its styles read only lit roles and logical sides', () => {
    const start = css.indexOf('/* ---- charts grid: the split grid');
    const block = css.slice(start, css.indexOf('/* ----', start + 10) === -1 ? undefined : css.indexOf('/* ----', start + 10));
    expect(block).toContain('.lt-split-border');
    expect(block).toContain('.lt-col-grip');
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\bpx\b/i);
    expect(block).not.toMatch(/\b(left|right|top|bottom)\s*:/);
  });
});
