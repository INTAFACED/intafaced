/** Types for look-codemod.mjs, which packages/ui's theme tests (TypeScript) import. */
export interface Scales {
  space: Map<string, string>;
  text: Map<string, string>;
  leading: Map<string, string>;
  radius: Map<string, string>;
}

export function scales(tokensCss: string): Scales;

export function transform(css: string, scales: Scales): { css: string; changed: number; left: number };
