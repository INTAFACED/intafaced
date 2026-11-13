/**
 * Every /api/v1 route svc-trade registers, read from the text of its registrations: the method, the path (a literal, a
 * `*_PATH` constant, a `${CONST}/...` template, or each path of a `for (const path of [...])` loop) and the declaration
 * route-inventory.ts holds it to. Comments are dropped first, so a usage example in a comment is not a route.
 *
 * Two tests read it: svc-trade's own published-route-list.test.ts, which runs whenever svc-trade changes, and the
 * customer app's developers-reference.test.ts. Each walks svc-trade's sources itself and hands them here, so both stay
 * rule tests the pre-push hook picks (tooling/scripts/ci-checks.mjs `ruleTest`).
 */
export type DeclaredRoute = { method: string; path: string; access: string; scopes: string[]; file: string };

/** A file the walkers pass in: every svc-trade source but tests and test harnesses. */
export const isRouteSource = (file: string) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.test-harness.ts');

export function tradeDeclarations(files: readonly { file: string; text: string }[]): DeclaredRoute[] {
  const sources = files.map(({ file, text }) => ({
    file,
    source: text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  }));
  const constants = new Map(
    sources.flatMap(({ source }) => [...source.matchAll(/const (\w+_PATH) = '([^']+)'/g)].map((m) => [m[1]!, m[2]!] as const)),
  );
  const registration =
    /\bapp\.(get|post|put|delete|patch)(?:<[^(]*?>)?\(\s*([^,]+?),\s*(?:\{\s*\.\.\.)?(publicRead|publicWrite|privateRead|privateWrite|internalRoute|privateWith\(([^)]*)\))/g;
  const declared: DeclaredRoute[] = [];
  for (const { file, source } of sources) {
    const loop = /for \(const path of \[([^\]]+)\]\) \{/.exec(source);
    const loopPaths = loop ? [...loop[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [];
    for (const match of source.matchAll(registration)) {
      const raw = match[2]!.trim();
      const template = /^`\$\{(\w+)\}([^`]*)`$/.exec(raw);
      const paths =
        raw === 'path'
          ? loopPaths
          : [/^'([^']*)'$/.exec(raw)?.[1] ?? constants.get(raw) ?? (template ? `${constants.get(template[1]!)}${template[2]}` : raw)];
      const kind = match[3]!;
      const access = kind.startsWith('public') ? 'public' : kind === 'internalRoute' ? 'internal' : 'private';
      const scopes =
        kind === 'internalRoute'
          ? []
          : match[4] !== undefined
            ? [...match[4].matchAll(/'([^']+)'/g)].map((m) => m[1]!)
            : [kind.endsWith('Read') ? 'trade:read' : 'trade:write'];
      for (const path of paths) declared.push({ method: match[1]!.toUpperCase(), path, access, scopes, file });
    }
  }
  return declared;
}

/** One line of the published route list (apps/customer/src/features/developers/rest-routes.txt). */
export const declarationKey = (route: { method: string; path: string; access: string; scopes: readonly string[] }) =>
  `${route.method} ${route.path} ${route.access} ${route.scopes.join('+')}`;
