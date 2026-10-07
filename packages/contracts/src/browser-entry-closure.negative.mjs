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

const typeEquals = dependencyFacts('import type runtime = require("node:fs");\n', 'types.ts');
assert(typeEquals.specifiers.length === 0 && typeEquals.unresolved.length === 0, 'type-only import-equals counted');

// verbatimModuleSyntax retains these module loads despite erasing the named types.
const namedTypes = dependencyFacts('import { type X } from "node:fs";\nexport { type Y } from "node:path";\n');
assert(namedTypes.specifiers.includes('node:fs') && namedTypes.specifiers.includes('node:path'), 'named type module loads missed');

const importEquals = dependencyFacts('import runtime = require("node:fs");\n', 'runtime.ts');
assert(importEquals.specifiers.includes('node:fs'), 'runtime import-equals missed');

const calls = dependencyFacts('import("node:crypto");\nrequire("node:fs");\n', 'literals.js');
assert(calls.specifiers.includes('node:crypto') && calls.specifiers.includes('node:fs'), 'literal import() and require');

const memberCalls = dependencyFacts(
  'module.require("node:fs");\nmodule["require"]("node:path");\nrequire["resolve"]("node:crypto");\n',
  'members.cjs',
);
assert(
  ['node:fs', 'node:path', 'node:crypto'].every((spec) => memberCalls.specifiers.includes(spec)),
  'literal CommonJS member calls missed',
);

const computedImport = dependencyFacts('import("node:" + "crypto");\n', 'dyn.ts');
assert(computedImport.unresolved.includes('computed-import'), 'computed import missed');
assert(computedImport.specifiers.length === 0, 'computed import produced a specifier');

const computedRequire = dependencyFacts('require("node:" + "crypto");\n', 'dyn.cjs');
assert(computedRequire.unresolved.includes('computed-require'), 'computed require missed');

const computedResolve = dependencyFacts('require.resolve("node:" + "fs");\n', 'dyn.cjs');
assert(computedResolve.unresolved.includes('computed-require-resolve'), 'computed require.resolve missed');

const computedMemberRequire = dependencyFacts('module["require"]("node:" + "fs");\n', 'dyn.cjs');
assert(computedMemberRequire.unresolved.includes('computed-require'), 'computed module.require missed');

const computedMemberResolve = dependencyFacts('require["resolve"]("node:" + "fs");\n', 'dyn.cjs');
assert(computedMemberResolve.unresolved.includes('computed-require-resolve'), 'computed bracket require.resolve missed');

const dir = mkdtempSync(join(tmpdir(), 'closure-'));
const file = join(dir, 'probe.ts');
try {
  for (const [source, expected] of [
    ['import("node:" + "crypto");', 'unresolved:computed-import'],
    ['import runtime = require("node:fs");', 'node:fs'],
    ['module.require("node:fs");', 'node:fs'],
    ['module["require"]("node:" + "fs");', 'unresolved:computed-require'],
    ['require["resolve"]("node:" + "fs");', 'unresolved:computed-require-resolve'],
  ]) {
    writeFileSync(file, `export const x = 1;\n${source}\n`);
    const graph = walk(file, { followNodeModules: true });
    assert(graph.forbidden.includes(expected), `walk missed ${source}: ${graph.forbidden.join(',')}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write('negative-controls-ok\n');
