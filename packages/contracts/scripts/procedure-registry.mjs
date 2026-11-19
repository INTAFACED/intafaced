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
  const imports = [...byModule].map(([module, list]) => `import { ${list.join(', ')} } from '${module}';`);
  const text = [
    '// Written by `procedures:write` (scripts/procedure-registry.mjs) from every `defineProcedure` in src/. Do not edit by hand.',
    ...imports,
    `import type { ProcedureRecord } from '${procedureModule}';`,
    '',
    '/** Every call recorded in this package. `procedures.schema.json` is written from this list. */',
    `export const ${exportName}: readonly ProcedureRecord[] = [${names.join(', ')}];`,
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
