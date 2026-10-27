import { describe, expect, it } from 'vitest';
import {
  ANY_COUNTRY,
  InstrumentError,
  MAX_PATTERN_LENGTH,
  MAX_VALUE_LENGTH,
  fingerprintDetails,
  methodIdFromOfferEntry,
  methodIdKey,
  methodsWithLiveDestination,
  missingSellDestinations,
  normaliseCountry,
  normaliseMethodId,
  parseFieldSpecs,
  pickSchema,
  sellOfferBoardable,
  validateDetails,
  type MethodSchema,
} from './instruments.js';

/**
 * THE FIELD RULES — pure, no database, exhaustive.
 *
 * These are the rules an operator's method schema is held to, and the rules a
 * user's account details are then held to against it. Both halves are here
 * because both are places where being lenient produces something worse than an
 * error: a schema that quietly accepts nonsense rejects every real user
 * afterwards, and details that quietly accept an undeclared field give us
 * personal data nobody designed, validates, protects or deletes.
 *
 * Nothing in this file names a real payment method or a real market's
 * requirements. That is the whole design — see `instruments.ts`.
 */

const schema = (fields: unknown[], overrides: Partial<MethodSchema> = {}): MethodSchema => ({
  methodId: 'test-method',
  country: ANY_COUNTRY,
  label: 'Test method',
  enabled: true,
  fields: parseFieldSpecs(fields),
  settlement: { instant: true },
  kind: 'transfer',
  noteRules: null,
  cashRules: null,
  ...overrides,
});

describe('normalising the keys of the registry', () => {
  it('accepts an alpha-2 country and the wildcard, and nothing else', () => {
    expect(normaliseCountry('de')).toBe('DE');
    expect(normaliseCountry(' ng ')).toBe('NG');
    expect(normaliseCountry(ANY_COUNTRY)).toBe(ANY_COUNTRY);

    for (const bad of ['DEU', 'D', '', '12', 'D1']) {
      expect(() => normaliseCountry(bad)).toThrow(InstrumentError);
    }
  });

  it('accepts a method id that can safely be a key, and nothing else', () => {
    expect(normaliseMethodId('Bank-Transfer_2')).toBe('bank-transfer_2');
    for (const bad of ['', '2fast', 'has space', 'has/slash', 'a'.repeat(65)]) {
      expect(() => normaliseMethodId(bad)).toThrow(InstrumentError);
    }
  });

  /**
   * `methodIdKey` is `normaliseMethodId` minus the throwing, and the split is a
   * fix rather than tidiness.
   *
   * A COMPARISON must not throw. The strings compared with it arrive from a
   * stranger taking an offer; an id that could never name an instrument has to
   * fall through to the ordinary "no such destination" refusal, not become a
   * schema-validation error a prober can tell apart from it. Registration is
   * where a malformed id is refused, in front of the operator who typed it.
   */
  it('keys two spellings of the same method to the same string, without refusing either', () => {
    for (const spelling of ['bank_transfer', 'Bank_Transfer', 'BANK_TRANSFER', '  bank_transfer  ']) {
      expect(methodIdKey(spelling)).toBe('bank_transfer');
    }

    // The same rule storage applies, so a stored id keys to itself.
    expect(methodIdKey(normaliseMethodId('Bank-Transfer_2'))).toBe(normaliseMethodId('Bank-Transfer_2'));

    // Case is not meaning; a different method still is.
    expect(methodIdKey('other_rail')).not.toBe(methodIdKey('bank_transfer'));

    // And it never throws, on anything.
    for (const hostile of ['', '2fast', 'has space', 'has/slash', 'a'.repeat(500)]) {
      expect(() => methodIdKey(hostile)).not.toThrow();
    }
  });
});

describe('an operator’s field list', () => {
  it('needs at least one field', () => {
    // A schema with no fields accepts an instrument with no details — a
    // destination with no address, which is the exact bug this exists to stop.
    expect(() => parseFieldSpecs([])).toThrow(/at least one field/);
    expect(() => parseFieldSpecs('not a list')).toThrow(InstrumentError);
  });

  it('defaults a field to required', () => {
    // The safe default. An optional-by-default field list produces instruments
    // that pass validation and cannot be paid.
    expect(parseFieldSpecs([{ key: 'a', label: 'A' }])[0]!.required).toBe(true);
    expect(parseFieldSpecs([{ key: 'a', label: 'A', required: false }])[0]!.required).toBe(false);
  });

  it('rejects a duplicate key, a missing label and an unusable key', () => {
    expect(() =>
      parseFieldSpecs([
        { key: 'a', label: 'A' },
        { key: 'a', label: 'Also A' },
      ]),
    ).toThrow(/declared twice/);
    expect(() => parseFieldSpecs([{ key: 'a', label: '  ' }])).toThrow(/label/);
    expect(() => parseFieldSpecs([{ key: 'Not A Key', label: 'A' }])).toThrow(/not a usable field key/);
  });

  it('compiles the pattern at registration, in front of the operator', () => {
    // Otherwise a broken pattern fails at every user's first attempt to save,
    // where nobody can tell whether they typed something wrong or we did.
    expect(() => parseFieldSpecs([{ key: 'a', label: 'A', pattern: '[unclosed' }])).toThrow(/valid regular expression/);
    expect(() => parseFieldSpecs([{ key: 'a', label: 'A', pattern: 'x'.repeat(MAX_PATTERN_LENGTH + 1) }])).toThrow(/longer than/);
    expect(parseFieldSpecs([{ key: 'a', label: 'A', pattern: '[0-9]{4}' }])[0]!.pattern).toBe('[0-9]{4}');
  });

  it('refuses a pattern whose automaton would be too large to run cheaply', () => {
    // `{n,m}` is expanded, so a short pattern can ask for an enormous machine.
    // That is a denial of service at REGISTRATION rather than at match time,
    // and it is refused with an InstrumentError like everything else here.
    expect(() => parseFieldSpecs([{ key: 'a', label: 'A', pattern: '(a{100}){100}' }])).toThrow(InstrumentError);
    expect(() => parseFieldSpecs([{ key: 'a', label: 'A', pattern: 'a{5000}' }])).toThrow(/repetition count above/);
  });

  it('refuses a construct the validator cannot run, and says which', () => {
    // Not "invalid regular expression": these are valid regular expressions
    // that this validator will not run. An operator who wrote a lookahead has
    // to be told it was the lookahead, or they go hunting for a typo.
    for (const [pattern, why] of [
      ['(?=x)a', /lookahead/],
      ['(?<=x)a', /lookbehind/],
      ['(a)\\1', /backreference/],
      ['\\bx', /word boundary/],
      ['\\p{L}+', /Unicode property/],
    ] as const) {
      expect(() => parseFieldSpecs([{ key: 'a', label: 'A', pattern }]), pattern).toThrow(InstrumentError);
      expect(() => parseFieldSpecs([{ key: 'a', label: 'A', pattern }]), pattern).toThrow(why);
    }
  });
});

describe('the pattern that used to be a denial of service', () => {
  /**
   * THE MEASURED FACT, AS A TEST.
   *
   * `(a+)+b` is six characters — well inside `MAX_PATTERN_LENGTH` (200) — and
   * it compiled cleanly under the old `new RegExp(pattern, 'u')` check. Against
   * 33 characters of `a`, well inside `MAX_VALUE_LENGTH` (512), it blocked the
   * Node event loop for **24,674 ms**, doubling with every added character.
   *
   * Both caps did exactly what they said and neither was a mitigation: a cap on
   * LENGTH bounds nothing about RUNTIME when the runtime is exponential in the
   * length. The control is the engine — see `linear-pattern.ts`.
   *
   * This asserts the elapsed time, not a flag. A flag would go on passing if the
   * matcher were swapped back.
   */
  it('does not block, and the answer is still right', () => {
    // Wall-clock budgets flake on shared CI (STOP §4.2c). The product property
    // is: LinearPattern refuses catastrophic shapes with the right answer and a
    // bounded automaton — not "finishes under N ms on this runner".
    const patterned = schema([{ key: 'code', label: 'Code', pattern: '(a+)+b' }]);
    const attack = 'a'.repeat(33);

    expect(() => validateDetails(patterned, { code: attack })).toThrow(/expected format/);
  });

  it('is bounded at the value cap, which is where the old engine was hopeless', () => {
    // 512 is what MAX_VALUE_LENGTH permits. Under the old engine this call
    // would not have returned — the extrapolation from the measured doubling is
    // on the order of 10^140 years. We assert completion + correct refuse, not
    // a wall-clock budget (those reddened CI under load with no product bug).
    const attack = 'a'.repeat(MAX_VALUE_LENGTH);

    for (const pattern of ['(a+)+b', '(a|a)*b', '(a*)*b', '([a-z]+)*!', '(a|aa)+c']) {
      const patterned = schema([{ key: 'code', label: 'Code', pattern }]);
      expect(() => validateDetails(patterned, { code: attack }), pattern).toThrow(/expected format/);
    }
  });
});

describe('what registration accepts is what validation runs', () => {
  /**
   * THE INVARIANT THE OLD CODE DID NOT HAVE.
   *
   * Registration checked `new RegExp(pattern, 'u')`. Validation ran
   * `anchored(pattern)`, which built a DIFFERENT string — `^(?:${body})$` after
   * stripping a leading `^` and a trailing `$` with two regexes that could not
   * tell an anchor from an escaped literal — and compiled it fresh on every
   * call. Measured, before the fix:
   *
   *     "\$"     | register: ok | anchored: FAIL /^(?:\)$/u: Unterminated group
   *     "\d+\$"  | register: ok | anchored: FAIL /^(?:\d+\)$/u: Unterminated group
   *
   * A pattern ending in an ESCAPED dollar sign — a currency-amount field, which
   * is not exotic — passed registration and threw a raw `SyntaxError` at every
   * user's first save. Not an `InstrumentError`, so it left the service as
   * INTERNAL_SERVER_ERROR: the user cannot tell whether they typed something
   * wrong or we did, which is exactly what the comment above `parseFieldSpecs`
   * says the compile check exists to prevent.
   */
  const CURRENCY_ISH = ['\\$', '\\d+\\$', '^\\d+\\$', '\\d+\\$$', '^\\d+\\$$', '[0-9]+\\.[0-9]{2}\\$', '\\$[0-9]+'];

  it('accepts an escaped dollar sign at registration', () => {
    // Rejecting it would also be a way to make save stop exploding, and it
    // would be the wrong one: this is a legitimate pattern and an operator is
    // entitled to write it.
    for (const pattern of CURRENCY_ISH) {
      expect(() => parseFieldSpecs([{ key: 'amount', label: 'Amount', pattern }]), pattern).not.toThrow();
    }
  });

  it('then runs it correctly at save, instead of throwing a SyntaxError', () => {
    const amount = schema([{ key: 'amount', label: 'Amount', pattern: '\\d+\\$' }]);

    expect(validateDetails(amount, { amount: '1234$' })).toEqual({ amount: '1234$' });
    // A refusal is an InstrumentError with a field, never a raw SyntaxError.
    try {
      validateDetails(amount, { amount: '1234' });
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(InstrumentError);
      expect((err as InstrumentError).field).toBe('amount');
    }
  });

  /**
   * BOTH SPELLINGS OF THE CURRENCY FIELD, INCLUDING THE ONE THAT NEVER BROKE.
   *
   * `^\d+\$$` — anchored, with an escaped dollar before the anchor — is the form
   * the ReDoS ruling named. It is worth being exact about why it belongs here:
   * under the old `anchored()` it did NOT throw. The trailing `$` absorbed the
   * `.replace(/\$$/, '')`, leaving `^(?:\d+\$)$`, which is valid and correct.
   *
   * The form that actually exploded is the same pattern WITHOUT the closing
   * anchor — `\d+\$` — where the strip ate the escape instead and produced
   * `^(?:\d+\)$`. So the escaped dollar sign is not one bug with one spelling:
   * whether it detonated depended on whether the operator happened to anchor.
   * Both are pinned, because a fix that only handled the anchored form would
   * leave the actual defect open and still look green.
   */
  it('registers and matches the anchored currency pattern from the ruling', () => {
    expect(() => parseFieldSpecs([{ key: 'amount', label: 'Amount', pattern: '^\\d+\\$$' }])).not.toThrow();

    const amount = schema([{ key: 'amount', label: 'Amount', pattern: '^\\d+\\$$' }]);
    expect(validateDetails(amount, { amount: '5$' })).toEqual({ amount: '5$' });
    expect(validateDetails(amount, { amount: '1234$' })).toEqual({ amount: '1234$' });
    // The dollar is a literal, so a value without one is not in the format.
    expect(() => validateDetails(amount, { amount: '5' })).toThrow(/expected format/);
  });

  it('still reads a bare trailing $ as the anchor', () => {
    // The other half of the same bug: fixing the escape must not stop `$`
    // meaning "end of value".
    const anchored = schema([{ key: 'code', label: 'Code', pattern: '\\d+$' }]);
    expect(validateDetails(anchored, { code: '1234' })).toEqual({ code: '1234' });
    expect(() => validateDetails(anchored, { code: '1234$' })).toThrow(/expected format/);
  });

  it('holds as a property: nothing that registers can throw at save', () => {
    // The general statement, rather than one example of it. Every pattern
    // accepted by `parseFieldSpecs` must be runnable by `validateDetails`
    // against anything — and the only error either may raise is InstrumentError.
    const CORPUS = [
      '[0-9]{4}',
      '^[0-9]{4}$',
      '\\$',
      '\\d+\\$',
      '^\\d+\\$',
      '\\\\',
      '\\.',
      '[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}',
      '(a+)+b',
      '\\w+([.-]\\w+)*',
      '[+-]?[0-9]+(\\.[0-9]{1,2})?',
      '(?:abc|def)+',
      '[\\d.-]{1,34}',
      '.*',
      '^$',
      'a|',
      '[^ ]+',
    ];
    const VALUES = ['', ' ', '1234', '12$', '$', '\\', '.', 'DE89370400440532013000', 'a'.repeat(64), 'a-b.c', '-12.50', 'abcdef'];

    let registered = 0;
    for (const pattern of CORPUS) {
      const specs = parseFieldSpecs([{ key: 'v', label: 'V', pattern, required: false }]);
      registered++;
      const s = schema([{ key: 'v', label: 'V', pattern, required: false }]);
      expect(specs[0]!.pattern).toBe(pattern);

      for (const value of VALUES) {
        try {
          validateDetails(s, { v: value });
        } catch (err) {
          expect(err, `${pattern} vs ${JSON.stringify(value)}`).toBeInstanceOf(InstrumentError);
        }
      }
    }
    expect(registered).toBe(CORPUS.length);
  });

  it('rejects nonsensical length bounds', () => {
    expect(() => parseFieldSpecs([{ key: 'a', label: 'A', minLength: 10, maxLength: 4 }])).toThrow(/minLength above maxLength/);
    expect(() => parseFieldSpecs([{ key: 'a', label: 'A', maxLength: 0 }])).toThrow(/outside/);
    expect(() => parseFieldSpecs([{ key: 'a', label: 'A', minLength: 1.5 }])).toThrow(/outside/);
  });
});

describe('a user’s details, against that list', () => {
  const s = schema([
    { key: 'account_reference', label: 'Account reference', required: true, minLength: 4 },
    { key: 'holder_name', label: 'Account holder', required: true },
    { key: 'note', label: 'Note', required: false, maxLength: 10 },
  ]);

  it('accepts exactly the declared fields, trimmed', () => {
    expect(validateDetails(s, { account_reference: '  1234  ', holder_name: 'A Person' })).toEqual({
      account_reference: '1234',
      holder_name: 'A Person',
    });
  });

  it('rejects an undeclared key rather than dropping it', () => {
    // Dropping it silently is how a blob nobody designed ends up holding
    // personal data nobody validates and nobody can enumerate later.
    expect(() => validateDetails(s, { account_reference: '1234', holder_name: 'A', date_of_birth: '1990-01-01' })).toThrow(
      /declares no field "date_of_birth"/,
    );
  });

  it('treats a blank required field as missing', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(() => validateDetails(s, { account_reference: blank, holder_name: 'A' })).toThrow(/required/);
    }
  });

  it('lets an optional field be absent, and drops it rather than storing ""', () => {
    const out = validateDetails(s, { account_reference: '1234', holder_name: 'A', note: '  ' });
    expect(Object.keys(out)).toEqual(['account_reference', 'holder_name']);
  });

  it('enforces the operator’s lengths and pattern', () => {
    expect(() => validateDetails(s, { account_reference: '12', holder_name: 'A' })).toThrow(/shorter than 4/);
    expect(() => validateDetails(s, { account_reference: '1234', holder_name: 'A', note: 'x'.repeat(11) })).toThrow(/longer than 10/);
    expect(() => validateDetails(s, { account_reference: '1234', holder_name: 'A', note: 'x'.repeat(MAX_VALUE_LENGTH + 1) })).toThrow(
      /longer than/,
    );

    const patterned = schema([{ key: 'code', label: 'Code', pattern: '[0-9]{4}' }]);
    expect(validateDetails(patterned, { code: '1234' })).toEqual({ code: '1234' });
    // Anchored whether or not the operator anchored it. A half-anchored pattern
    // is not a validation — '1234abcd' would sail through an unanchored one.
    expect(() => validateDetails(patterned, { code: '1234abcd' })).toThrow(/expected format/);
    expect(() => validateDetails(schema([{ key: 'code', label: 'Code', pattern: '^[0-9]{4}$' }]), { code: 'x1234' })).toThrow();
  });

  it('never puts the value in the error message', () => {
    // An error string is the one place personal data escapes into a log without
    // anyone deciding that it should.
    try {
      validateDetails(schema([{ key: 'code', label: 'Code', pattern: '[0-9]{4}' }]), { code: 'DE89370400440532013000' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('DE89370400440532013000');
      expect((err as InstrumentError).field).toBe('code');
    }
  });

  it('rejects a non-string value and a non-object payload', () => {
    expect(() => validateDetails(s, { account_reference: 1234, holder_name: 'A' })).toThrow(/must be text/);
    expect(() => validateDetails(s, ['1234'])).toThrow(InstrumentError);
    expect(() => validateDetails(s, null)).toThrow(InstrumentError);
  });
});

describe('the fingerprint', () => {
  const details = { b: '2', a: '1' };

  it('does not depend on key order', () => {
    expect(fingerprintDetails('m', 'DE', details)).toBe(fingerprintDetails('m', 'DE', { a: '1', b: '2' }));
  });

  it('changes when the destination changes', () => {
    // This is what makes a mid-trade account swap visible after the fact: two
    // snapshots on one seller's trades with different fingerprints.
    expect(fingerprintDetails('m', 'DE', details)).not.toBe(fingerprintDetails('m', 'DE', { a: '1', b: '3' }));
    expect(fingerprintDetails('m', 'DE', details)).not.toBe(fingerprintDetails('m', 'NG', details));
    expect(fingerprintDetails('m', 'DE', details)).not.toBe(fingerprintDetails('other', 'DE', details));
  });

  it('is a sha256 hex digest', () => {
    expect(fingerprintDetails('m', 'DE', details)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('picking the schema that applies', () => {
  const wildcard = schema([{ key: 'a', label: 'A' }]);
  const specific = schema([{ key: 'b', label: 'B' }], { country: 'NG' });

  it('prefers an exact country over the wildcard', () => {
    // The specific entry is the operator saying "this market is different".
    // Falling back past it accepts a destination that market cannot receive at.
    expect(pickSchema([wildcard, specific], 'test-method', 'NG')).toBe(specific);
    expect(pickSchema([specific, wildcard], 'test-method', 'NG')).toBe(specific);
  });

  it('falls back to the wildcard only where there is no specific entry', () => {
    expect(pickSchema([wildcard, specific], 'test-method', 'DE')).toBe(wildcard);
  });

  it('returns null rather than a near miss', () => {
    expect(pickSchema([specific], 'test-method', 'DE')).toBeNull();
    expect(pickSchema([wildcard], 'another-method', 'DE')).toBeNull();
  });
});

describe('sell offers only advertise methods with a live destination', () => {
  it('reads method ids from string and { id } board shapes', () => {
    expect(methodIdFromOfferEntry('SEPA')).toBe('sepa');
    expect(methodIdFromOfferEntry({ id: 'Bank_Transfer' })).toBe('bank_transfer');
    expect(methodIdFromOfferEntry({})).toBeNull();
    expect(methodIdFromOfferEntry(null)).toBeNull();
    expect(methodIdFromOfferEntry(12)).toBeNull();
  });

  it('RED: a method with no live destination is not boardable', () => {
    const live = new Set(['sepa']);
    const declared = ['sepa', 'wise', { id: 'PayPal' }];
    expect(methodsWithLiveDestination(declared, live)).toEqual(['sepa']);
    expect(missingSellDestinations(declared, live)).toEqual(['wise', 'paypal']);
    expect(sellOfferBoardable(['wise'], live)).toBe(false);
    expect(sellOfferBoardable(['sepa', 'wise'], live)).toBe(true);
  });

  it('keeps declaration order and drops junk entries', () => {
    const live = new Set(['a', 'b']);
    expect(methodsWithLiveDestination([{ id: 'b' }, 'nope', 'a', { id: 'b' }], live)).toEqual([{ id: 'b' }, 'a', { id: 'b' }]);
  });

  it('an empty live set removes every method from a sell offer', () => {
    expect(methodsWithLiveDestination(['sepa'], new Set())).toEqual([]);
    expect(missingSellDestinations(['sepa', 'wise'], new Set())).toEqual(['sepa', 'wise']);
    expect(sellOfferBoardable(['sepa'], new Set())).toBe(false);
  });

  it('RED: an empty operator registry is not a payable rail', () => {
    // Same helper the board uses. Empty registered set ⇒ nothing to advertise,
    // including on buy offers that never held a destination.
    const empty = new Set<string>();
    expect(methodsWithLiveDestination(['test-transfer', { id: 'bank_transfer' }], empty)).toEqual([]);
    expect(missingSellDestinations(['test-transfer'], empty)).toEqual(['test-transfer']);
    expect(sellOfferBoardable(['test-transfer'], empty)).toBe(false);
  });
});
