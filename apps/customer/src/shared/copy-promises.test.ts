import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Customer copy states why something is unavailable, in the present tense. It never promises that it will be later
 * ("isn't connected yet", "coming soon", "for now", "once it is"). A refusal names the real cause instead.
 *
 * This reads every copy catalogue outside the Trade and merchant-portal lanes (they have their own checks) and fails on
 * a promise phrase. A line is allowed only when it states a fact about a record or a request, not about a feature, and
 * each allowed phrase below says why.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));

const PROMISES: RegExp[] = [
  /\b(?:not|isn['’]t|aren['’]t|cannot|can['’]t)\b[^.]{0,60}\byet\b/i,
  /coming soon/i,
  /\bonce it is\b/i,
  /\bfor now\b/i,
];

/** Other lanes: Trade, and the merchant portal and merchant rooms of Pay. */
const OTHER_LANES = [
  `${sep}screens${sep}trade${sep}`,
  `${sep}features${sep}trade${sep}`,
  `${sep}features${sep}pay${sep}portal${sep}`,
  `${sep}features${sep}pay${sep}merchant`,
];

/** Phrases that state where one record or one request stands today. Each one names a thing the customer can see change. */
const FACTS: Array<[phrase: string, why: string]> = [
  ['Not signed out yet. Reloading would sign you back in.', 'the session is still active; says what a reload does'],
  ['Not chosen yet', 'the customer has not picked a value in this form'],
  ['You have not used an agent yet.', 'an empty list of the customer’s own sessions'],
  ['You do not hold any asset yet', 'an empty balance, with the step to fix it'],
  ['You have not sent us a request yet', 'an empty list of the customer’s own requests'],
  ['You can rate a request once it is resolved or closed.', 'a rule about the request’s status, not a feature'],
  ['Not yet checked', 'a check on one record has not run'],
  ['Saved, but not confirmed yet.', 'one address has not been confirmed by its owner'],
  ['Not confirmed yet', 'one value has not been confirmed'],
  [
    'Not yet run against a real svc-pay.',
    'a developer note in the feature registry about the merchant portal’s stand-in backend; never shown to customers',
  ],
  ['Do not save it again yet.', 'an instruction while a duplicate check runs'],
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'node_modules' || name === 'vendor' ? [] : walk(path)) : [path];
  });

const isCopyFile = (path: string): boolean => {
  const rel = relative(SRC, path);
  if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel)) return false;
  if (OTHER_LANES.some((lane) => `${sep}${rel}`.includes(lane))) return false;
  return /copy[^/\\]*\.tsx?$/i.test(rel) || ['data/refusals.ts', 'app/feature-registry.ts'].includes(rel.split(sep).join('/'));
};

const files = walk(SRC).filter(isCopyFile);

const promisesIn = (text: string): string[] =>
  text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .filter(({ line }) => PROMISES.some((pattern) => pattern.test(line)))
    .filter(({ line }) => !FACTS.some(([phrase]) => line.includes(phrase)))
    .map(({ line, number }) => `${number}: ${line.trim().slice(0, 160)}`);

describe('customer copy never promises a later capability', () => {
  it('reads the copy catalogues outside the Trade and merchant-portal lanes', () => {
    const rels = files.map((file) => relative(SRC, file).split(sep).join('/'));
    expect(files.length).toBeGreaterThan(40);
    expect(rels).toContain('data/refusals.ts');
    expect(rels).toContain('app/app-copy.ts');
    expect(rels).toContain('app/feature-registry.ts');
    expect(
      rels.some((rel) => rel.startsWith('screens/trade/') || rel.startsWith('features/trade/') || rel.startsWith('features/pay/portal/')),
    ).toBe(false);
  });

  it('has no "not … yet", "coming soon", "once it is" or "for now" outside the stated facts', () => {
    const found = files.flatMap((file) => promisesIn(readFileSync(file, 'utf8')).map((hit) => `${relative(SRC, file)}:${hit}`));
    expect(found).toEqual([]);
  });

  it('catches a reintroduced promise', () => {
    for (const bad of [
      "  body: 'Sale subscriptions cannot be read yet, so nothing is counted.',",
      "  body: 'Bill pay isn’t connected yet',",
      "  body: 'Coming soon',",
      "  body: 'These are the steps you will see once it is.',",
      "  body: 'That balance is locked for now.',",
    ])
      expect(promisesIn(bad), bad).toHaveLength(1);
    expect(promisesIn("  empty: 'No trades yet',")).toEqual([]);
  });

  it('keeps every allowed phrase in use, so the list cannot go stale', () => {
    const all = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const [phrase] of FACTS) expect(all, phrase).toContain(phrase);
  });
});
