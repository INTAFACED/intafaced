/** Types for count-rule.mjs, which TypeScript tests import to run a lint rule over the code they guard. */
export interface Counted {
  total: number;
  files: Record<string, number>;
}

export function countOf(diagnostics: unknown[], rule: string): Counted;
export function countRule(rule: string, paths: string[]): Counted;
export function countPlanted(rule: string, files: Record<string, string>): Counted;
