/**
 * The trading checks (J-cex-spot-01 #3; OWNER 258 (4): "trading-only users get country and sanctions checks. The full ID
 * vendor comes with the bank."). A person gives their legal name and confirms the country they live in; the check
 * screens that name, the date of birth they gave at sign-up and the country against the owner's sanctions list
 * (`IDENTITY_SANCTIONS_PERSONS_LIST`, NO DEFAULT). No ID document, selfie or ID vendor is asked for.
 *
 *   - clear: a level-basic record for trading, approved by the check itself (`reviewed_by` 'trading-checks'), opened and
 *     decided in one transaction with its case, the capabilities the owner maps to the level, and this check's row.
 *   - hit: the account is held. A pending level-basic record goes to a person in compliance, nothing is granted, and the
 *     person reads a neutral "under review" that never says why.
 *   - list blank: refuses `kyc.screening_list_unset` and writes nothing. A list is never invented.
 *
 * The business key is `kyc:trading-checks:<user id>`: a repeat answers the first outcome and never screens again, so a
 * held person cannot clear themselves by sending the check once more. The legal name and the date of birth are sealed
 * under the KYC document key; with the key unset every door refuses `kyc.trading_checks_unconfigured`. Personal fields
 * are never logged.
 */
import { checkAccess, type KycTier } from '@intafaced/config';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { countryCode } from '../auth/sign-up.js';
import { grantOnApproval, markRequested, type KycCapabilityMap } from './capabilities.js';
import { approveKycCase, openKycCase } from './cases.js';
import { openBirthDate } from './birth-date.js';
import { encryptDocument } from './document-crypto.js';

export type TradingCheckErrorCode =
  | 'kyc.screening_list_unset'
  | 'kyc.trading_checks_unconfigured'
  | 'kyc.date_of_birth_unknown'
  | 'kyc.country_unconfirmed'
  | 'kyc.country_invalid'
  | 'kyc.country_unknown'
  | 'kyc.country_mismatch'
  | 'kyc.region_blocked'
  | 'kyc.legal_name_invalid'
  | 'kyc.level_held';

export class TradingCheckError extends Error {
  constructor(
    message: string,
    readonly code: TradingCheckErrorCode,
  ) {
    super(message);
    this.name = 'TradingCheckError';
  }
}

/** Who reviewed a level the trading checks cleared. Never a person's id, so it can never be read as an operator's. */
export const TRADING_CHECKS_REVIEWER = 'trading-checks';

export interface SanctionsPerson {
  readonly legalName: string;
  readonly dateOfBirth: string;
  readonly country: string;
}

export interface SanctionsPersonList {
  /** What the list is (its source and date), as the owner published it. */
  readonly label: string;
  readonly entries: readonly SanctionsPerson[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEST_LABEL = /^TEST\b/;

/**
 * A name as the screen compares it: accents and case folded, every run of non-letters one space. "TEST  listed-person"
 * and "test listed person" are the same name; nothing fuzzier is claimed.
 */
export function screeningName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * `IDENTITY_SANCTIONS_PERSONS_LIST`: `{"label": "...", "entries": [{"legalName", "dateOfBirth", "country"}]}`. Unset or
 * blank is no list (null), and every check refuses. A list with no entries, a malformed entry, or malformed JSON stops
 * the service: "no names listed" and "not published" must not look the same. A list labelled TEST is refused outside
 * APP_ENV dev or test, so a test list can never screen real people.
 */
export function parseSanctionsPersonsList(raw: string | undefined, appEnv: string | undefined): SanctionsPersonList | null {
  const setting = 'IDENTITY_SANCTIONS_PERSONS_LIST';
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${setting} must be a JSON object with a label and entries`);
  }
  const value = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as { label?: unknown; entries?: unknown };
  if (typeof value.label !== 'string' || value.label.trim() === '') throw new Error(`${setting} needs a label naming its source`);
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new Error(`${setting} must list at least one entry`);
  if (TEST_LABEL.test(value.label.trim()) && appEnv !== 'dev' && appEnv !== 'test')
    throw new Error(`${setting} is a TEST list, refused outside APP_ENV dev or test`);
  const entries = value.entries.map((row, i) => {
    const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const name = typeof r.legalName === 'string' ? screeningName(r.legalName) : '';
    const country = typeof r.country === 'string' ? countryCode(r.country) : undefined;
    if (!name || typeof r.dateOfBirth !== 'string' || !DATE.test(r.dateOfBirth) || !country)
      throw new Error(`${setting}: entry ${i + 1} needs a legalName, a dateOfBirth (YYYY-MM-DD) and a country`);
    return { legalName: name, dateOfBirth: r.dateOfBirth, country };
  });
  return { label: value.label.trim(), entries };
}

/** A hit is the same name, the same date of birth and the same country as one entry. */
export function screenPerson(list: SanctionsPersonList, person: SanctionsPerson): 'clear' | 'hit' {
  const name = screeningName(person.legalName);
  const country = person.country.toUpperCase();
  return list.entries.some((e) => e.legalName === name && e.dateOfBirth === person.dateOfBirth && e.country === country) ? 'hit' : 'clear';
}

/**
 * True when every approved, unlapsed level the person holds was cleared by the trading checks alone: the level reads
 * "for trading", since no ID was checked. A level a person in compliance approved is never trading only.
 */
export async function tradingOnly(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<Array<{ reviewed_by: string | null }>>`
    SELECT reviewed_by FROM kyc_records
    WHERE user_id = ${userId} AND status = 'approved' AND (expires_at IS NULL OR expires_at > now())`;
  return rows.length > 0 && rows.every((r) => r.reviewed_by === TRADING_CHECKS_REVIEWER);
}

/**
 * The country the check screens and checks access on: the one recorded at sign-up (the profile's region), never the one
 * typed into the check. The person confirms it; a different country is refused (`kyc.country_mismatch`) and clears
 * nothing, so a listed person cannot clear by naming another country. No recorded country refuses `kyc.country_unknown`.
 */
export function screeningCountry(recorded: string | null, submitted: string): string {
  const onRecord = countryCode(recorded ?? '');
  if (!onRecord)
    throw new TradingCheckError('We do not have the country you gave at sign-up. Ask Support to add it.', 'kyc.country_unknown');
  if (countryCode(submitted) !== onRecord)
    throw new TradingCheckError(
      'The country must be the one you gave at sign-up. To change where you live, ask Support.',
      'kyc.country_mismatch',
    );
  return onRecord;
}

export function tradingCheckKey(userId: string): string {
  return `kyc:trading-checks:${userId}`;
}

/** What /verification shows before and after the check. `country` is the one given at sign-up, to confirm. */
export interface TradingChecksView {
  readonly state: 'not_run' | 'cleared' | 'held';
  readonly country: string | null;
  readonly listSet: boolean;
}

export interface TradingChecksResult {
  readonly outcome: 'cleared' | 'held';
  readonly recordId: string;
  /** False when this answers an earlier check with the same business key. */
  readonly fresh: boolean;
}

export interface TradingChecksDeps {
  readonly key: Buffer | null;
  readonly list: SanctionsPersonList | null;
  readonly capabilities: KycCapabilityMap;
  /** The level the person holds now, read the way the token issuer reads it. */
  readonly kycTier: (userId: string, sql: Sql) => Promise<KycTier>;
  /** After a clear commits: the approval event and its XP, as an operator's approval sends them. */
  readonly announce?: (record: { userId: string; tier: KycTier; jurisdiction: string }) => Promise<void>;
  readonly now?: () => Date;
}

type Row = { outcome: 'cleared' | 'held'; record_id: string };

export class TradingChecksDesk {
  constructor(
    private readonly sql: Sql,
    private readonly deps: TradingChecksDeps,
  ) {}

  private requireKey(): Buffer {
    if (!this.deps.key) throw new TradingCheckError('The trading checks are not configured', 'kyc.trading_checks_unconfigured');
    return this.deps.key;
  }

  async read(userId: string): Promise<TradingChecksView> {
    const [row] = await this.sql<Row[]>`SELECT outcome, record_id FROM trading_checks WHERE user_id = ${userId}`;
    const [profile] = await this.sql<Array<{ region: string | null }>>`SELECT region FROM profiles WHERE user_id = ${userId}`;
    return { state: row?.outcome ?? 'not_run', country: countryCode(profile?.region ?? '') ?? null, listSet: this.deps.list !== null };
  }

  async run(userId: string, input: { legalName: string; country: string; confirmed: boolean }): Promise<TradingChecksResult> {
    const key = this.requireKey();
    const legalName = input.legalName.trim().replace(/\s+/g, ' ');
    if (legalName.length < 2 || legalName.length > 200 || !/\p{L}/u.test(legalName))
      throw new TradingCheckError('Enter your legal name as you use it.', 'kyc.legal_name_invalid');
    const submitted = countryCode(input.country);
    if (!submitted) throw new TradingCheckError('Choose the country you live in from the list.', 'kyc.country_invalid');
    if (!input.confirmed) throw new TradingCheckError('Confirm the country you live in.', 'kyc.country_unconfirmed');
    const now = this.deps.now?.() ?? new Date();

    const outcome = await transaction(this.sql, async (tx): Promise<TradingChecksResult & { jurisdiction?: string }> => {
      await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      // The same business key answers what it answered before; a held person is never screened again.
      const [prior] = await tx<Row[]>`SELECT outcome, record_id FROM trading_checks WHERE business_key = ${tradingCheckKey(userId)}`;
      if (prior) return { outcome: prior.outcome, recordId: prior.record_id, fresh: false };
      const held = await this.deps.kycTier(userId, tx);
      if (held !== 'none') throw new TradingCheckError('Your account is already verified for trading.', 'kyc.level_held');
      // A blank owner list refuses before anything is read or written.
      const list = this.deps.list;
      if (!list) throw new TradingCheckError('The trading checks are paused: no list is set.', 'kyc.screening_list_unset');
      // The screen, the region check and the record all use the country recorded at sign-up; a different one clears nothing.
      const [profile] = await tx<Array<{ region: string | null }>>`SELECT region FROM profiles WHERE user_id = ${userId}`;
      const country = screeningCountry(profile?.region ?? null, submitted);
      const decision = checkAccess({ module: 'identity', region: country, plane: 'fiat', kycTier: 'none' });
      if (!decision.allowed) {
        if (decision.code === 'denied.screening_unconfigured' || decision.code === 'denied.screening_fixture')
          throw new TradingCheckError('The trading checks are paused: no list is set.', 'kyc.screening_list_unset');
        throw new TradingCheckError('Trading is not offered for this country right now.', 'kyc.region_blocked');
      }
      const [birth] = await tx<
        Array<{ ciphertext: Buffer; nonce: Buffer }>
      >`SELECT ciphertext, nonce FROM birth_dates WHERE user_id = ${userId}`;
      if (!birth) throw new TradingCheckError('We do not have your date of birth. Ask Support to add it.', 'kyc.date_of_birth_unknown');
      const dateOfBirth = openBirthDate(key, birth);

      const result = screenPerson(list, { legalName, dateOfBirth, country }) === 'clear' ? 'cleared' : 'held';
      const [record] = await tx<Array<{ id: string; created_at: Date }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at)
        VALUES (${userId}, 'basic', ${country}, NULL, ${result === 'cleared' ? 'approved' : 'pending'},
          ${result === 'cleared' ? TRADING_CHECKS_REVIEWER : null}, ${result === 'cleared' ? now : null})
        RETURNING id, created_at`;
      const recordId = record!.id;
      const caseId = await openKycCase(tx, { id: recordId, userId, tier: 'basic', createdAt: record!.created_at });
      if (result === 'cleared') {
        await approveKycCase(
          tx,
          { id: recordId, userId, status: 'pending', createdAt: record!.created_at, reviewedAt: null },
          { by: TRADING_CHECKS_REVIEWER, at: now },
        );
        await grantOnApproval(tx, this.deps.capabilities, { userId, tier: 'basic', caseId, by: TRADING_CHECKS_REVIEWER, at: now });
      } else {
        await markRequested(tx, this.deps.capabilities, { userId, tier: 'basic', heldTier: 'none', caseId, at: now });
      }
      const name = encryptDocument(key, Buffer.from(JSON.stringify({ legalName }), 'utf8'));
      await tx`
        INSERT INTO trading_checks (user_id, business_key, outcome, country, record_id, name_ciphertext, name_nonce, created_at)
        VALUES (${userId}, ${tradingCheckKey(userId)}, ${result}, ${country}, ${recordId}, ${name.ciphertext}, ${name.nonce}, ${now})`;
      return { outcome: result, recordId, fresh: true, jurisdiction: country };
    });
    if (outcome.fresh && outcome.outcome === 'cleared' && outcome.jurisdiction)
      await this.deps.announce?.({ userId, tier: 'basic', jurisdiction: outcome.jurisdiction });
    return { outcome: outcome.outcome, recordId: outcome.recordId, fresh: outcome.fresh };
  }
}
