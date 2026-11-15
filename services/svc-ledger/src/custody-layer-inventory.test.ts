import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { movesCustomerBalance } from '@intafaced/ledger-client';
import { recipeGateSamples, unsampledRecipeNames } from './recipe-gate.js';

/**
 * Pins `customerBalanceRecipes` in tooling/ci/custody-layer-inventory.json (custody-scan check 4) to the ledger's own
 * recipe samples. A recipe is a customer-balance recipe when any sampled shape of it has a leg on a customer account
 * (`isCustomerBalanceAccount`). A new recipe that touches a customer account, or a recipe whose legs change, fails here
 * until the list says so, so the static check can never quietly stop looking for it.
 */
const inventoryPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tooling', 'ci', 'custody-layer-inventory.json');

describe('custody-layer inventory: customer-balance recipes', () => {
  it('every recipe is sampled, so none escapes the classification', () => {
    expect(unsampledRecipeNames()).toEqual([]);
  });

  it('the inventory lists exactly the recipes whose samples move a customer balance', () => {
    const customer = new Set<string>();
    for (const s of recipeGateSamples()) if (movesCustomerBalance(s.post.entries)) customer.add(s.name);
    const listed = (JSON.parse(readFileSync(inventoryPath, 'utf8')) as { customerBalanceRecipes: string[] }).customerBalanceRecipes;
    expect([...listed].sort()).toEqual([...customer].sort());
  });
});
