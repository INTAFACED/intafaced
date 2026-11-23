import { readdirSync, readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { NO_INPUT, procedureSchemaFiles, type ProcedureRecord, type ProcedureSample } from './procedure.js';

/**
 * Runs every record's sample inputs through the sides that implement it here: the record's own zod schema, and its
 * language-neutral export as committed in `procedures/<service>.schema.json`, checked by an independent JSON Schema validator
 * (ajv, draft 2020-12, with formats). A sample refused only by a named input check (`checks`) must pass the export (which names
 * that check rather than encoding it) and be refused by zod with nothing but custom issues. Each mounted route runs the
 * same samples in its own service's tests. Returns one line per disagreement; empty when every side agrees.
 *
 * Tests only: imported by no service at run time.
 */

interface ExportedRecord {
  readonly input: Record<string, unknown> | null;
  readonly inputOptional?: true;
}

export function sampleDisagreements(records: readonly ProcedureRecord[], committed: Readonly<Record<string, string>>): string[] {
  const exported: Record<string, ExportedRecord> = {};
  for (const text of Object.values(committed)) {
    const file: { procedures: Record<string, ExportedRecord> } = JSON.parse(text);
    Object.assign(exported, file.procedures);
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  // ajv-formats is CommonJS: its default import is the module, whose `default` is the plugin.
  ajvFormats.default(ajv);
  const out: string[] = [];
  for (const record of records) {
    const json = exported[record.name];
    if (json === undefined) {
      out.push(`${record.name}: not in procedures/${record.service}.schema.json`);
      continue;
    }
    const validate = json.input === null ? undefined : ajv.compile(json.input);
    record.samples.forEach((sample: ProcedureSample, i) => {
      const label = `${record.name} sample ${i} (${JSON.stringify(sample.input)})`;
      const absent = !('input' in sample) || sample.input === undefined;
      const zod = record.input.safeParse(sample.input);
      if (zod.success !== (sample.verdict === 'accept'))
        out.push(`${label}: zod says ${zod.success ? 'accept' : 'refuse'}, the record says ${sample.verdict}`);
      if (sample.by !== undefined && !zod.success && zod.error.issues.some((issue) => issue.code !== 'custom')) {
        out.push(`${label}: refused by more than ${sample.by}: ${zod.error.issues.map((issue) => issue.message).join('; ')}`);
      }
      const exportAccepts = absent
        ? record.input === NO_INPUT || json.inputOptional === true
        : validate === undefined
          ? false
          : validate(sample.input) === true;
      const exportShould = sample.by === undefined ? sample.verdict === 'accept' : true;
      if (exportAccepts !== exportShould) {
        out.push(`${label}: the JSON export says ${exportAccepts ? 'accept' : 'refuse'}, it should ${exportShould ? 'accept' : 'refuse'}`);
      }
    });
  }
  return out;
}

/** A package's committed `procedures/` directory (`dir` is its URL), file name to text. */
export function committedProcedureSchemas(dir: URL): Record<string, string> {
  const names = readdirSync(dir).filter((name) => name.endsWith('.schema.json'));
  return Object.fromEntries(names.sort().map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]));
}

/**
 * How a committed `procedures/` directory differs from what the records write: a file missing, a file no service writes
 * any more, or a file whose records differ. Empty when they agree; `write` names the command that fixes it.
 */
export function procedureSchemaDrift(
  committed: Readonly<Record<string, string>>,
  records: readonly ProcedureRecord[],
  write: string,
): string[] {
  const wanted = procedureSchemaFiles(records);
  const out: string[] = [];
  for (const name of Object.keys(wanted)) {
    if (!(name in committed)) out.push(`procedures/${name} is missing: run \`${write}\``);
    else if (JSON.stringify(JSON.parse(committed[name] ?? '')) !== JSON.stringify(JSON.parse(wanted[name] ?? '')))
      out.push(`procedures/${name} is not what its records say: run \`${write}\``);
  }
  for (const name of Object.keys(committed))
    if (!(name in wanted)) out.push(`procedures/${name} holds no service's records: run \`${write}\`, which deletes it`);
  return out;
}
