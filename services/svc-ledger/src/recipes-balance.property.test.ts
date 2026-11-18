import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { recipes, type PostRequest } from '@intafaced/ledger-client';
import { recipeGateSamples } from './recipe-gate.js';

/**
 * EVERY RECIPE'S POSTINGS SUM TO ZERO PER ASSET, FOR ANY AMOUNTS.
 *
 * The recipe gate already holds a sample call of every registry recipe, and
 * `unsampledRecipeNames()` fails CI when a new recipe has none. This file
 * records the input of each of those calls and replays it with its amounts
 * (every bigint in it) replaced by random ones. A recipe added later is
 * covered by the sample it must have anyway: there is no list here.
 *
 * Two properties per sampled call:
 *  - scaled: every amount times one random factor keeps the sample's own
 *    relations between amounts, so the recipe must accept it, and it balances;
 *  - free: every amount drawn on its own; the recipe may refuse, and whenever
 *    it accepts, it balances.
 */

type Call = { readonly name: string; readonly input: unknown };
type AnyRecipe = (input: unknown) => PostRequest;

function isRecipe(value: unknown): value is AnyRecipe {
  return typeof value === 'function';
}

/** The registry seen as one call shape: each recipe takes its own input, and the walk below keeps its shape. */
const registry: Record<string, unknown> = recipes;
const names = Object.keys(registry);

function recipe(name: string): AnyRecipe {
  const fn = registry[name];
  if (!isRecipe(fn)) throw new Error(`recipes.${name} is not a function`);
  return fn;
}

const calls: Call[] = [];
const run = (name: string, input: unknown): PostRequest => recipe(name)(input);

beforeAll(() => {
  const originals = new Map(names.map((name) => [name, recipe(name)]));
  for (const [name, original] of originals) {
    registry[name] = (input: unknown): PostRequest => {
      calls.push({ name, input: structuredClone(input) });
      return original(input);
    };
  }
  try {
    recipeGateSamples();
  } finally {
    for (const [name, original] of originals) registry[name] = original;
  }
});

/** The input with each bigint replaced, in walk order, by `next(old)`. */
function mapAmounts(value: unknown, next: (old: bigint) => bigint): unknown {
  if (typeof value === 'bigint') return next(value);
  if (Array.isArray(value)) return value.map((item) => mapAmounts(item, next));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapAmounts(item, next)]));
  }
  return value;
}

function countAmounts(value: unknown): number {
  let n = 0;
  mapAmounts(value, (old) => {
    n += 1;
    return old;
  });
  return n;
}

/** Debits minus credits, per asset, for every asset that does not net to zero. */
function unbalancedAssets(post: PostRequest): Record<string, string> {
  const net = new Map<string, bigint>();
  for (const entry of post.entries) {
    const signed = entry.direction === 'debit' ? entry.amount : -entry.amount;
    net.set(entry.account.assetId, (net.get(entry.account.assetId) ?? 0n) + signed);
  }
  return Object.fromEntries([...net].filter(([, v]) => v !== 0n).map(([asset, v]) => [asset, v.toString()]));
}

const RUNS = 25;

describe('every registry recipe balances per asset for random amounts', () => {
  it('records a sampled call of every registry recipe', () => {
    const recorded = new Set(calls.map((call) => call.name));
    expect(names.filter((name) => !recorded.has(name))).toEqual([]);
  });

  it('scaled amounts: accepted and balanced', () => {
    for (const { name, input } of calls) {
      fc.assert(
        fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (k) => {
          const post = run(
            name,
            mapAmounts(input, (old) => old * k),
          );
          expect(unbalancedAssets(post), `${name} x${k}`).toEqual({});
        }),
        { numRuns: RUNS },
      );
    }
  });

  it('free amounts: refused or balanced', () => {
    for (const { name, input } of calls) {
      const n = countAmounts(input);
      if (n === 0) continue;
      fc.assert(
        fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 30n }), { minLength: n, maxLength: n }), (amounts) => {
          let i = 0;
          let post: PostRequest;
          try {
            post = run(
              name,
              mapAmounts(input, (old) => amounts[i++] ?? old),
            );
          } catch {
            return; // a refusal moves no money
          }
          expect(unbalancedAssets(post), `${name} ${amounts.join(',')}`).toEqual({});
        }),
        { numRuns: RUNS },
      );
    }
  });
});
