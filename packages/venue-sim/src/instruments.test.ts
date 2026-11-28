import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTestInstruments } from './instruments.js';
import { TEST_VENUE_MARKETS } from './http-server.js';

function dirWith(files: Record<string, string>): URL {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-instruments-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return pathToFileURL(dir + path.sep);
}

const market = (symbol: string) => `export default { market: { symbol: '${symbol}' } };\n`;

describe('the TEST instruments, one file each', () => {
  it('lists every instrument file in file-name order, each market the symbol its file is named for', () => {
    const files = fs
      .readdirSync(new URL('./instruments/', import.meta.url))
      .filter((name) => /^\d{4}-/.test(name))
      .sort();
    expect(TEST_VENUE_MARKETS.map((m) => m.symbol)).toEqual(files.map((name) => name.replace(/^\d{4}-/, '').replace(/\.ts$/, '')));
    expect(TEST_VENUE_MARKETS[0]?.symbol).toBe('BTC-USDC');
    expect(TEST_VENUE_MARKETS[1]?.symbol).toBe('BTC-PERP');
  });

  it('orders by the file-name prefix and skips files that are not instruments', async () => {
    const dir = dirWith({ '0020-B-PERP.js': market('B-PERP'), '0010-A-PERP.js': market('A-PERP'), 'shared.js': 'export {};\n' });
    expect((await loadTestInstruments(dir)).map((i) => i.market.symbol)).toEqual(['A-PERP', 'B-PERP']);
  });

  it('refuses a file whose market is not the symbol it is named for', async () => {
    const dir = dirWith({ '0010-A-PERP.js': market('B-PERP') });
    await expect(loadTestInstruments(dir)).rejects.toThrow(
      'TEST instrument file 0010-A-PERP.js must default-export the market A-PERP, got B-PERP',
    );
  });

  it('refuses a symbol named by two files', async () => {
    const dir = dirWith({ '0010-A-PERP.js': market('A-PERP'), '0020-A-PERP.js': market('A-PERP') });
    await expect(loadTestInstruments(dir)).rejects.toThrow('TEST instrument A-PERP is named by two files');
  });
});
