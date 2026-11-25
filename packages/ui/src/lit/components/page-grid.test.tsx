import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageColumn, PageGrid, PanelHead, TileRow } from '../index.js';

describe('PageGrid', () => {
  it('wraps the grid in a page box that scales on an ultra-wide screen unless told not to', () => {
    const html = renderToStaticMarkup(
      <PageGrid layout="split" aria-label="Home">
        <PageColumn>a</PageColumn>
        <PageColumn span="all">b</PageColumn>
      </PageGrid>,
    );
    expect(html).toContain('class="lt-page" data-scale="auto"');
    expect(html).toContain('class="lt-page-grid" data-layout="split"');
    expect(html).toContain('data-span="all"');
    expect(renderToStaticMarkup(<PageGrid scale="off" />)).toContain('data-scale="off"');
  });

  it('defaults to one full-width column', () => {
    expect(renderToStaticMarkup(<PageGrid />)).toContain('data-layout="full"');
  });
});

describe('PanelHead and TileRow', () => {
  it('names the panel with a heading at the asked level and keeps the aside beside it', () => {
    const html = renderToStaticMarkup(<PanelHead level={3} title="What's moving" aside="TEST" />);
    expect(html).toContain('<h3 class="lt-panel-title">What&#x27;s moving</h3>');
    expect(html).toContain('<div class="lt-panel-aside">TEST</div>');
    expect(renderToStaticMarkup(<PanelHead title="Markets" />)).not.toContain('lt-panel-aside');
  });

  it('sets the tile minimum as data, not style', () => {
    expect(renderToStaticMarkup(<TileRow min="narrow" />)).toContain('data-min="narrow"');
  });
});

describe('PageGrid panels', () => {
  it('marks a board that draws its panels as flat tiles, so the look scopes the tile material to it', () => {
    const html = renderToStaticMarkup(<PageGrid panels="tiles">x</PageGrid>);
    expect(html).toContain('<div class="lt-page" data-scale="auto" data-panels="tiles">');
    expect(renderToStaticMarkup(<PageGrid>x</PageGrid>)).not.toContain('data-panels');
  });

  it("keeps the owner's desk frame on a board of tiles: a 1.5rem edge at most, narrower than the Simple page's", () => {
    const css = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'components.css'), 'utf8');
    const tiles = /\.lt-page\[data-panels='tiles'\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(tiles).toContain('padding-inline: clamp(1rem, 1.6667vw, 1.5rem);');
  });
});
