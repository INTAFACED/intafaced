import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../shared/preferences', async (original) => {
  const real = await original<typeof import('../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { TotalFigure, TotalUnitNote } from '../screens/home/TotalFigure';
import { fromServer, toHomePortfolio, type ServerSummary } from '../screens/money/portfolio-source';

// HM-dashboard-01, ORD-007: Home reads money and never writes or keeps it. The custody scan walks Protocol Plane services
// only, so this file is what fails when the customer app reaches for a ledger write recipe or turns a money string into a
// float on Home.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx|mts|mjs)$/.test(name) ? [full] : [];
  });
}

describe('the customer app reads money only', () => {
  it('imports nothing from the ledger client; its math comes from @intafaced/money-math', () => {
    const offenders = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/['"](@intafaced\/ledger-client(?:\/[^'"]*)?|[^'"]*packages\/ledger-client[^'"]*)['"]/g)]
        .map((match) => match[1]!)
        .map((specifier) => `${path.relative(SRC, file)}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never turns a figure on Home into a float', () => {
    const offenders = sources(path.join(SRC, 'screens/home'))
      .filter((file) => !/\.(test|pw|config)\.|\.config\.|harness|fixtures/.test(path.basename(file)))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            /\bparseFloat\(|\bNumber\(|\.toFixed\(/.test(line) ? [`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`] : [],
          ),
      );
    expect(offenders).toEqual([]);
  });
});

const summary = (extra: Partial<ServerSummary> = {}): ServerSummary => ({
  totalUsd: '1234567.89',
  change24hUsd: null,
  cashUsd: '0.01',
  cryptoUsd: '1234567.88',
  priced: [
    {
      asset: 'BTC',
      amount: '12.345678901234567891',
      priceUsd: '100000',
      valueUsd: '1234567.890123456789',
      change24hUsd: null,
      pair: 'BTC/USDT',
    },
    { asset: 'USDT', amount: '0.010000000000000001', priceUsd: '1', valueUsd: '0.010000000000000001', change24hUsd: '0', pair: null },
  ],
  unpriced: [],
  asOf: 1,
  windowStart: null,
  ...extra,
});

const text = (html: string) => html.replace(/<[^>]+>/g, '');
/** What a screen reader (and a person) is told the figure is: the hero number's spoken label. */
const spoken = (html: string) => /aria-label="([^"]+)"/.exec(html)?.[1] ?? null;

describe('Home total in the display unit (HM-dashboard-01)', () => {
  it('shows the bank total in dollars verbatim, with 18-decimal holdings underneath', () => {
    const data = toHomePortfolio(fromServer(summary()));
    expect(data.holdings[0]!.total).toBe('12.345678901234567891');
    expect(spoken(renderToString(<TotalFigure data={data} displayCurrency="USD" hidden={false} pro={false} />))).toBe('$1,234,567.89');
    expect(renderToString(<TotalUnitNote data={data} displayCurrency="USD" hidden={false} className="n" />)).toBe('');
  });

  it('shows the bank’s own BTC total when the unit is BTC, and the dollar figure in the note', () => {
    const data = toHomePortfolio(fromServer(summary({ btc: { total: '12.345678901234567891', priceUsd: '100000', reason: null } })));
    // Rounded once, half up, to 8 places from the server's string: never the dollar total divided on this device.
    expect(spoken(renderToString(<TotalFigure data={data} displayCurrency="BTC" hidden={false} pro />))).toBe('₿12.34567890');
    const note = text(renderToString(<TotalUnitNote data={data} displayCurrency="BTC" hidden={false} className="n" />));
    expect(note).toBe('Shown in BTC at the current BTC price. In dollars: $1234567.89');
    // Hidden balances keep the dollar figure out of the note too.
    expect(text(renderToString(<TotalUnitNote data={data} displayCurrency="BTC" hidden className="n" />))).toBe(
      'Shown in BTC at the current BTC price.',
    );
  });

  it('keeps dollars with a note, and no error, when BTC is chosen and the bank has no BTC price', () => {
    const data = toHomePortfolio(fromServer(summary({ btc: { total: null, priceUsd: null, reason: 'no_price_published' } })));
    expect(spoken(renderToString(<TotalFigure data={data} displayCurrency="BTC" hidden={false} pro={false} />))).toBe('$1,234,567.89');
    expect(text(renderToString(<TotalUnitNote data={data} displayCurrency="BTC" hidden={false} className="n" />))).toBe(
      'There is no BTC price right now, so the total is shown in dollars.',
    );
  });

  it('says the total stays in dollars when BTC is chosen and the total was built on this device (bank not answering)', () => {
    const data = { ...toHomePortfolio(fromServer(summary())), source: 'derived' as const, btc: null };
    expect(text(renderToString(<TotalUnitNote data={data} displayCurrency="BTC" hidden={false} className="n" />))).toBe(
      'There is no BTC price right now, so the total is shown in dollars.',
    );
  });

  it('never writes "$null" when the dollar total cannot be read', () => {
    const data = toHomePortfolio(fromServer(summary({ totalUsd: 'n/a', btc: { total: '1', priceUsd: '1', reason: null } })));
    expect(text(renderToString(<TotalUnitNote data={data} displayCurrency="BTC" hidden={false} className="n" />))).toBe(
      'Shown in BTC at the current BTC price. In dollars: —',
    );
  });
});
