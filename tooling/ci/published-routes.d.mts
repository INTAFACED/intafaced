// Types for the one export of published-routes.mjs that a TypeScript test imports.
export function declaredRoutes<Route>(
  root: string,
  parser: {
    isRouteSource(file: string): boolean;
    tradeDeclarations(files: readonly { file: string; text: string }[]): Route[];
  },
): Route[];
