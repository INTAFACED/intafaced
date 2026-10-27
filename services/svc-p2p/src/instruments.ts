import { createHash } from 'node:crypto';
import { LinearPattern, PatternError } from './linear-pattern.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * PAYMENT INSTRUMENTS — the shape, the rules, and none of the I/O (§6.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 *
 * svc-p2p could lock escrow, release it, refund it and adjudicate a dispute —
 * and a trade still could not complete, because at the moment the buyer has to
 * pay the seller there was nowhere to send the money. The escrow machinery was
 * real; the payment leg was a `method` string and a `terms` paragraph.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE FIELDS ARE DATA AND NOT CODE
 *
 * What a payer needs in order to actually send money differs by method and by
 * country, and it is not our knowledge to invent. A hardcoded list of methods
 * with hardcoded field names would be this repo asserting, in code, what a
 * bank transfer requires in Nigeria or what a mobile-money handle looks like in
 * Kenya — assertions no one here is entitled to make, and which would be wrong
 * silently rather than loudly.
 *
 * So a **method schema** is an operator-supplied record: a method id, a country,
 * a display label, and the list of fields that method needs in that country.
 * This file validates instrument details *against* whatever schema the operator
 * registered. It contains no method, no bank, no country's requirements, and
 * shipping it seeds none — an operator with `admin:compliance` registers what a
 * market actually requires, and until they do, that market cannot be used.
 *
 * That refusal is the honest behaviour. The alternative — guessing a plausible
 * field list so the feature "works" — produces instruments that look complete
 * and cannot be paid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT HERE
 *
 * No money. An instrument is a destination, never a balance (Doctrine §0.6);
 * nothing in this file has an `Amount` and nothing in it can.
 */

// ── The operator's half: what a method needs, per country ────────────────────

/** How a value is compared, when the operator wants more than "not empty". */
export interface FieldSpec {
  /** Machine key. Stable, lowercase, `[a-z0-9_]`. The payload is keyed on it. */
  readonly key: string;
  /** What the payer/owner is shown. Operator-supplied — never derived here. */
  readonly label: string;
  readonly required: boolean;
  /**
   * Anchored automatically — the whole value must match, not a substring.
   *
   * Run by `linear-pattern.ts`, NOT by `RegExp`. It is operator-supplied and it
   * meets input that came from the internet, and under JavaScript's own engine
   * that combination is a denial of service: `(a+)+b` is six characters, passes
   * every cap here, and blocks the event loop for 24 seconds against 33
   * characters of input. The caps below bound length; only a non-backtracking
   * engine bounds work.
   */
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /**
   * A hint for the input control, NOT an access-control decision. Nothing in
   * this service decides who may read a value by looking at this flag —
   * `instrument-service.ts` decides that from the trade, and it treats every
   * field as sensitive.
   */
  readonly sensitive?: boolean;
  /** Shown with the field, and in a format refusal (`p2p.account_format_invalid`) so the person can correct it. */
  readonly help?: string;
  /**
   * P-ads-merchant-18, the own-name rule: this field is the account holder's name. At most one per method; a new or
   * edited destination is refused unless identity says it is the person's verified legal name. A method without one
   * (cash in person, a handle) has no name to check. Operator-set, under the same two-person approval as the schema.
   */
  readonly holderName?: boolean;
}

export interface MethodSchema {
  readonly methodId: string;
  /** ISO 3166-1 alpha-2, or `*` for "this method works the same everywhere". */
  readonly country: string;
  readonly label: string;
  readonly fields: readonly FieldSpec[];
  readonly enabled: boolean;
  /** P-disputes-security-09: whether money on this method in this market arrives at once. */
  readonly settlement: MethodSettlement;
  /** P-ads-merchant-19: `cash_in_person` when the row carries cash rules, else `transfer`. */
  readonly kind: MethodKind;
  /** P-ads-merchant-19: what the payer writes in the payment note, and what they never write. Null: none registered. */
  readonly noteRules: MethodNoteRules | null;
  /** P-ads-merchant-19: the cash-in-person rules, owner values on the row. Null on a transfer method. */
  readonly cashRules: MethodCashRules | null;
}

export type MethodKind = 'transfer' | 'cash_in_person';

/** The payment-note rules a method row carries: guidance for the note, and words that never go in it. */
export interface MethodNoteRules {
  readonly guidance: string;
  readonly forbidden: readonly string[];
}

/**
 * Cash in person (P-ads-merchant-19): the price is locked (a floating ad cannot list it), the meeting and proof guidance
 * are shown before anyone takes, and the seller's release window on an order paid this way is the row's own.
 */
export interface MethodCashRules {
  readonly meetingGuidance: string;
  readonly proof: string;
  readonly releaseWindowSeconds: number;
}

/** Bounds of the rule texts and the cash release window; the service and the database check the same. */
export const NOTE_GUIDANCE_MAX = 500;
export const NOTE_FORBIDDEN_MAX_WORDS = 20;
export const NOTE_FORBIDDEN_WORD_MAX = 80;
export const CASH_TEXT_MAX = 1000;
export const CASH_RELEASE_MIN_SECONDS = 300;
export const CASH_RELEASE_MAX_SECONDS = 24 * 60 * 60;

/**
 * How money on a method arrives in one market. Instant: at once, and the published payment deadline applies. Non-instant:
 * within `windowSeconds`, which becomes the order's payment deadline and the earliest a party may open a dispute; a blank
 * window falls back to the published payment deadline.
 */
export type MethodSettlement = { readonly instant: true } | { readonly instant: false; readonly windowSeconds: number | null };

/** The bounds of a settlement window, in seconds (one minute to thirty days); the database checks the same. */
export const SETTLEMENT_WINDOW_MIN_SECONDS = 60;
export const SETTLEMENT_WINDOW_MAX_SECONDS = 30 * 24 * 60 * 60;

/** Country wildcard. A schema registered against it applies to every country. */
export const ANY_COUNTRY = '*';

/**
 * Caps. Both halves of "an operator regex meets a stranger's input".
 *
 * These are NOT the ReDoS control and never were — see `linear-pattern.ts`.
 * They became a real bound on work only once the engine underneath them stopped
 * being able to take exponential time; against a backtracking engine a length
 * cap bounds nothing at all.
 */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_VALUE_LENGTH = 512;
export const MAX_FIELDS = 24;
export const MAX_LABEL_LENGTH = 120;

export type InstrumentErrorCode =
  | 'p2p.instrument_schema_invalid'
  | 'p2p.instrument_method_unknown'
  | 'p2p.instrument_method_disabled'
  | 'p2p.instrument_field_missing'
  | 'p2p.instrument_field_undeclared'
  | 'p2p.instrument_field_invalid'
  | 'p2p.instrument_country_invalid'
  | 'p2p.instrument_not_found'
  | 'p2p.instrument_slot_taken'
  // Caller must name the instrument; add does not mint an id (retry-id, same class as take).
  | 'p2p.instrument_id_required'
  | 'p2p.take_refused'
  | 'p2p.instrument_retention_unset'
  // instruments.list page size unpublished. Blank is not 50.
  | 'p2p.instrument_list_limit_unset'
  // instruments.methods.list page size unpublished. Blank is not 50.
  | 'p2p.method_schema_list_limit_unset'
  // instruments.accessLog page size unpublished. Blank is not 100.
  | 'p2p.access_log_limit_unset'
  // purgeExpiredSnapshots batch unpublished. Blank is not 500.
  | 'p2p.purge_snapshots_limit_unset'
  | 'p2p.delist_reason_required'
  // P-trade-orders-03: a value that does not match the method's format; the message carries the operator's hint.
  | 'p2p.account_format_invalid'
  // P-ads-merchant-18, the own-name rule: the holder name is not the verified legal name, there is none, or identity
  // could not say. Each refuses before anything is stored.
  | 'p2p.holder_name_mismatch'
  | 'p2p.holder_name_unverified'
  | 'p2p.holder_name_unverifiable';

/** Refusals about one field the person can correct: the answer names the field (contracts `p2pLimit.field`). */
const FIELD_REFUSALS: ReadonlySet<InstrumentErrorCode> = new Set([
  'p2p.account_format_invalid',
  'p2p.instrument_field_missing',
  'p2p.instrument_field_invalid',
]);

export class InstrumentError extends Error {
  /** On a field refusal: the field's key for the client, as contracts' `p2pLimitOf` reads it. Never a value. */
  readonly limit?: { readonly until: null; readonly field: string };
  constructor(
    message: string,
    readonly code: InstrumentErrorCode,
    /** Which field, when the answer is one field. Never carries a VALUE. */
    readonly field?: string,
  ) {
    super(message);
    this.name = 'InstrumentError';
    if (field !== undefined && FIELD_REFUSALS.has(code)) this.limit = { until: null, field };
  }
}

/**
 * THE ONE REFUSAL A TAKE GETS WHEN THE PAYMENT METHOD IS THE PROBLEM.
 *
 * It is a constant, and every word of it is chosen for what it does NOT say.
 *
 * `attachToTrade` used to throw
 *   `The seller has no active "${methodId}" destination for ${fiatCurrency}`
 * and the router returned `err.message` verbatim as a `BAD_REQUEST`. The throw
 * sits inside the reserve transaction, so a failed take rolls back cleanly — no
 * trade row, no inventory decrement, no escrow, nothing to clean up — and
 * `logDenied` was not called on that path, so it wrote no access-log row.
 *
 * Each take attempt was therefore a **free, unlogged, self-describing
 * confirm/deny** for "does seller S hold an instrument for method M in currency
 * C", with `instruments.methods.list` handing any authenticated caller the
 * candidate list to enumerate against. It answered a question about someone
 * else's bank accounts, for nothing, and left no trace it had been asked.
 *
 * Two things close it, and they are the two the ADR names:
 *
 *   · this message, which does not distinguish "no such instrument" from any
 *     other reason the take could not name a destination — same code, same
 *     text, same shape;
 *   · the access-log row every such refusal now writes, so the attempt is
 *     attributable and lands in the OWNER's own access log, like every other
 *     read of instrument existence.
 *
 * OFFER-SIDE residual is closed by `methodsWithLiveDestination` / sell create
 * gate (see helpers below). Take still uses this one message so a method the
 * offer lists but the seller later removed stays indistinguishable from any
 * other refuse — the board simply stops advertising it.
 */
export const TAKE_REFUSED_MESSAGE = resolveP2pCopy(P2P_COPY.takeRefused);

export function takeRefused(): InstrumentError {
  return new InstrumentError(TAKE_REFUSED_MESSAGE, 'p2p.take_refused');
}

/**
 * OFFER-SIDE CLOSE OF THE TAKE ORACLE RESIDUAL.
 *
 * The take path cannot tell a stranger *why* a method failed (instrument missing
 * vs offer not listing it). That leaves one remaining leak: an offer that
 * *advertises* a method the seller cannot actually be paid on. A successful-
 * shape take that then returns `p2p.take_refused` means "listed but no
 * destination" — still an existence oracle, just one step later.
 *
 * The fix is on the board, not on the take:
 *   · a **sell** offer may only declare methods the maker has an active
 *     destination for in the offer's fiat;
 *   · the board / offer read surface only returns those methods that still have
 *     a live destination (removal after post drops the method from the board);
 *   · a sell offer with zero live methods is off the board (cannot be taken).
 *
 * **Buy** offers are unchanged: the seller is the *taker*, so no destination is
 * known at post time — take-time attach remains the gate.
 */

/** Pull a method id out of a board entry (`"sepa"` or `{ id: "sepa" }`). */
export function methodIdFromOfferEntry(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const id = methodIdKey(entry);
    return id.length > 0 ? id : null;
  }
  if (entry && typeof entry === 'object' && 'id' in entry) {
    const id = (entry as { id: unknown }).id;
    if (typeof id === 'string') {
      const key = methodIdKey(id);
      return key.length > 0 ? key : null;
    }
  }
  return null;
}

/**
 * Declared methods that still have a live destination, in declaration order.
 * Unknown shapes are dropped (they can never be taken).
 */
export function methodsWithLiveDestination(declared: readonly unknown[], liveMethodKeys: ReadonlySet<string>): unknown[] {
  const out: unknown[] = [];
  for (const entry of declared) {
    const id = methodIdFromOfferEntry(entry);
    if (id !== null && liveMethodKeys.has(id)) out.push(entry);
  }
  return out;
}

/**
 * Which declared methods a sell maker still lacks a destination for.
 * Returns method keys (lowercased), not display strings.
 */
export function missingSellDestinations(declared: readonly unknown[], liveMethodKeys: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const entry of declared) {
    const id = methodIdFromOfferEntry(entry);
    if (id === null) continue;
    if (liveMethodKeys.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push(id);
  }
  return missing;
}

/** A sell offer is board-visible only when at least one method can still be paid. */
export function sellOfferBoardable(declared: readonly unknown[], liveMethodKeys: ReadonlySet<string>): boolean {
  return methodsWithLiveDestination(declared, liveMethodKeys).length > 0;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const METHOD_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

/**
 * Country code shape only.
 *
 * Deliberately NOT a list of countries we serve: `packages/config` owns
 * jurisdiction, and a second, quietly-diverging list of country codes in a P2P
 * service is exactly the kind of duplicate truth §0.3 is about. This checks the
 * value is an ISO 3166-1 alpha-2 shape (or the wildcard) and nothing more.
 */
export function normaliseCountry(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (value === ANY_COUNTRY) return ANY_COUNTRY;
  if (!COUNTRY_RE.test(value)) {
    throw new InstrumentError(`"${raw}" is not an ISO 3166-1 alpha-2 country code`, 'p2p.instrument_country_invalid');
  }
  return value;
}

export function normaliseMethodId(raw: string): string {
  const value = methodIdKey(raw);
  if (!METHOD_ID_RE.test(value)) {
    throw new InstrumentError(
      `"${raw}" is not a usable method id — lowercase letters, digits, "_" and "-", starting with a letter`,
      'p2p.instrument_schema_invalid',
    );
  }
  return value;
}

/**
 * THE ONE RULE FOR COMPARING TWO METHOD IDS. Case and padding are not meaning.
 *
 * Every write path stores a method id through `normaliseMethodId`, so what is
 * in the database is always lowercase. The read paths did not all agree: an
 * offer's `methods` array is stored verbatim from the maker, and a taker sends
 * back whatever the offer showed them. A maker who declared `"Bank_Transfer"`
 * therefore produced a take carrying `Bank_Transfer` and a stored instrument
 * keyed `bank_transfer` — and the lookup, comparing them exactly, told the
 * seller they had no destination while holding it.
 *
 * That is why this is a separate function from `normaliseMethodId` rather than
 * a call to it: a COMPARISON must not throw. The strings being compared here
 * arrive from a stranger taking an offer, and an id that could never name an
 * instrument has to fall through to the ordinary "no such destination" refusal
 * — not become a schema-validation error that distinguishes itself from it.
 *
 * Registration (`normaliseMethodId`) is where a malformed id is refused, in
 * front of the operator who typed it.
 */
export function methodIdKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validate an operator's field list before it is stored.
 *
 * A bad schema is worse than no schema: it is accepted once and then rejects
 * every instrument a real user tries to register, at a point where the user
 * cannot tell whether they typed something wrong or we did.
 */
/** The longest legal name identity holds (contracts `customerDetailsSchema.legalName`), so the longest holder field. */
export const HOLDER_NAME_MAX = 200;

export function parseFieldSpecs(raw: unknown): FieldSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InstrumentError('A method schema needs at least one field', 'p2p.instrument_schema_invalid');
  }
  if (raw.length > MAX_FIELDS) {
    throw new InstrumentError(`A method schema may declare at most ${MAX_FIELDS} fields`, 'p2p.instrument_schema_invalid');
  }

  const seen = new Set<string>();
  const specs: FieldSpec[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      throw new InstrumentError('Each field must be an object', 'p2p.instrument_schema_invalid');
    }
    const f = entry as Record<string, unknown>;

    const key = typeof f.key === 'string' ? f.key.trim().toLowerCase() : '';
    if (!KEY_RE.test(key)) {
      throw new InstrumentError(`"${String(f.key)}" is not a usable field key`, 'p2p.instrument_schema_invalid');
    }
    if (seen.has(key)) {
      throw new InstrumentError(`Field "${key}" is declared twice`, 'p2p.instrument_schema_invalid', key);
    }
    seen.add(key);

    const label = typeof f.label === 'string' ? f.label.trim() : '';
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      throw new InstrumentError(`Field "${key}" needs a label of 1–${MAX_LABEL_LENGTH} characters`, 'p2p.instrument_schema_invalid', key);
    }

    const spec: {
      key: string;
      label: string;
      required: boolean;
      pattern?: string;
      minLength?: number;
      maxLength?: number;
      sensitive?: boolean;
      help?: string;
      holderName?: boolean;
    } = { key, label, required: f.required !== false };

    if (f.pattern !== undefined) {
      if (typeof f.pattern !== 'string' || f.pattern.length === 0 || f.pattern.length > MAX_PATTERN_LENGTH) {
        throw new InstrumentError(
          `Field "${key}" has a pattern that is empty or longer than ${MAX_PATTERN_LENGTH}`,
          'p2p.instrument_schema_invalid',
          key,
        );
      }
      // Compiled now so a broken pattern fails at registration, in front of the
      // operator, rather than at every user's first attempt to save.
      //
      // THE COMPILED FORM IS THE FORM THAT RUNS. That was the bug: registration
      // used to check `new RegExp(pattern, 'u')` while validation ran a
      // different string — `^(?:${body})$` after textually stripping a leading
      // `^` and a trailing `$`. The strip was blind to escapes, so `\d+\$` — a
      // currency-amount field, entirely plausible — passed registration and then
      // threw a raw `SyntaxError` (`/^(?:\d+\)$/u: Unterminated group`) at every
      // user's first save. Not an InstrumentError, so it surfaced as
      // INTERNAL_SERVER_ERROR: precisely the failure the paragraph above says
      // this check exists to prevent.
      //
      // There is now no second form. `compilePattern` produces the one object
      // `validateDetails` uses, anchoring is a property of the matcher rather
      // than of a rewritten string, and the compile is cached so the pattern is
      // parsed once instead of on every validation call.
      compilePattern(f.pattern, key);
      spec.pattern = f.pattern;
    }

    const bounds = readBounds(f, key);
    if (bounds.minLength !== undefined) spec.minLength = bounds.minLength;
    if (bounds.maxLength !== undefined) spec.maxLength = bounds.maxLength;

    if (f.sensitive !== undefined) spec.sensitive = f.sensitive === true;
    if (typeof f.help === 'string' && f.help.trim().length > 0) spec.help = f.help.trim().slice(0, 400);
    if (f.holderName !== undefined && f.holderName !== false) {
      if (f.holderName !== true) {
        throw new InstrumentError(`Field "${key}" has a holderName that is not true or false`, 'p2p.instrument_schema_invalid', key);
      }
      // A name that may be left out could never be checked, so the field that carries it is always required.
      if (!spec.required) {
        throw new InstrumentError(`Field "${key}" names the account holder, so it must be required`, 'p2p.instrument_schema_invalid', key);
      }
      // Identity holds a legal name of at most HOLDER_NAME_MAX characters and checks nothing longer: a longer value
      // would be refused there on every try and read as "could not be checked".
      if (spec.maxLength === undefined || spec.maxLength > HOLDER_NAME_MAX) {
        throw new InstrumentError(
          `Field "${key}" names the account holder, so its maxLength must be set and at most ${HOLDER_NAME_MAX}`,
          'p2p.instrument_schema_invalid',
          key,
        );
      }
      spec.holderName = true;
    }

    specs.push(spec);
  }

  if (specs.filter((spec) => spec.holderName).length > 1) {
    throw new InstrumentError('A method schema names at most one account-holder field', 'p2p.instrument_schema_invalid');
  }
  return specs;
}

function readBounds(f: Record<string, unknown>, key: string): { minLength?: number; maxLength?: number } {
  const out: { minLength?: number; maxLength?: number } = {};

  for (const name of ['minLength', 'maxLength'] as const) {
    const value = f[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_VALUE_LENGTH) {
      throw new InstrumentError(`Field "${key}" has a ${name} outside 1–${MAX_VALUE_LENGTH}`, 'p2p.instrument_schema_invalid', key);
    }
    out[name] = value;
  }

  if (out.minLength !== undefined && out.maxLength !== undefined && out.minLength > out.maxLength) {
    throw new InstrumentError(`Field "${key}" has minLength above maxLength`, 'p2p.instrument_schema_invalid', key);
  }
  return out;
}

// ── The user's half: the details themselves ──────────────────────────────────

export type InstrumentDetails = Readonly<Record<string, string>>;

/**
 * Validate what the owner typed against what the operator declared.
 *
 * Two refusals matter more than the rest:
 *
 *   · **an undeclared key is rejected**, not ignored. Silently dropping unknown
 *     keys would let a client push arbitrary personal data into a blob nobody
 *     designed, that nobody validates, and that then has to be protected and
 *     eventually deleted like the rest of it. Storing exactly the declared
 *     fields is what makes "what personal data do we hold" answerable.
 *   · **a required field that is present but blank is missing**, because a
 *     payer cannot send money to a whitespace string any more than to a null.
 */
export function validateDetails(schema: MethodSchema, raw: unknown): InstrumentDetails {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InstrumentError('Instrument details must be an object of field values', 'p2p.instrument_field_invalid');
  }

  const declared = new Map(schema.fields.map((f) => [f.key, f]));
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      throw new InstrumentError(
        `"${schema.methodId}" in ${schema.country} declares no field "${key}"`,
        'p2p.instrument_field_undeclared',
        key,
      );
    }
  }

  const out: Record<string, string> = {};

  for (const field of schema.fields) {
    const value = input[field.key];

    if (value === undefined || value === null || value === '') {
      if (field.required) {
        throw new InstrumentError(`"${field.label}" is required`, 'p2p.instrument_field_missing', field.key);
      }
      continue;
    }

    if (typeof value !== 'string') {
      throw new InstrumentError(`"${field.label}" must be text`, 'p2p.instrument_field_invalid', field.key);
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (field.required) throw new InstrumentError(`"${field.label}" is required`, 'p2p.instrument_field_missing', field.key);
      continue;
    }
    if (trimmed.length > MAX_VALUE_LENGTH) {
      throw new InstrumentError(
        `"${field.label}" is longer than ${MAX_VALUE_LENGTH} characters`,
        'p2p.instrument_field_invalid',
        field.key,
      );
    }
    if (field.minLength !== undefined && trimmed.length < field.minLength) {
      throw new InstrumentError(
        `"${field.label}" is shorter than ${field.minLength} characters`,
        'p2p.instrument_field_invalid',
        field.key,
      );
    }
    if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
      throw new InstrumentError(`"${field.label}" is longer than ${field.maxLength} characters`, 'p2p.instrument_field_invalid', field.key);
    }
    if (field.pattern !== undefined && !compilePattern(field.pattern, field.key).test(trimmed)) {
      // The message names the field and never the value: an error string is the
      // one place personal data escapes into logs without anyone deciding to. The operator's hint says what is expected.
      const hint = field.help === undefined ? '' : `: ${field.help}`;
      throw new InstrumentError(`"${field.label}" is not in the expected format${hint}`, 'p2p.account_format_invalid', field.key);
    }

    out[field.key] = trimmed;
  }

  return Object.freeze(out);
}

/**
 * Compile an operator pattern — once, and to the thing that actually runs.
 *
 * Whole-value by construction: a half-anchored operator pattern is not a
 * validation, and `[0-9]{4}` must not accept `1234abcd`. The previous version
 * of this achieved that by rewriting the pattern into `^(?:${body})$` after
 * stripping a leading `^` and trailing `$` with two regexes that could not tell
 * an anchor from an escaped literal. Nothing here rewrites anything: `^` and `$`
 * are parsed as assertions, and the match is anchored because the matcher is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS CACHED
 *
 * It was previously rebuilt on EVERY validation call — one regex compile per
 * field per save. The cache is keyed on the pattern source, so the object built
 * at registration is the object used at validation, which is what makes
 * "registration checked the form that runs" true rather than merely intended.
 *
 * Bounded, and cleared rather than evicted one-by-one: the population is
 * operator method schemas, which is small and changes rarely, so an LRU would
 * be machinery for a problem this does not have. The cap exists so that a
 * pathological caller cannot grow it without limit, not to manage churn.
 */
const PATTERN_CACHE = new Map<string, LinearPattern>();
const PATTERN_CACHE_LIMIT = 256;

function compilePattern(source: string, key: string): LinearPattern {
  const cached = PATTERN_CACHE.get(source);
  if (cached !== undefined) return cached;

  let compiled: LinearPattern;
  try {
    compiled = LinearPattern.compile(source);
  } catch (err) {
    if (err instanceof PatternError) {
      // Every refusal names the field and the reason, and none of them names a
      // value. An operator gets told what is wrong with the pattern they wrote;
      // nobody gets told what someone typed into it.
      throw new InstrumentError(
        err.problem === 'unsupported'
          ? `Field "${key}" has a pattern this validator cannot run: ${err.message}`
          : `Field "${key}" has a pattern that is not a valid regular expression: ${err.message}`,
        'p2p.instrument_schema_invalid',
        key,
      );
    }
    throw err;
  }

  if (PATTERN_CACHE.size >= PATTERN_CACHE_LIMIT) PATTERN_CACHE.clear();
  PATTERN_CACHE.set(source, compiled);
  return compiled;
}

/**
 * A stable identifier for "which account is this", derived from the values.
 *
 * Kept for two things the values themselves cannot be kept for:
 *
 *   1. after the retention purge wipes a closed trade's snapshot, the
 *      fingerprint still answers "was the buyer shown the same account the
 *      seller claims" in an appeal — without us still holding the account;
 *   2. it makes an edit visible. Two snapshots with different fingerprints on
 *      one seller's trades are a seller who changed destination, which is the
 *      shape of the mid-trade account swap.
 *
 * SHA-256 over canonical JSON — sorted keys, so key order cannot change it.
 */
export function fingerprintDetails(methodId: string, country: string, details: InstrumentDetails): string {
  const canonical = JSON.stringify(
    Object.keys(details)
      .sort()
      .map((k) => [k, details[k]]),
  );
  return createHash('sha256').update(`${methodId} ${country} ${canonical}`).digest('hex');
}

/**
 * Which schema applies to an instrument in a country.
 *
 * Exact country beats the wildcard, always. A method that has been given a
 * country-specific field list in NG must not fall back to the generic one there
 * just because the generic one also exists — the specific list is the operator
 * saying "this market is different", and silently ignoring that is how a
 * complete-looking instrument turns out to be unpayable.
 */
export function pickSchema(schemas: readonly MethodSchema[], methodId: string, country: string): MethodSchema | null {
  const forMethod = schemas.filter((s) => s.methodId === methodId);
  return forMethod.find((s) => s.country === country) ?? forMethod.find((s) => s.country === ANY_COUNTRY) ?? null;
}
