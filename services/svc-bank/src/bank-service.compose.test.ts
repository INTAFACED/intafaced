import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AreaChain } from './area-chain.js';

/**
 * A bank area is declared in one place (project-state #2826): its own folder's `compose.ts`, listed in `src/areas.ts`.
 * `BankServices` and `BankServiceOptions` are derived from that list, so `bank-service.ts` never changes for a new
 * area or service. This holds the line the types cannot: an area wired in `bank-service.ts` beside the list (an
 * import of its compose, an `extends` on the two interfaces, a spread or a `new …(` in `createBankServices`) still
 * compiles, so it is refused here, with the place to add it instead.
 */
const FIX =
  "a bank area is wired only in src/areas.ts: write compose<Area>Area(root, made, options) in src/<area>/compose.ts and add `.add(compose<Area>Area)` to BANK_AREAS after the areas it reads; a service of an existing area goes in that area's compose.ts. bank-service.ts does not change";

/** The part of `bank-service.ts` that never changes: its two interfaces and `createBankServices`. */
const FIXED = `/** Every service svc-bank makes: the services of every area in \`areas.ts\`. */
export interface BankServices extends BankAreaServices {}

/** Every option svc-bank reads: the shared root's (\`bank-root.ts\`) and every area's own. */
export interface BankServiceOptions extends BankRootOptions, BankAreaOptions {}

export function createBankServices(
  sql: Sql,
  bookLedger: LedgerClient,
  history: LedgerHistory,
  options: BankServiceOptions = {},
): BankServices {
  return BANK_AREAS.compose(composeBankRoot(sql, bookLedger, history, options), options);
}
`;

/** What in `bank-service.ts` wires an area beside `areas.ts`; empty when nothing does. */
function wiredBesideAreas(source: string): string[] {
  const problems: string[] = [];
  if (!source.includes(FIXED)) problems.push('BankServices, BankServiceOptions or createBankServices changed');
  for (const m of source.matchAll(/^import [^;]*? from '(\.[^']*\/compose\.js)'/gm)) problems.push(`imports ${m[1]}`);
  for (const m of source.matchAll(/\bnew [A-Z]\w*\(/g)) problems.push(`constructs ${m[0]}`);
  for (const m of source.matchAll(/\bcompose\w*\(/g)) {
    if (m[0] !== 'compose(' && m[0] !== 'composeBankRoot(') problems.push(`calls ${m[0]}`);
  }
  return problems;
}

const source = readFileSync(new URL('./bank-service.ts', import.meta.url), 'utf8');

describe('a bank area is wired in areas.ts, never in bank-service.ts', () => {
  it('bank-service.ts only joins the root and the areas', () => {
    expect(wiredBesideAreas(source), FIX).toEqual([]);
  });

  it('refuses the past mistake: the developer API area wired in bank-service.ts (05048fa448), replayed on today', () => {
    // The three edits that commit made, on today's file: an import, the two `extends` lists, and a spread.
    const replayed = source
      .replace(
        'import { BANK_AREAS,',
        "import { composeDeveloperApiServices, type DeveloperApiServiceOptions, type DeveloperApiServices } from './developer-api/compose.js';\nimport { BANK_AREAS,",
      )
      .replace('extends BankAreaServices {}', 'extends BankAreaServices, DeveloperApiServices {}')
      .replace('extends BankRootOptions, BankAreaOptions {}', 'extends BankRootOptions, BankAreaOptions, DeveloperApiServiceOptions {}')
      .replace(
        '  return BANK_AREAS.compose(composeBankRoot(sql, bookLedger, history, options), options);',
        '  const root = composeBankRoot(sql, bookLedger, history, options);\n  return { ...BANK_AREAS.compose(root, options), ...composeDeveloperApiServices(root, options) };',
      );
    expect(replayed).not.toBe(source);
    expect(wiredBesideAreas(replayed)).toEqual([
      'BankServices, BankServiceOptions or createBankServices changed',
      'imports ./developer-api/compose.js',
      'calls composeDeveloperApiServices(',
    ]);
  });

  it('refuses a service made inline in bank-service.ts (df8280d1d4, 430246139c wired theirs there)', () => {
    const inline = source.replace(
      '  return BANK_AREAS.compose(',
      '  const currencies = new CurrencyService(sql, bookLedger, null as never, {});\n  return BANK_AREAS.compose(',
    );
    expect(wiredBesideAreas(inline)).toContain('constructs new CurrencyService(');
  });

  it('two areas never make the same service: a clash a cast hid from the types refuses at boot', () => {
    const clash = AreaChain.over<null>()
      .add(function composeCardsArea() {
        return { cards: 'first' };
      })
      .add(function composeOtherArea() {
        return { cards: 'second' };
      } as () => object);
    expect(() => clash.compose(null, {})).toThrow('svc-bank area composeOtherArea makes cards, which an earlier area in areas.ts made');
  });
});
