import { describe, expect, it } from 'vitest';
import { ACADEMY_GRADE_WEIGHT } from './academy-course-gradebook.js';
import { ANNOUNCEMENT_LINK } from './ops-console-announcements.js';
import { isServiceRunbook, SERVICE_RUNBOOK } from './ops-console-services.js';
import { INCIDENT_SEVERITY_NAME } from './ops-incidents.js';

/**
 * Each record pattern that was written with lookaround (which JSON Schema and Rust's regex read differently, so the export
 * refused its record) is now written without it. Each must accept exactly the strings its lookaround form accepted: the
 * old form is kept here as the oracle and both are run over every string a small alphabet spells, plus random longer ones.
 */
const cases: readonly {
  name: string;
  /** The pattern as the record writes it now. */
  pattern: RegExp;
  now: (s: string) => boolean;
  was: RegExp;
  alphabet: string;
  seeds: readonly string[];
}[] = [
  {
    name: 'SERVICE_RUNBOOK (with its length)',
    pattern: SERVICE_RUNBOOK,
    now: isServiceRunbook,
    was: /^(?=.{1,200}$)(?!.*\.\.)docs\/runbooks\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    alphabet: 'a._-/',
    seeds: ['docs/runbooks/', 'docs/runbooks/a', 'docs/runbooks/a.md', `docs/runbooks/${'a'.repeat(183)}`],
  },
  {
    name: 'ACADEMY_GRADE_WEIGHT',
    pattern: ACADEMY_GRADE_WEIGHT,
    now: (s) => ACADEMY_GRADE_WEIGHT.test(s),
    was: /^(?:0\.(?=\d*[1-9])\d{1,4}|1(?:\.0{1,4})?)$/,
    alphabet: '0159.',
    seeds: ['', '0.', '1.', '0.0'],
  },
  {
    name: 'INCIDENT_SEVERITY_NAME',
    pattern: INCIDENT_SEVERITY_NAME,
    now: (s) => INCIDENT_SEVERITY_NAME.test(s),
    was: /^(?!pending$)[a-z][a-z0-9_]{0,39}$/,
    alphabet: 'pendigx_9',
    seeds: ['', 'p', 'pe', 'pen', 'pend', 'pendi', 'pendin', 'pending', 'a'.repeat(36), 'pending'.padEnd(37, 'x')],
  },
  {
    name: 'ANNOUNCEMENT_LINK',
    pattern: ANNOUNCEMENT_LINK,
    now: (s) => ANNOUNCEMENT_LINK.test(s),
    was: /^(?:https:\/\/[^\s"'<>]{1,2000}|\/(?![/\\])[^\s"'<>]{0,500})$/,
    alphabet: '/\\a <',
    seeds: ['', 'https://', `/${'a'.repeat(497)}`],
  },
  {
    name: 'work item room link',
    pattern: /^\/(?:[^\\\s/][^\\\s]*)?$/,
    now: (s) => /^\/(?:[^\\\s/][^\\\s]*)?$/.test(s),
    was: /^\/(?!\/)[^\\\s]*$/,
    alphabet: '/\\a ',
    seeds: [''],
  },
  {
    name: 'venue explorer link',
    pattern: /^(https:\/\/|\/(?:[^/]|$))/,
    now: (s) => /^(https:\/\/|\/(?:[^/]|$))/.test(s),
    was: /^(https:\/\/|\/(?!\/))/,
    alphabet: '/a:',
    seeds: ['', 'https:'],
  },
];

/** Every string `seed` + up to `depth` letters of `alphabet`. */
function* spelt(seed: string, alphabet: string, depth: number): Generator<string> {
  yield seed;
  if (depth === 0) return;
  for (const c of alphabet) yield* spelt(seed + c, alphabet, depth - 1);
}

describe('record patterns without lookaround', () => {
  for (const c of cases) {
    it(`${c.name} accepts exactly what its lookaround form accepted`, () => {
      const differ: string[] = [];
      let accepted = 0;
      const check = (s: string) => {
        if (c.now(s) !== c.was.test(s)) differ.push(s);
        if (c.was.test(s)) accepted++;
      };
      for (const seed of c.seeds) for (const s of spelt(seed, c.alphabet, 5)) check(s);
      let x = 7;
      for (let i = 0; i < 2000; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        const seed = c.seeds[x % c.seeds.length] ?? '';
        let s = seed;
        for (let n = x % 9; n > 0; n--) {
          x = (x * 1103515245 + 12345) % 2147483648;
          s += c.alphabet[x % c.alphabet.length];
        }
        check(s);
      }
      expect(differ.slice(0, 5)).toEqual([]);
      // The corpus reaches both answers, so the comparison means something.
      expect(accepted).toBeGreaterThan(0);
    });
    it(`${c.name} has no lookaround or backreference`, () => {
      expect(c.pattern.source).not.toMatch(/\(\?<?[=!]|\\[1-9]|\\k</);
    });
  }
});
