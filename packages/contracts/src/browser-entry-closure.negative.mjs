/**
 * Negative controls for the closure parser. Exits non-zero on failure.
 * Computed import/require must not look like a clean pure graph.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyFacts, walk } from './browser-entry-closure.lib.mjs';

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const literal = dependencyFacts('import { z } from "zod";\nexport * from "./instruments.js";\n', 'ok.ts');
assert(literal.specifiers[0] === 'zod' && literal.specifiers[1] === './instruments.js', 'literal import/export');
assert(literal.unresolved.length === 0, 'literal unresolved');

const typesOnly = dependencyFacts('import type { X } from "@intafaced/auth";\n', 'types.ts');
assert(typesOnly.specifiers.length === 0, 'type-only import counted');

const calls = dependencyFacts('import("node:crypto");\nrequire("node:fs");\n', 'literals.js');
assert(calls.specifiers.includes('node:crypto') && calls.specifiers.includes('node:fs'), 'literal import() and require');

const computedImport = dependencyFacts('import("node:" + "crypto");\n', 'dyn.ts');
assert(computedImport.unresolved.includes('computed-import'), 'computed import missed');
assert(computedImport.specifiers.length === 0, 'computed import produced a specifier');

const computedRequire = dependencyFacts('require("node:" + "crypto");\n', 'dyn.cjs');
assert(computedRequire.unresolved.includes('computed-require'), 'computed require missed');

const computedResolve = dependencyFacts('require.resolve("node:" + "fs");\n', 'dyn.cjs');
assert(computedResolve.unresolved.includes('computed-require-resolve'), 'computed require.resolve missed');

const dir = mkdtempSync(join(tmpdir(), 'closure-'));
const file = join(dir, 'probe.ts');
writeFileSync(file, 'export const x = 1;\nimport("node:" + "crypto");\n');
try {
  const graph = walk(file, { followNodeModules: true });
  assert(graph.forbidden.includes('unresolved:computed-import'), `walk missed computed import: ${graph.forbidden.join(',')}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write('negative-controls-ok\n');
