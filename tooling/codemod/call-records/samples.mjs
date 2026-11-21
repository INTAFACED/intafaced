#!/usr/bin/env node
// The samples step of the call-records codemod: for each record it wrote (still holding its placeholder samples), an
// input the record accepts and one it refuses, each found by trying candidates against the record's own built schema.
// Run after `pnpm --filter @intafaced/contracts build`; it rewrites the placeholder in the record's source file.
//
//   node tooling/codemod/call-records/samples.mjs <record file.ts> ...
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
// The records' own zod: the one @intafaced/contracts resolves.
const { z } = await import(pathToFileURL(createRequire(join(REPO, 'packages/contracts/package.json')).resolve('zod')).href);
// The placeholder index.mjs writes, however prettier wrapped it.
const PLACEHOLDER = /samples: \[\s*\{ verdict: 'accept', input: \{\} \},\s*\{ verdict: 'refuse', input: 42 \},?\s*\]/;

const STRINGS = [
  'USDC',
  'x',
  'a',
  '1',
  '0',
  'abc',
  'ethereum',
  '11111111-1111-4111-8111-111111111111',
  '2026-01-01',
  '2026-01-01T00:00:00.000Z',
  'a@example.com',
  'https://example.com',
  `0x${'1'.repeat(40)}`,
  'BTC-USD',
  'en',
  'US',
  'GB',
  '10',
  '1.5',
  '00:00',
  'monthly',
];

/** Values a JSON Schema allows, most likely first (`depth` keeps nested objects small). */
// A field named like a credential gets a value the secret scan reads as one (tooling/ci/secret-scan.mjs: /placeholder/i).
const CREDENTIAL_KEY = /pass(word|phrase)?|token|secret|api[_-]?key|private|credential/i;

function candidates(schema, depth = 0, key = '') {
  if (!schema || typeof schema !== 'object' || depth > 8) return [null];
  if ('const' in schema) return [schema.const];
  if (schema.enum) return schema.enum.slice(0, 3);
  if ('default' in schema && depth > 0) return [undefined, schema.default];
  for (const k of ['anyOf', 'oneOf']) if (schema[k]) return schema[k].flatMap((s) => candidates(s, depth + 1, key)).slice(0, 8);
  if (schema.allOf) return candidates(Object.assign({}, ...schema.allOf), depth + 1, key);
  const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== 'null') ?? 'null') : schema.type;
  switch (type) {
    case 'object': {
      const req = schema.required ?? [];
      const props = schema.properties ?? {};
      const base = {};
      for (const k of req) base[k] = candidates(props[k], depth + 1, k)[0];
      const out = [base];
      // A second try per field: its next candidate, for a field whose first one the schema's own checks refuse.
      for (const k of req) for (const alt of candidates(props[k], depth + 1, k).slice(1, 4)) out.push({ ...base, [k]: alt });
      return out;
    }
    case 'array': {
      const item = candidates(schema.items, depth + 1);
      const n = schema.minItems ?? 0;
      return n === 0 ? [[], [item[0]]] : [Array.from({ length: n }, (_, i) => item[i % item.length])];
    }
    case 'string': {
      if (schema.format === 'uuid') return ['11111111-1111-4111-8111-111111111111'];
      if (schema.format === 'date-time') return ['2026-01-01T00:00:00.000Z'];
      if (schema.format === 'date') return ['2026-01-01'];
      if (schema.format === 'email') return ['a@example.com'];
      if (schema.format === 'uri' || schema.format === 'url') return ['https://example.com'];
      const min = schema.minLength ?? 0;
      const max = schema.maxLength ?? Infinity;
      let list = STRINGS.filter((s) => s.length >= min && s.length <= max);
      if (schema.pattern) {
        const re = new RegExp(schema.pattern, 'u');
        list = [
          ...STRINGS,
          ...Array.from({ length: 6 }, (_, i) => 'a'.repeat(Math.max(1, min + i))),
          ...Array.from({ length: 6 }, (_, i) => '1'.repeat(Math.max(1, min + i))),
        ].filter((s) => re.test(s) && s.length >= min && s.length <= max);
      }
      if (list.length === 0) list = ['x'.repeat(Math.max(1, min))];
      if (CREDENTIAL_KEY.test(key)) {
        const fake = `placeholder${'x'.repeat(Math.max(0, min - 11))}`;
        const fits = fake.length <= max && (!schema.pattern || new RegExp(schema.pattern, 'u').test(fake));
        if (fits) return [fake];
      }
      return list.slice(0, 6);
    }
    case 'integer':
    case 'number': {
      const lo = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined);
      return [
        ...new Set(
          [lo ?? 1, 1, 0, 10, schema.maximum].filter(
            (v) => v !== undefined && (schema.maximum === undefined || v <= schema.maximum) && (lo === undefined || v >= lo),
          ),
        ),
      ];
    }
    case 'boolean':
      return [true, false];
    case 'null':
      return [null];
    default:
      return [{}, 'x', 1];
  }
}

const REFUSALS = [42, 'not-an-input', [], null, true, { '': 1 }];

export function samplesFor(record) {
  const input = record.input;
  if (input.def?.type === 'undefined' || input._zod?.def?.type === 'undefined') return "[{ verdict: 'accept' }]";
  const ok = (v) => input.safeParse(v).success;
  let accept;
  let json;
  try {
    json = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' });
  } catch {
    json = {};
  }
  for (const v of [...candidates(json), undefined, {}]) {
    if (ok(v)) {
      accept = v;
      break;
    }
  }
  const refuse = REFUSALS.find((v) => !ok(v));
  if (refuse === undefined) throw new Error(`${record.name}: no refused input among ${JSON.stringify(REFUSALS)}`);
  if (accept === undefined && !ok(undefined)) throw new Error(`${record.name}: no accepted input found; write its samples by hand`);
  const a = accept === undefined ? "{ verdict: 'accept' }" : `{ verdict: 'accept', input: ${JSON.stringify(accept)} }`;
  return `[${a}, { verdict: 'refuse', input: ${JSON.stringify(refuse)} }]`;
}

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--unportable');
  const unportableOut = at === -1 ? undefined : argv[at + 1];
  const files = argv.filter((_, i) => at === -1 || (i !== at && i !== at + 1));
  const { procedureJsonSchema } = await import(pathToFileURL(join(REPO, 'packages/contracts/dist/procedure.js')).href);
  const unportable = {};
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const dist = join(REPO, 'packages/contracts/dist', basename(file).replace(/\.ts$/, '.js'));
    const mod = await import(pathToFileURL(dist).href);
    let out = src;
    let n = 0;
    for (const m of src.matchAll(/^export const ([A-Z][A-Z0-9_]*) = defineProcedure\(/gm)) {
      const name = m[1];
      // A record whose schemas JSON Schema can't carry is not one the codemod may write: it goes back to its router.
      try {
        procedureJsonSchema(mod[name]);
      } catch (err) {
        unportable[mod[name].path] = String(err.message).split('\n')[0];
        continue;
      }
      const start = m.index;
      const next = src.indexOf('\nexport const ', start + 1);
      const block = src.slice(start, next === -1 ? undefined : next);
      if (!PLACEHOLDER.test(block)) continue;
      // A record the step can find no accepted (or refused) input for goes back to its router the same way, named.
      let samples;
      try {
        samples = samplesFor(mod[name]);
      } catch (err) {
        unportable[mod[name].path] = String(err.message).split('\n')[0];
        continue;
      }
      out = out.replace(block, block.replace(PLACEHOLDER, `samples: ${samples}`));
      n++;
    }
    writeFileSync(file, out);
    console.log(`${basename(file)}: ${n} records' samples written`);
  }
  if (unportableOut) writeFileSync(unportableOut, JSON.stringify(unportable, null, 2));
  console.log(`${Object.keys(unportable).length} records can't be exported as written`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
