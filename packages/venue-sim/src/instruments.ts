import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { TestInstrument } from './instruments/shared.js';

export type { TestInstrument } from './instruments/shared.js';

/** A module's default export when it is an instrument: an object whose `market` names a symbol. */
function defaultOf(mod: unknown): TestInstrument | null {
  const value: unknown = mod !== null && typeof mod === 'object' ? Reflect.get(mod, 'default') : undefined;
  if (value === null || typeof value !== 'object') return null;
  const market: unknown = Reflect.get(value, 'market');
  if (market === null || typeof market !== 'object' || typeof Reflect.get(market, 'symbol') !== 'string') return null;
  return isInstrument(value) ? value : null;
}

/** The shape check `defaultOf` has already made, as a type guard. */
function isInstrument(value: object): value is TestInstrument {
  return 'market' in value;
}

/** An instrument's file: `<four-digit order>-<symbol>.ts` (`.js` once built). */
const INSTRUMENT_FILE = /^(\d{4})-([A-Z0-9]+(?:-[A-Z0-9]+)*)\.(?:ts|js)$/;

/**
 * The stack's TEST instruments, one file each in `./instruments/`, in file-name order. Adding one adds only its own file,
 * so journeys built side by side never edit the same lines. A file whose market is not the symbol it is named for, or a
 * symbol named twice, refuses the venue's start.
 */
export async function loadTestInstruments(dir: URL = new URL('./instruments/', import.meta.url)): Promise<readonly TestInstrument[]> {
  const names = fs
    .readdirSync(dir)
    .filter((name) => INSTRUMENT_FILE.test(name))
    .sort();
  const out: TestInstrument[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const symbol = INSTRUMENT_FILE.exec(name)?.[2];
    if (symbol === undefined) continue;
    const mod: unknown = await import(pathToFileURL(new URL(name, dir).pathname).href);
    const instrument = defaultOf(mod);
    if (!instrument || instrument.market.symbol !== symbol)
      throw new Error(`TEST instrument file ${name} must default-export the market ${symbol}, got ${instrument?.market.symbol}`);
    if (seen.has(symbol)) throw new Error(`TEST instrument ${symbol} is named by two files`);
    seen.add(symbol);
    out.push(instrument);
  }
  return out;
}
