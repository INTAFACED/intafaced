// Writes a package's `src/procedure-registry.ts` from the records found in its `src/`: every
// `export const NAME = defineProcedure(` in a non-test file. Nobody keeps the list by hand, so a record can't be left out.
//
//   node scripts/procedure-registry.mjs <packageDir> <EXPORT_NAME> <procedure module>          writes the file
//   node scripts/procedure-registry.mjs <packageDir> <EXPORT_NAME> <procedure module> --check  exits 1 when it is stale
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';

const RECORD = /^export const ([A-Z][A-Z0-9_]*) = defineProcedure\(/gm;

export async function registrySource(packageDir, exportName, procedureModule) {
  const src = join(packageDir, 'src');
  const found = [];
  for (const file of readdirSync(src).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts') || file.endsWith('.test.ts') || file === 'procedure-registry.ts') continue;
    for (const match of readFileSync(join(src, file), 'utf8').matchAll(RECORD))
      found.push({ name: match[1], module: `./${file.replace(/\.ts$/, '.js')}` });
  }
  const names = found.map((f) => f.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0) throw new Error(`two records share a constant name: ${twice.join(', ')}`);
  const byModule = new Map();
  for (const f of found) byModule.set(f.module, [...(byModule.get(f.module) ?? []), f.name]);
  // One part per source file, named by it. A record added to one file changes only that file's lines, so two changes
  // adding records to different files merge into what this script writes, and two adding to one file conflict in git.
  // (A part of fixed size would move every later boundary on any add: two green changes would merge stale.)
  // Parts, not one array literal of every record: that is a union too complex for the compiler (TS2590).
  const partName = (module) =>
    `part_${module
      .replace(/^\.\//, '')
      .replace(/\.js$/, '')
      .replace(/[^A-Za-z0-9]/g, '_')}`;
  const imports = [...byModule].map(([module, list]) => `import { ${list.join(', ')} } from '${module}';`);
  // A blank line between files' lines: git takes edits on two adjacent lines as one conflict.
  const text = [
    '// Written by `procedures:write` (scripts/procedure-registry.mjs) from every `defineProcedure` in src/. Do not edit by hand.',
    imports.join('\n\n'),
    '',
    `import type { ProcedureRecord } from '${procedureModule}';`,
    '',
    [...byModule].map(([module, list]) => `const ${partName(module)}: readonly ProcedureRecord[] = [${list.join(', ')}];`).join('\n\n'),
    '',
    '/** Every call recorded in this package. `procedures/<service>.schema.json` is written from this list. */',
    `export const ${exportName}: readonly ProcedureRecord[] = [`,
    ...[...byModule.keys()].map((module) => `  ...${partName(module)},`),
    '];',
    '',
  ].join('\n');
  const target = join(packageDir, 'src', 'procedure-registry.ts');
  return prettier.format(text, { ...(await prettier.resolveConfig(target)), filepath: target });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [packageDir, exportName, procedureModule, flag] = process.argv.slice(2);
  const target = join(packageDir, 'src', 'procedure-registry.ts');
  const want = await registrySource(packageDir, exportName, procedureModule);
  if (flag === '--check') {
    if (readFileSync(target, 'utf8') !== want) {
      console.error(`${target} is stale: run \`procedures:write\` in that package`);
      process.exit(1);
    }
  } else {
    writeFileSync(target, want);
  }
}
