// Writes a package's procedures/<service>.schema.json from its built records, and deletes a file no service writes any
// more. Run from the package: `node ../contracts/scripts/write-procedures.mjs ./dist/procedure-registry.js LEDGER_PROCEDURES`
// (each package's `procedures:write` does).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { procedureSchemaFiles } from '../dist/procedure.js';

const [registry, name] = process.argv.slice(2);
if (!registry || !name) throw new Error('usage: write-procedures.mjs <built registry module> <export name>');
const records = (await import(pathToFileURL(resolve(registry)).href))[name];
if (!Array.isArray(records)) throw new Error(`${registry} exports no ${name}`);
const files = procedureSchemaFiles(records);
const dir = resolve('procedures');
mkdirSync(dir, { recursive: true });
for (const old of readdirSync(dir)) if (old.endsWith('.schema.json') && !(old in files)) rmSync(resolve(dir, old));
for (const [file, text] of Object.entries(files)) writeFileSync(resolve(dir, file), text);
