/**
 * SANCTIONS / REGION SCREENING LIST — §24 Lane A, as configuration.
 *
 *   "Sanctions-screening on the hosted front-end per applicable law; the
 *    contracts themselves are permissionless infrastructure."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * `checkAccess` has always been able to refuse a region. Nothing has ever told
 * it which regions to refuse, so it refused none — and a decision that screened
 * nothing was byte-for-byte identical to a decision that screened a real list
 * and cleared you. Every call site, every test and every log line saw the same
 * `allowed`. The mechanism was green because it was empty.
 *
 * This file makes the states different things:
 *
 *   `unset`          → NO list was consulted. Not "clean", *unknown*.
 *   `listed`         → a list exists, and this region is not on it.
 *   `reviewed-empty` → somebody with standing reviewed it and recorded that no
 *                      region is screened out. A decision, not a default.
 *
 * and `assertScreeningConfigured` (jurisdiction.ts) refuses to let a
 * production-like process boot in the first state.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS ONE AUTHORITY. THE JURISDICTION MATRIX IS A DIFFERENT ONE.
 *
 * A `ScreeningList` is COUNSEL-SUPPLIED CONTENT: who may not be served, for
 * legal reasons, under a named governance record.
 *
 * A `JURISDICTION_MATRIX` entry is BUSINESS CONFIGURATION: which markets we have
 * decided to open, at what tier, with what limits — edited by ordinary
 * contributors in ordinary PRs, for licensing, commercial or product reasons.
 *
 * They used to share this type. `JURISDICTION_MATRIX` blocks were folded into a
 * `ScreeningList` and merged with the env list, so ONE commercially-blocked
 * region flipped the production boot guard from "refuse to start" to
 * "satisfied" while the sanctions list was still empty and nobody in counsel had
 * supplied anything. That is exactly what the pay spec forbids — "nobody can
 * loosen a sanctions check while tuning something else" — arriving through the
 * jurisdiction matrix instead of through fraud.
 *
 * So: nothing in this file may be constructed from the matrix. A matrix block is
 * a `BusinessBlock` (jurisdiction.ts), it still refuses the region, and it
 * cannot satisfy this authority's guard. Where the two cannot be told apart —
 * a `blocked: true` entry whose reason nobody wrote down — the ambiguous case
 * REFUSES in both directions: the region stays blocked, and the boot guard stays
 * unsatisfied.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SANCTIONED LIST ROWS — the owner's launch default, UNSIGNED until he signs
 *
 * The owner decided the contents (project-state OWNER 258 (1)): "use
 * Hyperliquid's own restricted list as the launch default, signed by you, with
 * counsel reviewing at launch prep. Until a list exists, the live app lets
 * nobody in." `SANCTIONED_LIST_ROWS` below is that list as rows: one per
 * jurisdiction, with its ISO 3166 code, the reason, the source link, and a mark
 * that the row is the agents' reading of the sanctioned territories (Hyperliquid
 * terms 1.6 (b); citizens of the same rows, 1.6 (c)), not Hyperliquid's text.
 *
 * Each row carries a `signature` that is `null` until the owner signs. Which
 * list a process screens with (`envScreeningList`):
 *
 *   1. `INTAFACED_SANCTIONS_REGIONS` set (non-blank) → the env value, as below.
 *      The operator's override: an env list REPLACES the rows, and `none` keeps
 *      its attribution rule.
 *   2. Otherwise, rows all signed                   → the rows, everywhere.
 *   3. Otherwise, APP_ENV exactly `dev` or `test`    → the unsigned rows, so a
 *      test stack screens with real content (unless
 *      `INTAFACED_UNSIGNED_SANCTIONS_ROWS=off`, which keeps it `unset`).
 *   4. Otherwise                                     → `unset`, and the boot guard
 *      refuses: "the live app lets nobody in" until the owner signs.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN: a signed list. A production-like
 * process ships empty (`UNSET_SCREENING_LIST`) until the owner signs every row
 * or the operator supplies the env list, and an agent never writes a signature. These rows are screening content,
 * never business blocks: nothing here is built from `JURISDICTION_MATRIX`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONFIGURED SHAPE — one variable, three answers
 *
 *   INTAFACED_SANCTIONS_REGIONS
 *     Unset or blank      → the rows (signed, or unsigned on dev/test), else
 *                           `unset`. Boot guard refuses on `unset`.
 *     `none`              → `reviewed-empty`. See below; requires attribution.
 *     A list of codes     → `listed`.
 *
 *     A list is comma-separated. Each item is an ISO 3166-1 alpha-2 country
 *     code or an ISO 3166-2 subdivision code (`AA-01`: a region listed without
 *     its country), optionally followed by `:` and the reason an operator (or a
 *     refused user) should see. A listed country covers its subdivisions; a
 *     listed subdivision covers only itself. Whitespace around items is ignored; codes are case-insensitive.
 *
 *       INTAFACED_SANCTIONS_REGIONS="AA:UNSC resolution ref,BB:programme ref"
 *
 *     A reason is not required, but supply one. It is what the refusal says,
 *     what the audit log carries, and what tells the next operator whether an
 *     entry is still current or a leftover from a lifted programme.
 *
 *     ONE VARIABLE, NOT TWO, on purpose: "reviewed and deliberately empty" is an
 *     answer to the same question a list answers, so it lives in the same place.
 *     A second variable would create a state where both are set and contradict
 *     each other, and there is no honest way to resolve that.
 *
 *   INTAFACED_SANCTIONS_LIST_SOURCE
 *     Free-text provenance for the answer above — the governance record, ticket,
 *     or published list revision it came from. Recorded on every screening
 *     decision so "who decided this, and when" is answerable from a log line
 *     rather than from someone's memory.
 *
 *       INTAFACED_SANCTIONS_LIST_SOURCE="counsel-memo-2026-08-01"
 *
 *     OPTIONAL for a list, MANDATORY for `none`. Not an inconsistency: a
 *     populated list is self-evidencing — someone typed region codes and reasons,
 *     and the content itself is the act. `none` has no content. Attribution is
 *     then the ONLY evidence that a review happened rather than somebody
 *     silencing a boot failure, so without it there is nothing to distinguish
 *     the two and the parser refuses.
 */

/** Env var holding the screening answer. See the header for the three shapes. */
export const SANCTIONS_REGIONS_ENV = 'INTAFACED_SANCTIONS_REGIONS';

/** Env var holding the answer's provenance. */
export const SANCTIONS_SOURCE_ENV = 'INTAFACED_SANCTIONS_LIST_SOURCE';

/**
 * The one value of `SANCTIONS_REGIONS_ENV` that means "reviewed, and no region
 * is screened out". Case-insensitive, and it must be the whole value.
 *
 * It is a four-letter word rather than a two-letter one so it can never collide
 * with an ISO-3166 alpha-2 code, and so a half-typed list cannot land on it.
 */
export const SCREENING_REVIEWED_EMPTY = 'none';

/**
 * WHO refused a region.
 *
 * Carried so an auditor reading a refusal can tell a legal control from a
 * commercial one. They are not interchangeable, and a decision that cannot say
 * which one it was is a decision nobody can review.
 */
export type BlockAuthority =
  /** Counsel-supplied screening content. This file. */
  | 'screening'
  /** `JURISDICTION_MATRIX` business configuration. jurisdiction.ts. */
  | 'business';

/**
 * What the screening authority has said, if anything.
 *
 * `unset` and `reviewed-empty` both screen zero regions and are NOT the same
 * thing. Conflating them is how "nobody has done this yet" gets read as a clean
 * bill of health.
 */
export type ScreeningDeclaration =
  /** Nobody has supplied anything. The boot guard refuses on this, and only this. */
  | 'unset'
  /** A list was supplied and names at least one region. */
  | 'listed'
  /** Reviewed, and deliberately empty, on a named authority. */
  | 'reviewed-empty';

export interface ScreenedRegion {
  /** ISO 3166-1 alpha-2 or ISO 3166-2 subdivision (`AA-01`), upper-cased. */
  readonly region: string;
  /** Shown on refusal and carried in the audit log. */
  readonly reason: string;
  /** Where this entry came from — the governance record, or the env var name. */
  readonly source: string;
  /**
   * Always `'screening'`, and it is a literal type rather than a free field: a
   * matrix block is a `BusinessBlock`, a different type, so the two cannot be
   * assigned into each other's collections by accident.
   */
  readonly authority: 'screening';
}

export interface ScreeningList {
  readonly regions: readonly ScreenedRegion[];
  /** Which of the three states this is. See `ScreeningDeclaration`. */
  readonly declaration: ScreeningDeclaration;
  /**
   * Was a real answer supplied at all?
   *
   * The whole point of this file. `false` means nothing was screened — NOT that
   * the caller's region is clear. Never render this as a green tick.
   *
   * Derived from `declaration`, and kept because every existing reader asks this
   * question. `true` with zero regions is now REACHABLE and meaningful — that is
   * `reviewed-empty` — so anything rendering a count must read `declaration` too.
   */
  readonly configured: boolean;
  /** Provenance, for logs and the operator dashboard. */
  readonly source: string;
}

/**
 * Regions in the `unset` list. Always empty: `unset` means no list was consulted.
 * The owner's list lives in `SANCTIONED_LIST_ROWS`, never here. Tests pin `length === 0`.
 */
export const SHIPPED_SCREENING_REGIONS: readonly ScreenedRegion[] = [];

/** The owner's signature on a row: who signed, when (ISO 8601), and the record that holds his words. */
export interface SanctionedRowSignature {
  readonly signedBy: string;
  readonly signedAt: string;
  readonly record: string;
}

/** Marks a row as the agents' reading of the sanctioned territories, not Hyperliquid's own text. */
export const SANCTIONED_ROW_READING = "agents' reading, not Hyperliquid's text" as const;

/** OFAC's sanctions programs page, the source every row cites. */
export const OFAC_SANCTIONS_PROGRAMS_URL = 'https://ofac.treasury.gov/sanctions-programs-and-country-information';

/** One jurisdiction on the owner's sanctioned list. */
export interface SanctionedRow {
  /** ISO 3166-1 alpha-2, or an ISO 3166-2 subdivision (covers only itself). Upper-case. */
  readonly region: string;
  /** Shown on refusal and carried in the audit log. */
  readonly reason: string;
  readonly sourceUrl: string;
  readonly reading: typeof SANCTIONED_ROW_READING;
  /** `null` until the owner signs (OWNER 258 (1)). Never filled by an agent. */
  readonly signature: SanctionedRowSignature | null;
}

function row(region: string, reason: string): SanctionedRow {
  return { region, reason, sourceUrl: OFAC_SANCTIONS_PROGRAMS_URL, reading: SANCTIONED_ROW_READING, signature: null };
}

/**
 * The owner's launch default (OWNER 258 (1)): the comprehensively sanctioned territories, residence (1.6 (b)) and
 * citizenship (1.6 (c)) alike. Unsigned. Counsel reviews at launch prep.
 */
export const SANCTIONED_LIST_ROWS: readonly SanctionedRow[] = [
  row('CU', 'Cuba: comprehensively sanctioned (OFAC Cuba sanctions)'),
  row('IR', 'Iran: comprehensively sanctioned (OFAC Iran sanctions)'),
  row('KP', 'North Korea: comprehensively sanctioned (OFAC North Korea sanctions)'),
  row('SY', 'Syria: comprehensively sanctioned (OFAC Syria sanctions)'),
  row('UA-43', 'Crimea region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)'),
  row('UA-40', 'Sevastopol, Crimea region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)'),
  row('UA-14', 'Donetsk region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)'),
  row('UA-09', 'Luhansk region of Ukraine: comprehensively sanctioned (OFAC Ukraine-/Russia-related sanctions)'),
];

/** Provenance of a list built from the rows. Names the config, never a value from the env. */
export const SANCTIONED_ROWS_SOURCE_SIGNED = 'config:SANCTIONED_LIST_ROWS (signed)';
export const SANCTIONED_ROWS_SOURCE_UNSIGNED = `config:SANCTIONED_LIST_ROWS (unsigned, ${SANCTIONED_ROW_READING}; dev/test only)`;

function signatureComplete(sig: SanctionedRowSignature | null): boolean {
  return sig !== null && sig.signedBy.trim() !== '' && sig.signedAt.trim() !== '' && sig.record.trim() !== '';
}

/** True only when there is at least one row and every row carries a complete owner signature. */
export function sanctionedRowsSigned(rows: readonly SanctionedRow[] = SANCTIONED_LIST_ROWS): boolean {
  return rows.length > 0 && rows.every((r) => signatureComplete(r.signature));
}

/** The rows as a screening list (`listed`), with the source saying whether they are signed. */
export function screeningListFromRows(rows: readonly SanctionedRow[] = SANCTIONED_LIST_ROWS): ScreeningList {
  if (rows.length === 0) return UNSET_SCREENING_LIST;
  const source = sanctionedRowsSigned(rows) ? SANCTIONED_ROWS_SOURCE_SIGNED : SANCTIONED_ROWS_SOURCE_UNSIGNED;
  const seen = new Set<string>();
  const regions = rows.map((r): ScreenedRegion => {
    const region = r.region.trim().toUpperCase();
    if (!REGION_CODE.test(region) || seen.has(region)) {
      throw new ScreeningListError('Invalid SANCTIONED_LIST_ROWS:', [`row ${region} is not a unique ISO 3166 code`]);
    }
    seen.add(region);
    return { region, reason: r.reason, source, authority: 'screening' };
  });
  return { regions, declaration: 'listed', configured: true, source };
}

/**
 * The state before anyone supplies anything. Screens nothing, and says so.
 *
 * Named `UNSET`, not `EMPTY`: "deliberately empty" is a different, legitimate
 * state, and the two must not share a word — let alone a value.
 */
export const UNSET_SCREENING_LIST: ScreeningList = {
  regions: SHIPPED_SCREENING_REGIONS,
  declaration: 'unset',
  configured: false,
  source: 'unconfigured',
};

/**
 * APP_ENVs that must not boot on an unset owner list.
 *
 * `assertScreeningConfigured` (jurisdiction.ts) enforces this. The names live
 * here so a screening-only pin can fail if prod/staging drop off the guard
 * without this file noticing. Dev and test stay frictionless.
 */
export const OWNER_LIST_REQUIRED_ENVS = ['staging', 'prod'] as const;

/**
 * Substrings that mark a list as a test/fixture, not counsel.
 *
 * Matching is case-insensitive on provenance and reasons. Unassigned ISO codes
 * (AA, ZY, QQ) are allowed in tests; these markers are what stop a fixture
 * reading as a clean money-posture screen. Do not add country names here.
 */
export const SCREENING_FIXTURE_MARKERS = ['placeholder', 'test-fixture', 'not-a-real-list'] as const;

/** Public-door refuse: nobody supplied a list. */
export const SCREENING_REFUSE_UNCONFIGURED = 'denied.screening_unconfigured' as const;

/** Public-door refuse: a test/placeholder list was offered as if it were counsel. */
export const SCREENING_REFUSE_FIXTURE = 'denied.screening_fixture' as const;

export type ScreeningMoneyRefuseCode = typeof SCREENING_REFUSE_UNCONFIGURED | typeof SCREENING_REFUSE_FIXTURE;

export type ScreeningMoneyGrade = 'unconfigured' | 'fixture' | 'counsel';

export function screeningLooksLikeFixture(...texts: readonly string[]): boolean {
  return texts.some((text) => {
    const lower = text.toLowerCase();
    return SCREENING_FIXTURE_MARKERS.some((marker) => lower.includes(marker));
  });
}

/**
 * Grade for money-posture honesty. `listed` with a placeholder reason is NOT
 * counsel — `configured: true` must not be rendered as screened-clean.
 */
export function screeningMoneyGrade(list: ScreeningList): ScreeningMoneyGrade {
  if (list.declaration === 'unset') return 'unconfigured';
  if (screeningLooksLikeFixture(list.source, ...list.regions.map((r) => r.reason))) return 'fixture';
  return 'counsel';
}

export type ScreeningMoneyPosture =
  | {
      readonly allowed: true;
      readonly code: 'allowed.screening_counsel' | 'allowed.screening_dev_gap';
      readonly grade: ScreeningMoneyGrade;
      /** True only for counsel-grade lists. Fixtures and unset never read as clean. */
      readonly readsAsScreenedClean: boolean;
    }
  | {
      readonly allowed: false;
      readonly code: ScreeningMoneyRefuseCode;
      readonly grade: ScreeningMoneyGrade;
      readonly readsAsScreenedClean: false;
    };

/**
 * Prod/staging fail closed without counsel. Dev/test may boot on a gap, but
 * the gap still does not read as screened-clean.
 */
export function evaluateScreeningMoneyPosture(list: ScreeningList, appEnv: string): ScreeningMoneyPosture {
  const grade = screeningMoneyGrade(list);
  const enforced = (OWNER_LIST_REQUIRED_ENVS as readonly string[]).includes(appEnv);
  if (grade === 'counsel') {
    return { allowed: true, code: 'allowed.screening_counsel', grade, readsAsScreenedClean: true };
  }
  if (enforced && grade === 'unconfigured') {
    return { allowed: false, code: SCREENING_REFUSE_UNCONFIGURED, grade, readsAsScreenedClean: false };
  }
  if (enforced && grade === 'fixture') {
    return { allowed: false, code: SCREENING_REFUSE_FIXTURE, grade, readsAsScreenedClean: false };
  }
  return { allowed: true, code: 'allowed.screening_dev_gap', grade, readsAsScreenedClean: false };
}

export class ScreeningMoneyPostureError extends Error {
  constructor(
    readonly appEnv: string,
    readonly code: ScreeningMoneyRefuseCode,
    readonly grade: ScreeningMoneyGrade,
  ) {
    const named = `APP_ENV=${appEnv}`;
    super(
      code === SCREENING_REFUSE_UNCONFIGURED
        ? `SANCTIONS SCREENING MONEY POSTURE REFUSED (${named}, ${code}). ` +
            `Empty or whitespace ${SANCTIONS_REGIONS_ENV} is unset — not clean. ` +
            `Counsel/Nitro must supply a list (or attributed "${SCREENING_REVIEWED_EMPTY}"). ` +
            `Agents must not invent country codes.`
        : `SANCTIONS SCREENING MONEY POSTURE REFUSED (${named}, ${code}). ` +
            `A placeholder/test list cannot be read as screened clean. ` +
            `Replace fixture provenance/reasons with a counsel governance record. ` +
            `Agents must not invent country codes.`,
    );
    this.name = 'ScreeningMoneyPostureError';
  }
}

/** `unset` does not satisfy the boot guard. `listed` and `reviewed-empty` do. */
export function ownerListSatisfiesBoot(list: ScreeningList): boolean {
  return list.declaration !== 'unset';
}

/** Money posture: only counsel-grade lists satisfy prod/staging. */
export function ownerListSatisfiesMoneyPosture(list: ScreeningList): boolean {
  return screeningMoneyGrade(list) === 'counsel';
}

/**
 * What consulting the list for one region actually said.
 *
 * `unconsulted` is NOT a miss. An empty/unset list has no owner content, so a
 * lookup cannot come back as "clear" — that is how a hit used to pass silently.
 */
export type ScreeningConsult =
  | { readonly outcome: 'unconsulted'; readonly region: string; readonly declaration: 'unset' }
  | {
      readonly outcome: 'hit';
      readonly region: string;
      readonly reason: string;
      readonly source: string;
      readonly declaration: 'listed';
    }
  | {
      readonly outcome: 'fixture';
      readonly region: string;
      readonly declaration: 'listed' | 'reviewed-empty';
      readonly source: string;
    }
  | {
      readonly outcome: 'clear';
      readonly region: string;
      readonly declaration: 'listed' | 'reviewed-empty';
      readonly source: string;
    };

/**
 * Look up one region against a list. Unset never returns `clear`.
 * Fixture/test lists never return `clear` either — a miss is `fixture`, not screened-clean.
 *
 * Placeholder codes only at call sites. This function does not invent jurisdictions.
 */
export function consultScreeningList(list: ScreeningList, region: string): ScreeningConsult {
  const code = region.trim().toUpperCase();
  if (list.declaration === 'unset') {
    return { outcome: 'unconsulted', region: code, declaration: 'unset' };
  }
  const grade = screeningMoneyGrade(list);
  if (list.declaration === 'reviewed-empty') {
    if (grade === 'fixture') {
      return { outcome: 'fixture', region: code, declaration: 'reviewed-empty', source: list.source };
    }
    return { outcome: 'clear', region: code, declaration: 'reviewed-empty', source: list.source };
  }
  const chain = regionCodeChain(code);
  const hit = list.regions.find((entry) => chain.includes(entry.region));
  if (hit) {
    return { outcome: 'hit', region: code, reason: hit.reason, source: hit.source, declaration: 'listed' };
  }
  if (grade === 'fixture') {
    return { outcome: 'fixture', region: code, declaration: 'listed', source: list.source };
  }
  return { outcome: 'clear', region: code, declaration: 'listed', source: list.source };
}

export class ScreeningListError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(`${message}\n  - ${issues.join('\n  - ')}`);
    this.name = 'ScreeningListError';
  }
}

/** An ISO 3166-1 alpha-2 country, or an ISO 3166-2 subdivision of one (`CA-ON`, `UA-43`). */
const REGION_CODE = /^[A-Za-z]{2}(?:-[A-Za-z0-9]{1,3})?$/;
const SUBDIVISION_CODE = /^([A-Z]{2})-[A-Z0-9]{1,3}$/;

/** True when `code` (trimmed, upper-cased) is an ISO 3166-2 subdivision code such as `CA-ON`. */
export function isSubdivisionCode(code: string): boolean {
  return SUBDIVISION_CODE.test(code.trim().toUpperCase());
}

/**
 * The codes a region answers to, most specific first: `CA-ON` → `['CA-ON', 'CA']`, `CA` → `['CA']`.
 *
 * A row for a country covers every region in it; a row for a subdivision covers only that subdivision, so a
 * region can be refused without its country (Hyperliquid terms 1.6, read 9 Nov 2026). A bare country never
 * matches a subdivision row: who is in Ontario is only known when the subdivision is.
 */
export function regionCodeChain(region: string): readonly string[] {
  const code = region.trim().toUpperCase();
  const m = SUBDIVISION_CODE.exec(code);
  return m ? [code, m[1]!] : [code];
}

/**
 * Parse the env format into a list.
 *
 * Malformed entries throw rather than being skipped. A silently dropped entry
 * is a region we believe we are blocking and are not — which is the exact
 * failure this whole file exists to make impossible, reintroduced one typo at a
 * time. Every problem is reported at once so a bad list is fixed in one pass.
 */
export function parseScreeningList(raw: string | undefined, source?: string): ScreeningList {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return UNSET_SCREENING_LIST;

  const attribution = source?.trim() ?? '';

  // ── "reviewed, and deliberately empty" ───────────────────────────────────
  // A recorded decision. It satisfies the boot guard, which is precisely why it
  // must cost something: without attribution it is indistinguishable from
  // somebody typing four letters to make a startup failure go away, and that is
  // the failure mode the guard exists to prevent.
  if (trimmed.toLowerCase() === SCREENING_REVIEWED_EMPTY) {
    if (attribution === '') {
      throw new ScreeningListError(`${SANCTIONS_REGIONS_ENV}="${trimmed}" needs an attributable source:`, [
        `"${SCREENING_REVIEWED_EMPTY}" is the statement "this was reviewed, and no region is screened out". ` +
          `That is a compliance decision with an owner, not a default.`,
        `Set ${SANCTIONS_SOURCE_ENV} to the governance record that says so ` + `(e.g. ${SANCTIONS_SOURCE_ENV}="counsel-memo-2026-08-01").`,
        `If nobody has reviewed this yet, leave ${SANCTIONS_REGIONS_ENV} unset instead. ` +
          `An unset variable is the honest answer, and the boot guard will say so out loud.`,
      ]);
    }
    return { regions: [], declaration: 'reviewed-empty', configured: true, source: attribution };
  }

  const provenance = attribution || `env:${SANCTIONS_REGIONS_ENV}`;
  const issues: string[] = [];
  const seen = new Set<string>();
  const regions: ScreenedRegion[] = [];

  // Issues name an entry by its position, never by its content: the raw value
  // is the `INTAFACED_SANCTIONS_REGIONS` secret, and this message is thrown at
  // boot, where it lands in a service log that CI prints into a public job log.
  let position = 0;
  for (const item of trimmed.split(',')) {
    const entry = item.trim();
    position += 1;
    if (entry === '') continue;

    const colon = entry.indexOf(':');
    const code = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    const reason = (colon === -1 ? '' : entry.slice(colon + 1)).trim();

    if (!REGION_CODE.test(code)) {
      issues.push(
        `entry ${position} — expected an ISO 3166-1 alpha-2 or ISO 3166-2 code, optionally followed by ":reason" (value not shown)`,
      );
      continue;
    }

    const upper = code.toUpperCase();
    if (seen.has(upper)) {
      issues.push(`entry ${position} repeats an earlier region — one entry per region, so there is one reason to maintain`);
      continue;
    }

    seen.add(upper);
    regions.push({
      region: upper,
      reason: reason || `Not served in ${upper} (sanctions screening, §24 Lane A)`,
      source: provenance,
      authority: 'screening',
    });
  }

  if (issues.length > 0) {
    throw new ScreeningListError(`Invalid ${SANCTIONS_REGIONS_ENV}:`, issues);
  }

  // Reachable when the value is only commas and whitespace. That is somebody
  // meaning to supply a list and supplying nothing — which is NOT the same as
  // deciding there is nothing to supply, and it carries no attribution. So it is
  // `unset`, and the boot guard treats it exactly like an absent variable.
  // Somebody who means "deliberately empty" writes `none` and signs it.
  if (regions.length === 0) return UNSET_SCREENING_LIST;

  return { regions, declaration: 'listed', configured: true, source: provenance };
}

/**
 * The list a process with this env screens with, from the rows or the env override. See the header, "THE
 * SANCTIONED LIST ROWS": an env value replaces the rows; signed rows apply everywhere; unsigned rows apply only when
 * APP_ENV is exactly `dev` or `test`; anything else is `unset`, which the boot guard refuses.
 *
 * `rows` is the test seam for a signed or staged set; production callers pass nothing.
 */
export function configuredScreeningList(
  env: Record<string, string | undefined> = process.env,
  rows: readonly SanctionedRow[] = SANCTIONED_LIST_ROWS,
): ScreeningList {
  const raw = env[SANCTIONS_REGIONS_ENV];
  if ((raw?.trim() ?? '') !== '') return parseScreeningList(raw, env[SANCTIONS_SOURCE_ENV]);
  if (sanctionedRowsSigned(rows)) return screeningListFromRows(rows);
  const appEnv = env.APP_ENV;
  if ((appEnv === 'dev' || appEnv === 'test') && !unsignedRowsSwitchedOff(env)) return screeningListFromRows(rows);
  return UNSET_SCREENING_LIST;
}

/**
 * Dev/test only: `off` keeps the UNSIGNED rows out, so a dev or test process with no env list screens with nothing
 * (`unset`), exactly as a production-like process does today. It can only make screening stricter: production never
 * reads unsigned rows, and signed rows ignore it. For tests that prove the blank-list refusal.
 */
export const UNSIGNED_SANCTIONS_ROWS_ENV = 'INTAFACED_UNSIGNED_SANCTIONS_ROWS';

function unsignedRowsSwitchedOff(env: Record<string, string | undefined>): boolean {
  return env[UNSIGNED_SANCTIONS_ROWS_ENV]?.trim().toLowerCase() === 'off';
}

let cache: {
  raw: string | undefined;
  source: string | undefined;
  appEnv: string | undefined;
  rowsOff: string | undefined;
  list: ScreeningList;
} | null = null;

/**
 * The screening list for this process: the env override, else the rows (`configuredScreeningList`).
 *
 * Keyed on the raw strings rather than memoised once, so a test (or an operator
 * hot-reloading config) that changes the variable is picked up without a reset
 * hook that somebody has to remember to call.
 */
export function envScreeningList(env: Record<string, string | undefined> = process.env): ScreeningList {
  const raw = env[SANCTIONS_REGIONS_ENV];
  const source = env[SANCTIONS_SOURCE_ENV];
  const appEnv = env.APP_ENV;
  const rowsOff = env[UNSIGNED_SANCTIONS_ROWS_ENV];
  if (cache && cache.raw === raw && cache.source === source && cache.appEnv === appEnv && cache.rowsOff === rowsOff) return cache.list;
  const list = configuredScreeningList(env);
  cache = { raw, source, appEnv, rowsOff, list };
  return list;
}
