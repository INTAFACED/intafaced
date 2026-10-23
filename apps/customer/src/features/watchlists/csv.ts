/**
 * A list as a CSV file, and a CSV file read back into a list. Import adds only symbols the listing offers: each row is judged on
 * its own, so one unknown symbol refuses that row and nothing else. Every number stays the decimal string the feed sent.
 */
import type { WatchlistValue } from '@intafaced/contracts/watchlists-preferences';
import type { MarketRow, TickerRow } from '../../data';
import { listedSymbol } from './model';

export const EXPORT_HEADER = ['symbol', 'section', 'last', 'change_pct_24h', 'high_24h', 'low_24h', 'volume_24h'] as const;

function cell(value: string | null | undefined): string {
  const text = value ?? '';
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The list in section order: one row per symbol. A quote with no value is an empty cell, not a zero. */
export function exportListCsv(list: WatchlistValue, tickers: Readonly<Record<string, TickerRow>> | undefined): string {
  const lines = [EXPORT_HEADER.join(',')];
  for (const section of list.sections)
    for (const symbol of section.symbols) {
      const ticker = tickers?.[symbol];
      lines.push(
        [
          cell(symbol),
          cell(section.title),
          cell(ticker?.last),
          cell(ticker?.changePct24h),
          cell(ticker?.high24h),
          cell(ticker?.low24h),
          cell(ticker?.baseVolume24h),
        ].join(','),
      );
    }
  return `${lines.join('\n')}\n`;
}

/** The file name a list downloads as: its name, lower case, dashes for anything that is not a letter or digit. */
export function exportFileName(name: string): string {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `watchlist-${stem || 'list'}.csv`;
}

/** One field of a CSV line, with quotes read the way RFC 4180 writes them. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      out.push(field);
      field = '';
    } else field += char;
  }
  out.push(field);
  return out;
}

export type ImportRefusal = { line: number; value: string; reason: 'unknown symbol' | 'not a symbol' };
export interface ImportResult {
  /** Listing symbols to add, in file order, each once. */
  accepted: string[];
  /** Rows that named a symbol already on the list (or repeated in the file). Not an error. */
  already: number;
  refused: ImportRefusal[];
}

/**
 * Reads a CSV of symbols. The first column is the symbol (a header row naming `symbol` is skipped). A row whose symbol the
 * listing does not offer is refused for that row; the other rows still count.
 */
export function readImportCsv(text: string, markets: readonly MarketRow[], onList: ReadonlySet<string>): ImportResult {
  const accepted: string[] = [];
  const seen = new Set<string>();
  const refused: ImportRefusal[] = [];
  let already = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    const value = splitCsvLine(raw)[0]?.trim() ?? '';
    if (index === 0 && value.toLowerCase() === 'symbol') return;
    if (!value) return;
    if (!/^[A-Za-z0-9._-]{1,32}[/-][A-Za-z0-9._:-]{1,32}$/.test(value)) {
      refused.push({ line: index + 1, value, reason: 'not a symbol' });
      return;
    }
    const market = listedSymbol(markets, value);
    if (!market) {
      refused.push({ line: index + 1, value, reason: 'unknown symbol' });
      return;
    }
    if (onList.has(market.symbol) || seen.has(market.symbol)) {
      already += 1;
      return;
    }
    seen.add(market.symbol);
    accepted.push(market.symbol);
  });
  return { accepted, already, refused };
}

/** The one line a person reads: "2 added, 1 refused: unknown symbol". Blank counts are left out. */
export function importSummary(result: ImportResult): string {
  const parts = [`${result.accepted.length} added`];
  const unknown = result.refused.filter((row) => row.reason === 'unknown symbol').length;
  const malformed = result.refused.filter((row) => row.reason === 'not a symbol').length;
  if (unknown) parts.push(`${unknown} refused: unknown symbol`);
  if (malformed) parts.push(`${malformed} refused: not a symbol`);
  if (result.already) parts.push(`${result.already} already listed`);
  return parts.join(', ');
}
