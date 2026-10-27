// Lane B2: the templates' honesty rules, as tests. Rendered to static markup.
import * as React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { templates, type TemplateId } from '../contracts.js';
import { Bars, Parts } from '../components/b2-charts.js';
import { LegalSlotsSwitch, Region, Review, RoomFrame } from './frame.js';
import { LEGAL_MOMENTS, resolveLegal } from './legal/registry.js';
import { RegistryLegalSlot as LegalSlot } from './legal/LegalSlot.js';
import { formatMoney, reconcileParts, sumDecimals } from './money.js';
import { HOLDINGS, ROOMS, galleryStates } from './__gallery__/fixtures.js';
import type { ReviewData } from './types.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
/** Rendered with the legal switch on, as launch prep will run it. */
const withLegal = (el: React.ReactElement) => html(<LegalSlotsSwitch.Provider value={true}>{el}</LegalSlotsSwitch.Provider>);

describe('chart parts reconcile to the total they show', () => {
  it('adds "Other" for the difference', () => {
    const r = reconcileParts('12480.36', [
      { label: 'Cash', value: '5460.12' },
      { label: 'BTC', value: '5770.24' },
    ]);
    expect(r).toEqual({
      ok: true,
      parts: [
        { label: 'Cash', value: '5460.12' },
        { label: 'BTC', value: '5770.24' },
        { label: 'Other', value: '1250.00' },
      ],
    });
  });

  it('draws exact parts as given', () => {
    const parts = [
      { label: 'a', value: '0.1' },
      { label: 'b', value: '0.2' },
    ];
    expect(reconcileParts('0.3', parts)).toEqual({ ok: true, parts });
  });

  it('refuses parts over the total, and negative parts', () => {
    expect(reconcileParts('10', [{ label: 'a', value: '10.01' }])).toEqual({ ok: false, reason: 'parts-exceed-total' });
    expect(reconcileParts('10', [{ label: 'a', value: '-1' }])).toEqual({ ok: false, reason: 'negative-part' });
  });

  it('Parts says so in words instead of drawing a chart that lies', () => {
    const out = html(<Parts label="x" total="10" asset="GBP" parts={[{ label: 'a', value: '11' }]} />);
    expect(out).toContain('data-reason="parts-exceed-total"');
    expect(out).not.toContain('lt-parts-bar');
  });

  it('every listed part is in the list, which is the text equivalent', () => {
    const out = html(<Parts label="x" total="3" asset="GBP" parts={[{ label: 'a', value: '1' }]} />);
    expect(out).toContain('£1');
    expect(out).toContain('Other');
    expect(out).toContain('£2');
  });
});

describe('bars', () => {
  it('a negative bar hangs below zero instead of vanishing', () => {
    const out = html(
      <Bars
        label="P&L"
        asset="GBP"
        bars={[
          { label: 'a', value: '10' },
          { label: 'b', value: '-5' },
        ]}
      />,
    );
    expect(out).toContain('data-negative="true"');
    expect(out).not.toMatch(/height="0"/);
  });
});

describe('money stays exact', () => {
  it('sums past 17 significant digits without losing any', () => {
    expect(sumDecimals(['123456789012345678.123456789', '0.000000001'])).toBe('123456789012345678.123456790');
  });

  it('formats a decimal string as given, never through a float', () => {
    expect(formatMoney({ value: '1234567890123456.78', asset: 'GBP' })).toBe('£1,234,567,890,123,456.78');
    expect(formatMoney({ value: '-250.00', asset: 'GBP' })).toBe('−£250.00');
    expect(formatMoney({ value: '0.0712', asset: 'BTC' })).toBe('0.0712 BTC');
  });

  it('refuses a number where a decimal string belongs', () => {
    expect(() => formatMoney({ value: 12 as unknown as string, asset: 'GBP' })).toThrow(TypeError);
  });

  const here = fileURLToPath(new URL('.', import.meta.url));
  const files = [
    ...readdirSync(here).map((f) => join(here, f)),
    ...readdirSync(join(here, 'legal')).map((f) => join(here, 'legal', f)),
    ...readdirSync(join(here, '..', 'components'))
      .filter((f) => f.startsWith('b2-'))
      .map((f) => join(here, '..', 'components', f)),
  ].filter((f) => /\.tsx?$/.test(f) && !/chart|\.test\./.test(f));

  it.each(files)('%s has no parseFloat, Number(), toFixed() or unary +value', (file) => {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bparseFloat\s*\(/);
    expect(code).not.toMatch(/\bNumber\s*\(/);
    expect(code).not.toMatch(/\.toFixed\s*\(/);
    expect(code).not.toMatch(/=\s*\+[a-zA-Z_]/);
  });
});

describe('legal slots come only from the registry', () => {
  const BAND =
    'Don’t invest unless you’re prepared to lose all the money you invest. This is a high-risk investment and you should not expect to be protected if something goes wrong.';

  it('the UK crypto band is the fixed COBS 4.12A text, bold, with the fixed link', () => {
    const r = resolveLegal('crypto-risk-band', 'uk', '2026-10-26');
    expect(r.status).toBe('fixed');
    if (r.status !== 'fixed') return;
    expect(r.runs[0]).toEqual({ text: BAND, bold: true });
    expect(r.runs.find((x) => x.link)?.text).toBe('Take 2 mins to learn more');
  });

  it('with the market unset, a market-dependent slot shows the designed refusal, never invented text', () => {
    expect(resolveLegal('crypto-risk-band', 'unset', '2026-10-26')).toEqual({ status: 'missing', rule: null, reason: 'market-unset' });
    const out = html(<LegalSlot moment="crypto-risk-band" market="unset" on="2026-10-26" />);
    expect(out).toContain('data-missing="true"');
    expect(out).not.toContain('Don’t invest');
  });

  it('wording a lawyer must choose is never filled in', () => {
    expect(resolveLegal('crypto-risk-band', 'eu', '2026-10-26')).toMatchObject({ status: 'missing', reason: 'lawyer' });
    expect(resolveLegal('scam-stop', 'uk', '2026-10-26')).toMatchObject({ status: 'missing', reason: 'lawyer' });
  });

  it('a live figure in a fixed text refuses while it is blank', () => {
    expect(resolveLegal('cfd-warning', 'uk', '2026-10-26')).toMatchObject({ status: 'missing', reason: 'value-unset' });
    expect(resolveLegal('cfd-warning', 'uk', '2026-10-26', { percent: '' })).toMatchObject({ reason: 'value-unset' });
    const r = resolveLegal('cfd-warning', 'uk', '2026-10-26', { percent: '74' });
    expect(r.status === 'fixed' && r.runs[0]!.text).toContain('74% of retail investor accounts lose money');
  });

  it('dated wording applies only from its date', () => {
    expect(resolveLegal('credit-warning', 'eu', '2026-11-19').status).toBe('not-applicable');
    expect(resolveLegal('credit-warning', 'eu', '2026-11-20')).toMatchObject({ status: 'fixed' });
  });

  it('draws through the kit slot, which the look gate finds by moment and market', () => {
    const out = html(<LegalSlot moment="crypto-risk-band" market="uk" on="2026-10-26" onLink={() => {}} />);
    expect(out).toContain('class="lit-legal lt-legal-band"');
    expect(out).toContain('data-bold="true"');
    // English fixed text keeps its own direction inside a right-to-left page.
    expect(out).toContain('lang="en" dir="ltr"');
    expect(out).toContain('data-type="risk-band"');
    expect(out).toContain('data-moment="crypto-risk-band"');
    expect(out).toContain('data-jurisdiction="uk"');
    expect(out).not.toContain('data-missing');
    // The rule's link is the kit's learn-more button, with the rule's exact words.
    expect(out).toContain('>Take 2 mins to learn more</button>');
    expect(html(<LegalSlot moment="crypto-risk-band" market="unset" />)).toContain('data-missing="true"');
  });

  it('without a handler the link words stay in the fixed text', () => {
    const out = html(<LegalSlot moment="crypto-risk-band" market="uk" on="2026-10-26" />);
    expect(out).toContain('goes wrong. Take 2 mins to learn more<');
    expect(out).not.toContain('<button');
  });

  it('legal/registry.json is the registry as plain data, for the look gate (vitest -u rewrites it)', async () => {
    await expect(`${JSON.stringify(LEGAL_MOMENTS, null, 2)}\n`).toMatchFileSnapshot('./legal/registry.json');
  });

  it('every moment says what it is in both markets', () => {
    for (const m of Object.values(LEGAL_MOMENTS)) {
      expect(['fixed', 'lawyer', 'not-applicable']).toContain(m.uk.status);
      expect(['fixed', 'lawyer', 'not-applicable']).toContain(m.eu.status);
    }
  });

  it('the band is its own region, before the room title, so it never covers content', () => {
    const out = withLegal(ROOMS.overview({ mode: 'simple', state: 'ready', market: 'uk' }));
    expect(out.indexOf('data-moment="crypto-risk-band"')).toBeGreaterThan(-1);
    expect(out.indexOf('data-moment="crypto-risk-band"')).toBeLessThan(out.indexOf('<h1'));
    expect(out).toContain('aria-label="Risk warning"');
  });
});

describe("times show in the customer's zone and locale", () => {
  it('today shows the time, another day adds the date', async () => {
    const { clock } = await import('./frame.js');
    const now = new Date('2026-10-26T12:00:00Z');
    expect(clock('2026-10-26T10:42:00Z', now, 'en-GB', 'UTC')).toBe('10:42');
    expect(clock('2026-10-26T10:42:00Z', now, 'en-GB', 'Asia/Tokyo')).toBe('19:42');
    expect(clock('2026-10-25T10:42:00Z', now, 'en-GB', 'UTC')).toBe('25 Oct, 10:42');
  });
});

describe('a review with a blank line refuses instead of confirming', () => {
  const review: ReviewData = {
    lines: [{ label: 'Fee', value: null }],
    total: { label: 'Total', value: { value: '250.00', asset: 'GBP' } },
    confirmLabel: 'Send £250.00 to Aisha Khan',
    missing: { variant: 'refused', title: 'Can’t send yet', body: 'The fee isn’t set.' },
  };

  it('shows the refusal and no confirm button', () => {
    const out = html(<Review review={review} />);
    expect(out).toContain('Can’t send yet');
    expect(out).not.toContain('Send £250.00 to Aisha Khan');
    expect(out).toContain('data-unset="true"');
  });

  it('marks an illustrative amount TEST', () => {
    const out = html(<Review review={{ ...review, lines: [{ label: 'Fee', value: { value: '1.00', asset: 'GBP', test: true } }] }} />);
    expect(out).toMatch(/£1\.00 <span class="lt-test">TEST<\/span>/);
  });

  it('names the outcome on the button when complete, beside Edit', () => {
    const out = html(<Review review={{ ...review, lines: [{ label: 'Fee', value: { value: '0.00', asset: 'GBP' } }] }} />);
    expect(out).toContain('>Send £250.00 to Aisha Khan<');
    expect(out).toContain('>Edit<');
    expect(out).not.toMatch(/>(Yes|No|Confirm)</);
  });
});

describe('every template draws every state, on Simple and Pro', () => {
  const ids = Object.keys(templates) as TemplateId[];

  it('has a gallery room for each of the eight templates', () => {
    expect(Object.keys(ROOMS).sort()).toEqual([...ids].sort());
  });

  for (const id of ids) {
    for (const mode of ['simple', 'pro'] as const) {
      it.each(galleryStates)(`${id} (${mode}) in %s`, (state) => {
        const out = html(ROOMS[id]({ mode, state, market: 'uk' }));
        expect(out).toContain(`data-template="${id}"`);
        const kind = state === 'stale' || state === 'partial' ? 'ready' : state;
        expect(out).toContain(`data-state="${kind}"`);
        if (state === 'loading') {
          expect(out).toContain('aria-busy="true"');
          expect(out).toContain('data-busy="true"');
        }
        if (state === 'gated') {
          // The layout shows behind the gate as locked outlines: no figures, and no skeleton bars (never "loading").
          expect(out).toContain('class="lt-locked"');
          expect(out).not.toContain('lt-ghost-item');
          expect(out).not.toMatch(/£\d/);
        }
        if (state === 'confirm' && id === 'flow') expect(out).not.toContain('data-moment="scam-stop"');
        if (state === 'gated') expect(out).toContain('class="lit-gate"');
        if (state === 'refused') expect(out).toContain('data-refusal="parked"');
        if (state === 'stale') expect(out).toContain('Figures as of 10:43, updated 4 min ago');
      });
    }
  }

  it('Pro changes content, not only density', () => {
    const simple = html(ROOMS.monitor({ mode: 'simple', state: 'ready', market: 'uk' }));
    const pro = html(ROOMS.monitor({ mode: 'pro', state: 'ready', market: 'uk' }));
    expect((simple.match(/lt-figure-cell/g) ?? []).length).toBe(1);
    expect((pro.match(/lt-figure-cell/g) ?? []).length).toBe(4);
    expect(html(ROOMS.desk({ mode: 'pro', state: 'ready', market: 'uk' }))).toContain('data-region="book"');
    expect(html(ROOMS.desk({ mode: 'simple', state: 'ready', market: 'uk' }))).not.toContain('data-region="book"');
  });
});

describe('states never contradict themselves', () => {
  it('partial blanks what depends on the missing data, and pauses trading', () => {
    const out = html(ROOMS.desk({ mode: 'pro', state: 'partial', market: 'uk' }));
    expect(out).toContain('Price unavailable');
    expect(out).toContain('Trading pauses until prices are back');
    expect(out).not.toContain('81,040.00');
    expect(out).not.toContain('Review order');
  });

  it('stale holds trading until a refresh', () => {
    const out = html(ROOMS.desk({ mode: 'simple', state: 'stale', market: 'uk' }));
    expect(out).toContain('Refresh prices to trade');
    expect(out).not.toContain('Review order');
  });

  it('returned money reads as returned, in a neutral tone, with its own next step', () => {
    const out = html(ROOMS.flow({ mode: 'simple', state: 'money-status', market: 'uk' }));
    expect(out).toContain('Returned to your balance');
    expect(out).toContain('data-returned="true"');
    expect(out).not.toContain('Didn’t go through');
    expect(out).not.toContain('within 2 hours');
  });

  it('the flow stepper follows the state', () => {
    expect(html(ROOMS.flow({ mode: 'simple', state: 'confirm', market: 'uk' }))).toContain('aria-label="Step 4 of 4"');
    expect(html(ROOMS.flow({ mode: 'simple', state: 'empty', market: 'uk' }))).toContain('aria-label="Step 1 of 4"');
    expect(html(ROOMS.flow({ mode: 'simple', state: 'receipt', market: 'uk' }))).not.toContain('lt-stepper');
  });

  it('a data slot passed as null still draws its skeleton while loading and its outline behind a gate', async () => {
    const { OverviewTemplate } = await import('./templates.js');
    const room = (state: 'loading' | 'gated') =>
      html(
        <OverviewTemplate
          title="Home"
          state={
            state === 'loading'
              ? { kind: 'loading' }
              : { kind: 'gated', gate: 'not-verified', refusal: { variant: 'refused', title: 'Verify', body: 'Verify first.' } }
          }
          hero={null}
          needsYou={null}
          sections={null}
        />,
      );
    expect(room('loading')).toContain('data-region="hero"');
    expect(room('loading')).toContain('data-busy="true"');
    expect(room('gated')).toContain('class="lt-locked"');
    expect(room('gated')).toContain('data-region="sections"');
    expect(html(<OverviewTemplate title="Home" state={{ kind: 'ready' }} hero={null} />)).not.toContain('data-region="hero"');
    const missing = { variant: 'unreachable' as const, title: 'Prices down', body: 'Back soon.' };
    const partial = html(
      <OverviewTemplate
        title="Home"
        state={{ kind: 'ready', partial: { missing, regions: { hero: 'Balance unavailable' } } }}
        hero={null}
      />,
    );
    expect(partial).toContain('Balance unavailable');
    const stale = html(
      <OverviewTemplate
        title="Home"
        state={{ kind: 'ready', stale: { asOf: '2026-10-26T10:43:00Z', regions: { hero: 'Refresh to see it' } } }}
        hero={null}
      />,
    );
    expect(stale).toContain('Refresh to see it');
  });

  it('every labelled data region stays on screen with null data, in loading, gated, partial and stale', async () => {
    const { OverviewTemplate } = await import('./templates.js');
    const missing = { variant: 'unreachable' as const, title: 'Prices down', body: 'Back soon.' };
    const states = [
      { kind: 'loading' },
      { kind: 'gated', gate: 'not-verified', refusal: missing },
      { kind: 'ready', partial: { missing } },
      { kind: 'ready', stale: { asOf: '2026-10-26T10:43:00Z' } },
    ] as const;
    for (const state of states) {
      const out = html(<OverviewTemplate title="Home" state={state} hero={null} needsYou={null} sections={null} watching={null} />);
      for (const region of ['hero', 'needs-you', 'sections', 'watching'])
        expect(out, `${state.kind} ${region}`).toContain(`data-region="${region}"`);
    }
    const partial = html(<OverviewTemplate title="Home" state={states[2]} hero={null} needsYou={null} />);
    expect(partial).toContain('Needs you can’t be shown right now');
    expect(html(<OverviewTemplate title="Home" state={states[3]} hero={null} needsYou={null} />)).toContain('Refresh to see needs you');
  });

  it('behind a gate, no region of a ready room disappears: data shows locked, controls stay visible', () => {
    const LIVE = new Set(['rooms', 'help', 'index', 'contact', 'filters', 'toc']);
    const regions = (out: string) => new Set([...out.matchAll(/data-region="([^"]+)"/g)].map((m) => m[1] ?? ''));
    for (const [id, room] of Object.entries(ROOMS)) {
      for (const mode of ['simple', 'pro'] as const) {
        const ready = regions(html(room({ mode, state: 'ready', market: 'uk' })));
        const gated = regions(html(room({ mode, state: 'gated', market: 'uk' })));
        for (const r of ready) {
          // Live regions draw outside the Gate as plain content (lt-live), so they carry no region tag there;
          // in-flight movements are figures, which a gated room never shows.
          if (LIVE.has(r) || r === 'in-flight') continue;
          expect(gated.has(r), `${id} ${mode} ${r}`).toBe(true);
        }
      }
    }
  });

  it('behind a gate, a data region never draws its figures, labelled or not', () => {
    const out = html(
      <RoomFrame
        template="overview"
        title="T"
        state={{ kind: 'gated', gate: 'not-verified', refusal: { variant: 'refused', title: 'Verify', body: 'B' } }}
      >
        <Region name="a" data>
          <p>FIGURE-A</p>
        </Region>
        <Region name="b" data label="Balance">
          <p>FIGURE-B</p>
        </Region>
      </RoomFrame>,
    );
    expect(out).not.toContain('FIGURE');
    expect(out).toContain('lt-locked');
  });

  it('the risk band slot tells the focus tracker it covers the top; direction colours stay inside rooms', () => {
    const out = withLegal(ROOMS.overview({ mode: 'simple', state: 'ready', market: 'uk' }));
    expect(out).toContain('class="lt-band-slot" data-obscures="top"');
    const css = readFileSync(fileURLToPath(new URL('./templates.css', import.meta.url)), 'utf8');
    expect(css).not.toMatch(/^\[data-dir=/m);
  });

  it('behind a gate, tabs and section indexes stay live, outside the gate, before its card', () => {
    for (const [room, marker] of [
      ['catalogue', 'Flexible'],
      ['reading', 'aria-label="On this page"'],
      ['settings', 'aria-label="Settings sections"'],
    ] as const) {
      const out = html(ROOMS[room]({ mode: 'simple', state: 'gated', market: 'uk' }));
      const gate = out.indexOf('class="lit-gate');
      const at = out.indexOf(marker);
      expect(gate, room).toBeGreaterThan(-1);
      expect(at, room).toBeGreaterThan(-1);
      expect(at, room).toBeLessThan(gate);
    }
    // A side-column room gates only its main area: the index keeps its grid column beside it.
    const settings = html(ROOMS.settings({ mode: 'simple', state: 'gated', market: 'uk' }));
    expect(settings).toMatch(/lt-grid-settings"><section[^>]*data-region="index"[\s\S]*class="lt-gate-area"/);
  });

  it('behind a gate, reading keeps "Talk to a person" live and draws no empty index', async () => {
    const out = html(ROOMS.reading({ mode: 'simple', state: 'gated', market: 'uk' }));
    // The inert room's own markup: from its opening div to the div that closes it.
    const open = out.lastIndexOf('<div', out.indexOf('lit-gate__room'));
    let depth = 0;
    let end = open;
    for (const m of out.slice(open).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === '<div' ? 1 : -1;
      if (depth === 0) {
        end = open + (m.index ?? 0);
        break;
      }
    }
    const inert = out.slice(open, end);
    expect(inert).toContain('data-region="body"');
    expect(out).toContain('Talk to a person');
    expect(inert).not.toContain('Talk to a person');
    const { ReadingTemplate } = await import('./templates.js');
    const gated = { kind: 'gated', gate: 'not-verified', refusal: { variant: 'refused', title: 'V', body: 'B' } } as const;
    const empty = html(<ReadingTemplate title="Fees" state={gated} body={null} toc={null} />);
    expect(empty).not.toContain('data-region="toc"');
  });

  it('behind a gate, "Talk to a person" stays outside the inert room', () => {
    const out = html(ROOMS.flow({ mode: 'simple', state: 'gated', market: 'uk' }));
    // The live help sits after the Gate, in its own lt-live block, never inside the inert room.
    const live = out.lastIndexOf('class="lt-live"');
    const room = out.slice(out.indexOf('lit-gate__room'), live);
    expect(room).not.toContain('Talk to a person');
    expect(out.slice(live)).toContain('Talk to a person');
    // The card comes before the room, in the flow.
    expect(out.indexOf('lit-gate__card')).toBeLessThan(out.indexOf('lit-gate__room'));
    expect(out).toContain('>Verify now</a>');
    // Controls stay named and dimmed behind the gate, never folded into a lock.
    expect(out).toMatch(/data-region="actions" data-dimmed="true"[^>]*>[\s\S]*Continue/);
  });

  it('room actions leave whole-room states, so the state has the only primary', () => {
    for (const state of ['empty', 'confirm', 'money-status', 'receipt'] as const) {
      const out = html(ROOMS.overview({ mode: 'simple', state, market: 'uk' }));
      expect(out).not.toContain('data-region="actions"');
    }
  });

  it('a send carries the scam warning before its button; a buy from your own balance does not', () => {
    const send = withLegal(ROOMS.flow({ mode: 'simple', state: 'confirm', market: 'uk' }));
    expect(send).toContain('data-slot="scam-warning"');
    expect(send.indexOf('data-moment="scam-stop"')).toBeLessThan(send.indexOf('Send £250.00 to Aisha Khan'));
    expect(withLegal(ROOMS.monitor({ mode: 'simple', state: 'confirm', market: 'uk' }))).not.toContain('scam-stop');
  });

  it('with the legal switch off (the default), no band, no legal slot and no space kept for the band', () => {
    for (const id of Object.keys(templates) as TemplateId[]) {
      for (const state of ['ready', 'confirm', 'gated'] as const) {
        const out = html(ROOMS[id]({ mode: 'simple', state, market: 'uk' }));
        expect(out).not.toContain('lt-band-slot');
        expect(out).not.toContain('lit-legal');
        expect(out).not.toContain('data-band');
      }
    }
    expect(withLegal(ROOMS.overview({ mode: 'simple', state: 'ready', market: 'uk' }))).toContain('data-band="true"');
    const css = readFileSync(fileURLToPath(new URL('./templates.css', import.meta.url)), 'utf8');
    const bandOffsets = css.split('}').filter((rule) => rule.includes('--lit-legal-band-min-h'));
    expect(bandOffsets.length).toBeGreaterThan(0);
    for (const rule of bandOffsets) expect(rule).toMatch(/\.lt-legal-band|\[data-band\]/);
  });
});

describe('gallery fixtures are shaped as the API sends them', () => {
  it('holdings are decimal strings, as ledgerHoldingSchema requires', () => {
    for (const h of HOLDINGS) expect(h.amount).toMatch(/^\d+(\.\d+)?$/);
  });
});
