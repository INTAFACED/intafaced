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

// Both shapes quote the path, and a path is only these characters, so a quoted path is one of the source's quoted
// tokens: each source is read for its tokens once, and only the records whose path is among them run their patterns.
// (Testing all 685 records' paths against each of the app's 1,926 files took past the 5 s limit on a busy runner.)
const PATH = /^[A-Za-z0-9.]+$/;
const QUOTED = /(?<=['"`])[A-Za-z0-9.]+(?=['"`])/g;

/** Every place in `source` that names a recorded call by its module and path string. */
function stringNamedCalls(source: string, patterns: ReturnType<typeof patternsOf>): string[] {
  const quoted = new Set(source.match(QUOTED));
  return patterns.flatMap((p) => (quoted.has(p.path) && (p.byName.test(source) || p.handSchema.test(source)) ? [p.name] : []));
}

const PATTERNS = patternsOf(CONTRACT_PROCEDURES);

describe('a recorded call is made only by its record', () => {
  it('reads every recorded path as one quoted token (else the scan below would miss it)', () => {
    expect(PATTERNS.filter((p) => !PATH.test(p.path)).map((p) => p.name)).toEqual([]);
  });

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
