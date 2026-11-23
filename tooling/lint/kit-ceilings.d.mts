/** Types for the parts of kit-ceilings.mjs that TypeScript tests import (volt-count.test.ts reads main's fork point). */
export const ROOT: string;
/** Main fetched fresh: a ref to it, or null when it cannot be fetched. */
export function mainRef(): string | null;
/** The commit this change forked from `ref` at, or `ref` itself when the history is too shallow to say. */
export function forkPoint(ref: string, cwd?: string): string;
