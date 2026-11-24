import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACADEMY_LEARNER_PROCEDURES } from './academy-learner-procedures.js';
import { NO_INPUT } from './procedure.js';

/**
 * svc-academy's Rust door is the truth of the wire. `crates/svc-academy/tests/fixtures/input-parity/` holds zod's own
 * verdict on every call's input (recorded from the TypeScript router the door replaced), and `tests/input_parity.rs`
 * holds the door to it. Each learner record's input must reach the same verdict, with the same issues, on every case.
 */
const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'crates',
  'svc-academy',
  'tests',
  'fixtures',
  'input-parity',
);

type Probe = string | null | ['repeat', string, string, number, string] | ['many', string, number];
type Case = [string, string | null | [number, (string | number)[], Probe], number];

const golden = JSON.parse(readFileSync(join(DIR, 'verdicts.golden.json'), 'utf8')) as { verdicts: string[]; bases: string[] };
const cases = readdirSync(DIR)
  .filter((f) => f !== 'verdicts.golden.json')
  .flatMap((f) => (JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { cases: Case[] }).cases);

function probe(p: Probe): unknown {
  if (p === null) return undefined;
  if (typeof p === 'string') return JSON.parse(p);
  if (p[0] === 'repeat') return p[1] + p[2].repeat(p[3]) + p[4];
  return Array.from({ length: p[2] }, () => JSON.parse(p[1]) as unknown);
}

/** `setAt`: the value at `at` replaced, or removed (an array element removed reads back as null). */
function setAt(base: unknown, at: (string | number)[], value: unknown): void {
  let here = base as Record<string | number, unknown>;
  for (const k of at.slice(0, -1)) here = here[k] as Record<string | number, unknown>;
  const last = at[at.length - 1]!;
  if (Array.isArray(here)) {
    while (here.length <= Number(last)) here.push(null);
    here[Number(last)] = value === undefined ? null : value;
  } else if (value === undefined) delete here[last];
  else here[last] = value;
}

function inputOf(c: Case): unknown {
  const sent = c[1];
  if (sent === null) return undefined;
  if (typeof sent === 'string') return JSON.parse(sent);
  const base = JSON.parse(golden.bases[sent[0]]!) as unknown;
  setAt(base, sent[1], probe(sent[2]));
  return base;
}

describe('academy learner records', () => {
  it('reach zod verdict for verdict on every recorded input of the door', () => {
    const wrong: string[] = [];
    for (const record of ACADEMY_LEARNER_PROCEDURES) {
      const mine = cases.filter((c) => c[0] === record.path);
      expect(mine.length, record.path).toBeGreaterThan(0);
      for (const c of mine) {
        const input = inputOf(c);
        const want = golden.verdicts[c[2]]!;
        let got: string;
        if (record.input === NO_INPUT) got = want.startsWith('ok') ? want : 'ok (a call with no input reads none)';
        else {
          const parsed = record.input.safeParse(input);
          const sent = input === undefined ? 'undefined' : JSON.stringify(input);
          const out = parsed.data === undefined ? 'undefined' : JSON.stringify(parsed.data);
          got = parsed.success
            ? out === sent
              ? want === 'ok undefined'
                ? want
                : 'ok ='
              : `ok ${out}`
            : `issues ${JSON.stringify(parsed.error.issues)}`;
        }
        if (got !== want) wrong.push(`${record.path} ${JSON.stringify(input)}\n  zod:    ${want}\n  record: ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
