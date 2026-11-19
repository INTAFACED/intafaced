import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PROCEDURES } from '@intafaced/contracts/procedure-registry';

// A call with a written record (`@intafaced/contracts/procedure`) is made with `api.call(RECORD, input)`, which takes its
// path, its input type and its reply parser from the record the service mounts. A string-named call with its own schema
// is a hand copy that can drift from what the service sends (Pay's copy of `spaces.list` refused every held space), so
// none may be written.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Named = { module?: string; path: string; name: string };
/** The two ways a source names one recorded call by strings, compiled once per record list (not once per file). */
const patternsOf = (records: readonly Named[]) =>
  records.flatMap((record) =>
    record.module === undefined
      ? []
      : [
          {
            name: record.name,
            path: record.path,
            byName: new RegExp(`['"\`]${escape(record.module)}['"\`]\\s*,\\s*['"\`]${escape(record.path)}['"\`]`),
            handSchema: new RegExp(`['"\`]${escape(record.path)}['"\`]\\s*:\\s*z\\.`),
          },
        ],
  );

/** Every place in `source` that names a recorded call by its module and path string. */
function stringNamedCalls(source: string, patterns: ReturnType<typeof patternsOf>): string[] {
  // Both shapes quote the path, so a source that never mentions it is skipped without running either pattern.
  return patterns.flatMap((p) => (source.includes(p.path) && (p.byName.test(source) || p.handSchema.test(source)) ? [p.name] : []));
}

const PATTERNS = patternsOf(CONTRACT_PROCEDURES);

describe('a recorded call is made only by its record', () => {
  it('finds the hand copies #8841 came from', () => {
    expect(stringNamedCalls(`api.query('bank', 'spaces.list', { limit: 200 }, z.array(s.spaceSchema))`, PATTERNS)).toEqual([
      'bank.spaces.list',
    ]);
    expect(stringNamedCalls(`export const spacesReads = { 'spaces.list': z.array(spaceSchema) }`, PATTERNS)).toEqual(['bank.spaces.list']);
    expect(stringNamedCalls(`api.call(BANK_SPACES_LIST, { limit: 200 })`, PATTERNS)).toEqual([]);
  });

  it('no app source names one by its module and path: use api.call(<RECORD>, input) from its contracts subpath', () => {
    const offenders = files(SRC).flatMap((file) =>
      stringNamedCalls(readFileSync(file, 'utf8'), PATTERNS).map((name) => `${path.relative(SRC, file)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });
});
