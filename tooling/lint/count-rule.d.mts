/** Types for count-rule.mjs, which TypeScript tests import to run a lint rule over the code they guard. */
export interface Counted {
  total: number;
  files: Record<string, number>;
}

export function countOf(diagnostics: unknown[], rule: string): Counted;
export interface Strict {
  /** A suppression naming the rule, or naming none, counts as a finding; nested configs are not read. */
  strict?: boolean;
}
export interface CountedStrict extends Counted {
  /** The lintable files the paths hold, each judged. */
  checked: string[];
}

export function countRule(rule: string, paths: string[], options: { strict: true }): CountedStrict;
export function countRule(rule: string, paths: string[], options?: Strict): Counted;
export function countPlanted(rule: string, files: Record<string, string>, options: { strict: true }): CountedStrict;
export function countPlanted(rule: string, files: Record<string, string>, options?: Strict): Counted;
