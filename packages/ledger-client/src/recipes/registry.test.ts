import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recipes, type RecipeName } from './index.js';
import { RECIPE_MATRIX } from './live-path-inventory.js';

/**
 * THE RECIPE REGISTRY IS THE PRODUCT SURFACE.
 *
 * RECIPES.md is the human matrix. This test is the machine one: if a recipe is
 * added or removed without updating the documented count, the suite fails and
 * someone has to name the change. The number is not magic — it is the length of
 * `export const recipes` on tip (55 after D26-P1-M2 listing/premium fee sockets
 * on top of the 53 from businessApproval* + marketPurchase / D26-P2-11). Bump
 * it with intent.
 *
 * After market commerce landed, the matrix still said 49 and omitted
 * `marketPurchase` while the registry required 50 — honesty residual closed
 * here: count + named row must match registry keys. #1643 added three
 * business-approval recipes and bumped the registry length to 53 without the
 * header — D26-P2-11 closes that count lie (and the live-path inventory).
 * D26-P1-M2 adds two §13 market fee recipes → 55. businessPayroll → 56.
 * orderHoldAmend (qty-up extra hold, same pot as orderHold) → 57.
 * merchant proceeds payout trio → 60.
 * fxConversion + fxConversionReverse (W6 sandbox USD→USDT) → 62.
 * fxConversionHold + fxConversionRelease (clearing reserved around the venue call) → 64.
 */
describe('recipes registry', () => {
  it('exports every named recipe and nothing unnamed', () => {
    const names = Object.keys(recipes) as RecipeName[];
    expect(names.length).toBe(64);
    expect(names).toContain('marketPurchase');
    expect(names).toContain('businessApprovalHold');
    expect(names).toContain('businessPayroll');
    expect(names).toContain('marketListingFee');
    expect(names).toContain('marketPremiumPlacement');
    expect(names).toContain('orderHoldAmend');
    // Every key is a callable pure function.
    for (const name of names) {
      expect(typeof recipes[name]).toBe('function');
    }
  });

  it('RECIPES.md matrix names every registry key (count + rows)', () => {
    const mdPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'RECIPES.md');
    const md = readFileSync(mdPath, 'utf8');
    const countMatch = md.match(/\*\*(\d+) pure recipes\.\*\*/);
    expect(countMatch?.[1], 'RECIPES.md must state the pure-recipe count').toBe('64');

    const rowNames = [...md.matchAll(/^\| `([a-zA-Z][a-zA-Z0-9]*)`\s*\|/gm)].map((m) => m[1]!);
    const registry = Object.keys(recipes).sort();
    expect(rowNames.sort()).toEqual(registry);
  });

  it('RECIPES.md states the chargeback four as §13 sockets and names the svc-pay post', () => {
    const recipesDir = dirname(fileURLToPath(import.meta.url));
    const md = readFileSync(join(recipesDir, '..', '..', 'RECIPES.md'), 'utf8');
    const paySrc = readFileSync(join(recipesDir, '..', '..', '..', '..', 'services/svc-pay/src/chargeback-ledger.ts'), 'utf8');
    expect(paySrc).toMatch(/\brecipes\.chargebackOpen\b/);

    for (const name of ['chargebackOpen', 'chargebackShortfall', 'chargebackWon', 'chargebackShortfallRecovered'] as const) {
      const row = RECIPE_MATRIX[name];
      expect(row.kind).toBe('socket');
      if (row.kind !== 'socket') continue;
      expect(row.socket).toBe('§13');
    }

    const closure = md.split('\n').find((line) => line.includes('D26-P2-11 live-path closure'));
    expect(closure).toMatch(/every registry key is `live` \(production caller\) or an explicit §13 socket/);
    expect(closure).not.toMatch(/other than `chargebackOpen`/);
    expect(closure).not.toMatch(/not a §13 socket/);
    expect(closure).not.toMatch(/unwired/);
    expect(closure).toMatch(
      /`chargebackOpen`, `chargebackShortfall`, `chargebackWon`, and `chargebackShortfallRecovered` are explicit §13 sockets/,
    );
    expect(closure).toMatch(/not `live`/);
    expect(closure).toMatch(/`chargebackOpen` is posted from `services\/svc-pay\/src\/chargeback-ledger\.ts`/);

    const sourceRow = md.split('\n').find((line) => line.includes('`src/recipes/chargeback.ts`'));
    expect(sourceRow).not.toMatch(/not wired|unwired/);
    expect(sourceRow).toMatch(/explicit §13 sockets/);
    expect(sourceRow).toMatch(/chargeback-ledger\.ts/);

    const note = md.split('\n').find((line) => line.startsWith('- **Chargeback**'));
    expect(note).not.toMatch(/unwired|not wired/);
    expect(note).toMatch(/explicit §13 sockets/);
    expect(note).toMatch(/not `live`/);
    expect(note).toMatch(/services\/svc-pay\/src\/chargeback-ledger\.ts/);

    expect(md).not.toMatch(/not a §13 socket/);
    const market = md.split('\n').find((line) => line.includes('**Market listing / premium fees**'));
    expect(market).toMatch(/§13 unwired \(D26-P1-M2\)/);
  });
});
