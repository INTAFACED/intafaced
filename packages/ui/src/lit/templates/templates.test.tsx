// Lane B2: the templates' honesty rules, as tests. Rendered to static markup.
import * as React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { templates, type TemplateId } from '../contracts.js';
import { Bars, Parts } from '../components/b2-charts.js';
import { Review } from './frame.js';
import { LEGAL_MOMENTS, resolveLegal } from './legal/registry.js';
import { LegalSlot } from './legal/LegalSlot.js';
import { formatMoney, reconcileParts, sumDecimals } from './money.js';
import { HOLDINGS, ROOMS, galleryStates } from './__gallery__/fixtures.js';
import type { ReviewData } from './types.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('chart parts reconcile to the total they show (plan v2 row 9)', () => {
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
    expect(out).toContain('data-legal-status="missing"');
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

  it('every moment says what it is in both markets', () => {
    for (const m of Object.values(LEGAL_MOMENTS)) {
      expect(['fixed', 'lawyer', 'not-applicable']).toContain(m.uk.status);
      expect(['fixed', 'lawyer', 'not-applicable']).toContain(m.eu.status);
    }
  });

  it('the band is its own region, before the room title, so it never covers content', () => {
    const out = html(ROOMS.overview({ mode: 'simple', state: 'ready', market: 'uk' }));
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
          // The layout shows behind the gate, with no figures from the data.
          expect(out).toContain('data-ghost=');
          expect(out).not.toMatch(/£\d/);
          expect(out).toContain('inert=""');
        }
        if (state === 'refused') expect(out).toContain('data-refusal="parked"');
        if (state === 'stale') expect(out).toContain('Updated 4 min ago');
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

describe('gallery fixtures are shaped as the API sends them', () => {
  it('holdings are decimal strings, as ledgerHoldingSchema requires', () => {
    for (const h of HOLDINGS) expect(h.amount).toMatch(/^\d+(\.\d+)?$/);
  });
});
