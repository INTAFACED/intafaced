import { useMemo } from 'react';
import type { ParamValue } from '@intafaced/i18n/t';
import type { CopyCatalog } from '../../../shared/i18n';

type Parameters<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Parameters<Rest> : never;
type Args<S extends string> = [Parameters<S>] extends [never] ? [] : [params: Record<Parameters<S>, ParamValue>];

/** What a page reads its words from: the same `t` and `useCopy().t` as one catalog, over two catalogs. */
export type MergedCopy<A extends Record<string, string>, B extends Record<string, string>> = {
  t<K extends keyof (A & B) & string>(key: K, ...args: Args<(A & B)[K]>): string;
  useCopy(): { t: MergedCopy<A, B>['t'] };
};

/**
 * A package's own words sit in its own catalog so two packages never edit the same copy file. The shared catalog
 * keeps the words more than one package uses. A page imports one merged view of both from its package, and a
 * key is answered by whichever catalog holds it. A key must live in exactly one of them; the packages' copy
 * tests fail if one is in both.
 */
export function mergeCopy<A extends Record<string, string>, B extends Record<string, string>>(
  shared: CopyCatalog<A>,
  own: CopyCatalog<B>,
  ownMessages: B,
): MergedCopy<A, B> {
  const owns = (key: string) => Object.hasOwn(ownMessages, key);
  type Call = (key: string, ...args: unknown[]) => string;
  const pick =
    (sharedT: Call, ownT: Call): Call =>
    (key, ...args) =>
      owns(key) ? ownT(key, ...args) : sharedT(key, ...args);
  const t = pick(shared.t as unknown as Call, own.t as unknown as Call) as MergedCopy<A, B>['t'];
  function useCopy() {
    const a = shared.useCopy();
    const b = own.useCopy();
    // One function per language, so a page can list `t` in a hook's dependencies as it could with a single catalog.
    const merged = useMemo(() => pick(a.t as unknown as Call, b.t as unknown as Call) as MergedCopy<A, B>['t'], [a.t, b.t]);
    return { t: merged };
  }
  return { t, useCopy };
}
