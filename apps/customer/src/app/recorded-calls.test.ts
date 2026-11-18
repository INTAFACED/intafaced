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

/** Every place in `source` that names a recorded call by its module and path string. */
function stringNamedCalls(source: string, records: readonly { module?: string; path: string; name: string }[]): string[] {
  return records.flatMap((record) =>
    record.module === undefined
      ? []
      : new RegExp(`['"\`]${escape(record.module)}['"\`]\\s*,\\s*['"\`]${escape(record.path)}['"\`]`).test(source) ||
          new RegExp(`['"\`]${escape(record.path)}['"\`]\\s*:\\s*z\\.`).test(source)
        ? [record.name]
        : [],
  );
}

describe('a recorded call is made only by its record', () => {
  it('finds the hand copies #8841 came from', () => {
    expect(stringNamedCalls(`api.query('bank', 'spaces.list', { limit: 200 }, z.array(s.spaceSchema))`, CONTRACT_PROCEDURES)).toEqual([
      'bank.spaces.list',
    ]);
    expect(stringNamedCalls(`export const spacesReads = { 'spaces.list': z.array(spaceSchema) }`, CONTRACT_PROCEDURES)).toEqual([
      'bank.spaces.list',
    ]);
    expect(stringNamedCalls(`api.call(BANK_SPACES_LIST, { limit: 200 })`, CONTRACT_PROCEDURES)).toEqual([]);
  });

  it('no app source names one by its module and path: use api.call(<RECORD>, input) from its contracts subpath', () => {
    const offenders = files(SRC).flatMap((file) =>
      stringNamedCalls(readFileSync(file, 'utf8'), CONTRACT_PROCEDURES).map((name) => `${path.relative(SRC, file)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });
});
