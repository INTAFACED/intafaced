/**
 * D26-P1-G1 — agents.growth mount vs tracker honest gaps.
 *
 * Campaign proposals for humans only — never autonomous publication.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

export const GROWTH_TRACKER_ID = 'agents.growth' as const;

export const GROWTH_MOUNTED_DOORS = ['propose'] as const;

export const GROWTH_DONE_BAR_TEST_FILES = ['campaign-proposal.test.ts', 'growth-route.test.ts'] as const;

export const GROWTH_HONEST_GAPS = ['gap.incentive_budget_class_x', 'gap.warehouse_live_cubes'] as const;

type GrowthDoor = (typeof GROWTH_MOUNTED_DOORS)[number];

function isRouterCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'router';
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

/**
 * The doors mounted directly on `growth: router({ ... })`, read with the
 * TypeScript parser, so braces and door names inside strings, comments and
 * sibling namespaces never count. A `growth` object that is absent, unclosed,
 * mounted more than once, or not itself a key of a `router({ ... })` object
 * reads as nothing mounted.
 */
export function growthDoorsInSource(source: string, fileName = 'router.ts'): readonly GrowthDoor[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseErrors = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (parseErrors === undefined || parseErrors.length > 0) return [];
  const mounts: ts.ObjectLiteralExpression[] = [];
  (function walk(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'growth' &&
      isRouterCall(node.initializer) &&
      node.initializer.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0]!) &&
      ts.isObjectLiteralExpression(node.parent) &&
      isRouterCall(node.parent.parent)
    ) {
      mounts.push(node.initializer.arguments[0]);
    }
    ts.forEachChild(node, walk);
  })(sf);
  if (mounts.length !== 1) return [];
  const keys = new Set<string>();
  for (const prop of mounts[0]!.properties) {
    if ((ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) && prop.name) {
      const key = propertyName(prop.name);
      if (key !== undefined) keys.add(key);
    }
  }
  return GROWTH_MOUNTED_DOORS.filter((door) => keys.has(door));
}

export function growthDoorsInRouterSource(): readonly GrowthDoor[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const routerPath = join(here, '..', 'router.ts');
  return growthDoorsInSource(readFileSync(routerPath, 'utf8'), routerPath);
}

export function growthProposalHonestInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'campaign-proposal.ts'), 'utf8');
  return /isPublication:\s*false/.test(src) && /autonomous_publish/.test(src) && /returns_claim/.test(src);
}

export function growthDoneBarTestsPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return GROWTH_DONE_BAR_TEST_FILES.every((file) => existsSync(join(here, file)));
}

export function agentsGrowthTrackerBackendDoneBarMet(): boolean {
  return (
    growthDoorsInRouterSource().length === GROWTH_MOUNTED_DOORS.length && growthProposalHonestInSource() && growthDoneBarTestsPresent()
  );
}

export function agentsGrowthMountVsTrackerBoardCard(): {
  readonly tracker: typeof GROWTH_TRACKER_ID;
  readonly doors: number;
  readonly doorsMounted: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  const mounted = growthDoorsInRouterSource();
  return {
    tracker: GROWTH_TRACKER_ID,
    doors: GROWTH_MOUNTED_DOORS.length,
    doorsMounted: mounted.length,
    gaps: GROWTH_HONEST_GAPS.length,
    backendDoneBarMet: agentsGrowthTrackerBackendDoneBarMet(),
  };
}
