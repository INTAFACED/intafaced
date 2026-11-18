import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { z } from 'zod';
import { BankError } from '../../errors.js';
import { transaction, type Queryable } from '@intafaced/db';
import { oneLine, signReceipt } from '../../receipt-signing.js';
import { BusinessDirectoryError, type BusinessDirectoryPort } from '../../business/business-directory.js';
import type { RecipientStatePort } from '../../recipient-state.js';
import type { CardService } from '../card-service.js';
import {
  ruleDeclines,
  ruleParamsSchema,
  ruleWords,
  threeDsPolicySchema,
  type RuleParams,
  type ThreeDsResult,
  type TraceStep,
} from './rules.js';

/**
 * RUNNING THE CARD PROGRAMME (J-bank-26; BK-cops-01 to -03 and -06 to -08), for support and finance on the founder console.
 *
 * The programme, product, BIN, fee and 3DS settings, the authorisation rules (shadow, promote, roll back), the set-up
 * checklist, cardholders behind a KYC and KYB gate with screening and a review queue, the real-time decision log and one
 * authorisation's lifecycle, capture variance and trace, a signed report export, staff roles, the audit log, bulk issue,
 * reassign and the TEST card event simulator.
 *
 * Nothing here holds a balance or posts to the ledger. Card money is the card partner's (OWNER 226): the simulator drives
 * the same authorise and capture path a real issuer's message does, and a reassign moves a card, never money. Fees are
 * recorded settings: svc-bank has no fee recipe, so none is charged. Every change writes one audit row, which the
 * database refuses to edit. A staff member with the viewer role reads everything here and changes nothing.
 */

export const SETTING_KEYS = ['programme', 'product', 'bin', 'fees', 'threeds'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);
const positive = decimal.refine((v) => /[1-9]/.test(v), 'above zero');
const assetId = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const SETTING_SCHEMAS = {
  programme: z
    .object({
      type: z.enum(['consumer', 'commercial']),
      currencies: z.array(assetId).min(1).max(20),
      fulfilment: z.enum(['virtual_only', 'virtual_and_physical']),
    })
    .strict(),
  product: z
    .object({
      name: z.string().trim().min(1).max(80),
      cardType: z.enum(['virtual', 'physical']),
      assetId,
      perAuthorizationLimit: positive,
    })
    .strict(),
  bin: z
    .object({
      bin: z.string().regex(/^\d{6,8}$/),
      network: z.string().trim().min(1).max(40),
      range: z.enum(['shared', 'dedicated']),
    })
    .strict(),
  // A fee left blank (null) is not set: no fee line shows and none is charged.
  fees: z.object({ assetId, issuance: decimal.nullable(), replacement: decimal.nullable(), monthly: decimal.nullable() }).strict(),
  threeds: threeDsPolicySchema,
} as const;

/** The last 100 authorisations on simulated (TEST) cards: what a shadow rule is run over. */
export const SHADOW_SAMPLE = 100;
const LIST = 50;

export interface CardProgrammeOpsDeps {
  readonly cards: CardService;
  readonly directory: BusinessDirectoryPort;
  readonly identity: RecipientStatePort | undefined;
  /** The owner's cardholder sanctions list (`BANK_CARDHOLDER_SANCTIONS`), names separated by `|`, read at each check. */
  readonly sanctions: () => string | undefined;
  /** A dev or test stack: the only place the card event simulator runs. */
  readonly simulatorAllowed: boolean;
  /** The service secret exports are signed under; unset refuses an export. */
  readonly exportSecret: string | undefined;
  readonly clock?: () => Date;
}

const EXPORT_INFO = 'svc-bank card programme report v1';
const KYC_RANK = { none: 0, basic: 1, full: 2, institutional: 3 } as const;

/** A uuid from a business key, so issuing the same bulk row twice is the same card. */
export function uuidFromKey(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The sanctions list as folded names, or null when it is unset or blank. */
export function readCardholderSanctions(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const names = raw
    .split('|')
    .map(fold)
    .filter((n) => n !== '');
  return names.length === 0 ? null : new Set(names);
}
const fold = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

interface CardholderRow {
  id: string;
  request_key: string;
  kind: 'individual' | 'business';
  name: string;
  email: string | null;
  country: string;
  user_id: string | null;
  beneficial_owners: Array<{ name: string; email: string }>;
  status: 'verified' | 'review';
  gap: string | null;
  gap_code: string | null;
  screening: 'clear' | 'listed';
  screened_at: Date;
  test: boolean;
  created_at: Date;
}

export interface Cardholder {
  id: string;
  kind: 'individual' | 'business';
  name: string;
  email: string | null;
  country: string;
  userId: string | null;
  beneficialOwners: Array<{ name: string; email: string }>;
  status: 'verified' | 'review';
  gap: string | null;
  gapCode: string | null;
  screening: 'clear' | 'listed';
  screenedAt: string;
  test: boolean;
  createdAt: string;
}

const toCardholder = (r: CardholderRow): Cardholder => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  email: r.email,
  country: r.country,
  userId: r.user_id,
  beneficialOwners: r.beneficial_owners,
  status: r.status,
  gap: r.gap,
  gapCode: r.gap_code,
  screening: r.screening,
  screenedAt: r.screened_at.toISOString(),
  test: r.test,
  createdAt: r.created_at.toISOString(),
});

export interface CardholderInput {
  requestKey: string;
  kind: 'individual' | 'business';
  name: string;
  email?: string | undefined;
  country: string;
  beneficialOwners?: Array<{ name: string; email: string }> | undefined;
}

export interface BulkRow {
  row: number;
  cardholderId: string;
  assetId: string;
  perAuthorizationLimit: string;
  error: string | null;
}

export type SimulatorEvent =
  | {
      kind: 'authorize';
      cardId: string;
      authorizationRef: string;
      amount: string;
      channel?: 'card-present' | 'online' | 'contactless' | 'atm' | 'foreign' | undefined;
      merchantCategory?: string | undefined;
      threeDs?: ThreeDsResult | undefined;
    }
  | { kind: 'capture'; cardId: string; authorizationRef: string; amount: string }
  | { kind: 'reverse'; cardId: string; authorizationRef: string };

const SETTLEMENT_SQL_COLUMNS = 'kind, amount::text AS amount, status, partner_ref, money_book, settled_at, created_at';

export class CardProgrammeOps {
  private readonly clock: () => Date;

  constructor(
    private readonly sql: Sql,
    private readonly deps: CardProgrammeOpsDeps,
  ) {
    this.clock = deps.clock ?? (() => new Date());
  }

  private get test(): boolean {
    return this.deps.cards.programme().simulated;
  }

  // ── Staff roles and the audit log ──────────────────────────────────────────

  /** A viewer reads and changes nothing. An operator not on the staff list keeps what their session's scopes allow. */
  private async assertMayChange(actor: string, sql: Sql = this.sql): Promise<void> {
    const [row] = await sql<Array<{ role: string }>>`SELECT role FROM bank.card_programme_staff WHERE user_id = ${actor}`;
    if (row?.role === 'viewer') {
      throw new BankError(
        'Your card programme role is Viewer: you can read the programme but not change it (bank.card_programme_viewer)',
        'bank.card_programme_viewer',
      );
    }
  }

  private async audit(sql: Queryable, actor: string, action: string, target: string, before: unknown, after: unknown): Promise<void> {
    await sql`
      INSERT INTO bank.card_programme_audit (actor, action, target, before, after)
      VALUES (${actor}, ${action}, ${target}, ${before === null || before === undefined ? null : sql.json(before as never)},
              ${after === null || after === undefined ? null : sql.json(after as never)})
    `;
  }

  async assignStaff(actor: string, input: { email: string; role: 'manager' | 'viewer' }) {
    await this.assertMayChange(actor);
    const found = await this.findAccount(input.email);
    if (!found) {
      throw new BankError(
        'No active account has that email, so no role was given (bank.card_programme_invalid)',
        'bank.card_programme_invalid',
      );
    }
    if (found.userId === actor) {
      throw new BankError(
        'You cannot change your own card programme role (bank.card_programme_staff_self)',
        'bank.card_programme_staff_self',
      );
    }
    const email = input.email.trim().toLowerCase();
    await transaction(this.sql, async (tx) => {
      const [before] = await tx<
        Array<{ role: string }>
      >`SELECT role FROM bank.card_programme_staff WHERE user_id = ${found.userId} FOR UPDATE`;
      await tx`
        INSERT INTO bank.card_programme_staff (user_id, email, role, assigned_by)
        VALUES (${found.userId}, ${email}, ${input.role}, ${actor})
        ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email, assigned_by = EXCLUDED.assigned_by, assigned_at = now()
      `;
      await this.audit(tx, actor, 'staff.assign', email, before ? { role: before.role } : null, { role: input.role });
    });
    return this.staff();
  }

  async staff() {
    const rows = await this.sql<
      Array<{ user_id: string; email: string; role: 'manager' | 'viewer'; assigned_by: string; assigned_at: Date }>
    >`
      SELECT user_id, email, role, assigned_by, assigned_at FROM bank.card_programme_staff ORDER BY assigned_at DESC, user_id LIMIT ${LIST}
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      role: r.role,
      assignedBy: r.assigned_by,
      assignedAt: r.assigned_at.toISOString(),
    }));
  }

  async auditLog() {
    const rows = await this.sql<
      Array<{ id: string; actor: string; action: string; target: string; before: unknown; after: unknown; at: Date }>
    >`
      SELECT id::text AS id, actor, action, target, before, after, at FROM bank.card_programme_audit
       -- TEST simulator events are kept in the log but listed in the decision log, so they never crowd staff actions out.
       WHERE action NOT LIKE 'simulator.%'
       ORDER BY id DESC LIMIT ${LIST}
    `;
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      target: r.target,
      before: r.before === null ? null : JSON.stringify(r.before),
      after: r.after === null ? null : JSON.stringify(r.after),
      at: r.at.toISOString(),
    }));
  }

  // ── Settings and the checklist ─────────────────────────────────────────────

  async settings(): Promise<Record<SettingKey, { value: unknown; version: number; updatedBy: string; updatedAt: string } | null>> {
    const rows = await this.sql<Array<{ key: SettingKey; value: unknown; version: number; updated_by: string; updated_at: Date }>>`
      SELECT key, value, version, updated_by, updated_at FROM bank.card_programme_settings
    `;
    const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, null])) as Record<
      SettingKey,
      { value: unknown; version: number; updatedBy: string; updatedAt: string } | null
    >;
    for (const r of rows) {
      const parsed = SETTING_SCHEMAS[r.key].safeParse(r.value);
      if (parsed.success)
        out[r.key] = { value: parsed.data, version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() };
    }
    return out;
  }

  async configure(actor: string, key: SettingKey, value: unknown) {
    const parsed = SETTING_SCHEMAS[key].safeParse(value);
    if (!parsed.success) {
      throw new BankError(
        `That ${key} setting is not in shape: ${parsed.error.issues.map((i) => `${i.path.join('.') || key}: ${i.message}`).join('; ')} (bank.card_programme_invalid)`,
        'bank.card_programme_invalid',
      );
    }
    await this.assertMayChange(actor);
    await transaction(this.sql, async (tx) => {
      const [before] = await tx<Array<{ value: unknown; version: number }>>`
        SELECT value, version FROM bank.card_programme_settings WHERE key = ${key} FOR UPDATE
      `;
      await tx`
        INSERT INTO bank.card_programme_settings (key, value, version, updated_by)
        VALUES (${key}, ${tx.json(parsed.data as never)}, ${(before?.version ?? 0) + 1}, ${actor})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()
      `;
      await this.audit(tx, actor, `setting.${key}`, key, before?.value ?? null, parsed.data);
    });
    return this.settings();
  }

  /** Clears the 3DS policy: online payments are asked no challenge by this app again. */
  async clearThreeDs(actor: string) {
    await this.assertMayChange(actor);
    await transaction(this.sql, async (tx) => {
      const [before] = await tx<Array<{ value: unknown }>>`DELETE FROM bank.card_programme_settings WHERE key = 'threeds' RETURNING value`;
      if (before) await this.audit(tx, actor, 'setting.threeds.clear', 'threeds', before.value, null);
    });
    return this.settings();
  }

  /** The set-up checklist, derived from what is stored. There is no "go live" control: a live issuer is not a setting. */
  async checklist() {
    const s = await this.settings();
    const programme = this.deps.cards.programme();
    const [counts] = await this.sql<Array<{ rules: number; staff: number }>>`
      SELECT (SELECT count(*)::int FROM bank.card_programme_rules WHERE state = 'active') AS rules,
             (SELECT count(*)::int FROM bank.card_programme_staff) AS staff
    `;
    const item = (id: string, label: string, done: boolean, blocker: string | null) => ({
      id,
      label,
      done,
      blocker: done ? null : blocker,
    });
    return [
      item('programme', 'Programme: consumer or commercial, currencies, fulfilment', s.programme !== null, 'Not configured yet.'),
      item('product', 'Card product', s.product !== null, 'Not configured yet.'),
      item('bin', 'BIN and network', s.bin !== null, 'Not configured yet.'),
      item(
        'issuer',
        'Card issuer',
        !programme.simulated,
        `rail.card: the card issuer is ${programme.displayName}, a simulation (TEST). A live issuer is not connected, so no real card exists.`,
      ),
      item('rules', 'Authorisation rules', Number(counts?.rules ?? 0) > 0, 'No rule is promoted.'),
      item('fees', 'Cardholder fees', s.fees !== null, 'Not set: no fee line shows and none is charged.'),
      item('threeds', '3DS policy and SCA exemptions', s.threeds !== null, 'Not set: this app asks online payments no challenge.'),
      item('staff', 'Staff roles', Number(counts?.staff ?? 0) > 0, 'No staff role is given.'),
    ];
  }

  // ── Authorisation rules ────────────────────────────────────────────────────

  async rules() {
    const rows = await this.sql<
      Array<{
        id: string;
        rule_key: string;
        version: number;
        name: string;
        params: unknown;
        state: 'shadow' | 'active' | 'retired';
        shadow_evaluated: number;
        shadow_would_decline: number;
        shadow_at: Date;
        created_by: string;
        created_at: Date;
        promoted_at: Date | null;
        retired_at: Date | null;
      }>
    >`SELECT * FROM bank.card_programme_rules ORDER BY created_at DESC, version DESC LIMIT ${LIST}`;
    return rows.flatMap((r) => {
      const params = ruleParamsSchema.safeParse(r.params);
      if (!params.success) return [];
      return [
        {
          id: r.id,
          ruleKey: r.rule_key,
          version: r.version,
          name: r.name,
          params: params.data,
          words: ruleWords(params.data),
          state: r.state,
          shadow: { evaluated: r.shadow_evaluated, wouldDecline: r.shadow_would_decline, at: r.shadow_at.toISOString() },
          createdBy: r.created_by,
          createdAt: r.created_at.toISOString(),
          promotedAt: r.promoted_at?.toISOString() ?? null,
          retiredAt: r.retired_at?.toISOString() ?? null,
        },
      ];
    });
  }

  /** A new rule, or a new version of one, in shadow: it decides nothing, and is run over the last 100 TEST authorisations. */
  async createRule(actor: string, input: { ruleKey: string; name: string; params: RuleParams }) {
    const params = ruleParamsSchema.safeParse(input.params);
    const key = input.ruleKey.trim();
    const name = input.name.trim();
    if (!params.success || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(key) || name.length === 0 || name.length > 80) {
      throw new BankError(
        'A rule needs a key (lower-case letters, digits and dashes), a name and a kind with its value (bank.card_programme_invalid)',
        'bank.card_programme_invalid',
      );
    }
    await this.assertMayChange(actor);
    const sample = await this.sql<Array<{ asset_id: string; amount: string; channel: string; merchant_category: string | null }>>`
      SELECT k.asset_id, a.amount::text AS amount, a.channel, a.merchant_category
        FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id
       WHERE k.simulated
       ORDER BY a.decided_at DESC, a.id DESC
       LIMIT ${SHADOW_SAMPLE}
    `;
    const wouldDecline = sample.filter((a) =>
      ruleDeclines(params.data, {
        assetId: a.asset_id,
        amount: parseAmount(a.amount),
        channel: a.channel,
        merchantCategory: a.merchant_category,
      }),
    ).length;
    const id = randomUUID();
    await transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`card-rule:${key}`}))`;
      const [last] = await tx<Array<{ v: number | null }>>`SELECT max(version) AS v FROM bank.card_programme_rules WHERE rule_key = ${key}`;
      const version = (last?.v ?? 0) + 1;
      await tx`
        INSERT INTO bank.card_programme_rules (id, rule_key, version, name, kind, params, state, shadow_evaluated, shadow_would_decline, shadow_at, created_by)
        VALUES (${id}, ${key}, ${version}, ${name}, ${params.data.kind}, ${tx.json(params.data as never)}, 'shadow',
                ${sample.length}, ${wouldDecline}, ${this.clock()}, ${actor})
      `;
      await this.audit(tx, actor, 'rule.shadow', `${key} v${version}`, null, {
        name,
        params: params.data,
        evaluated: sample.length,
        wouldDecline,
      });
    });
    return (await this.rules()).find((r) => r.id === id)!;
  }

  /** The shadow version decides new authorisations from now; the version it replaces retires. Past decisions stay as they were. */
  async promoteRule(actor: string, ruleId: string) {
    await this.assertMayChange(actor);
    await transaction(this.sql, async (tx) => {
      const [rule] = await tx<Array<{ rule_key: string; version: number; state: string }>>`
        SELECT rule_key, version, state FROM bank.card_programme_rules WHERE id = ${ruleId} FOR UPDATE
      `;
      if (!rule) throw new BankError('No such card programme rule (bank.card_rule_not_found)', 'bank.card_rule_not_found');
      if (rule.state !== 'shadow')
        throw new BankError('Only a rule in shadow can be promoted (bank.card_rule_state)', 'bank.card_rule_state');
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`card-rule:${rule.rule_key}`}))`;
      const retired = await tx<Array<{ version: number }>>`
        UPDATE bank.card_programme_rules SET state = 'retired', retired_at = now()
         WHERE rule_key = ${rule.rule_key} AND state = 'active' RETURNING version
      `;
      await tx`UPDATE bank.card_programme_rules SET state = 'active', promoted_at = now(), retired_at = NULL WHERE id = ${ruleId}`;
      await this.audit(tx, actor, 'rule.promote', `${rule.rule_key} v${rule.version}`, retired[0] ? { active: retired[0].version } : null, {
        active: rule.version,
      });
    });
    return this.rules();
  }

  /** The promoted version retires and the version promoted before it decides again, or none does. */
  async rollbackRule(actor: string, ruleKey: string) {
    await this.assertMayChange(actor);
    await transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`card-rule:${ruleKey}`}))`;
      const [active] = await tx<Array<{ id: string; version: number }>>`
        SELECT id, version FROM bank.card_programme_rules WHERE rule_key = ${ruleKey} AND state = 'active' FOR UPDATE
      `;
      if (!active) throw new BankError('This rule has no promoted version to roll back (bank.card_rule_state)', 'bank.card_rule_state');
      await tx`UPDATE bank.card_programme_rules SET state = 'retired', retired_at = now() WHERE id = ${active.id}`;
      const [previous] = await tx<Array<{ id: string; version: number }>>`
        SELECT id, version FROM bank.card_programme_rules
         WHERE rule_key = ${ruleKey} AND version < ${active.version} AND promoted_at IS NOT NULL
         ORDER BY version DESC LIMIT 1
      `;
      if (previous)
        await tx`UPDATE bank.card_programme_rules SET state = 'active', promoted_at = now(), retired_at = NULL WHERE id = ${previous.id}`;
      await this.audit(tx, actor, 'rule.rollback', ruleKey, { active: active.version }, { active: previous?.version ?? null });
    });
    return this.rules();
  }

  // ── Cardholders ────────────────────────────────────────────────────────────

  private async findAccount(email: string): Promise<{ userId: string } | null> {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
    try {
      return await this.deps.directory.findActive({ email: e });
    } catch (err) {
      if (err instanceof BusinessDirectoryError && err.reason === 'unset')
        throw new BankError(err.message, 'bank.business_directory_unset');
      throw new BankError('svc-identity did not answer the account lookup. Nothing was changed.', 'bank.business_directory_unavailable');
    }
  }

  /** Whether one email is an active account at the full verification level; the gap in words when it is not. */
  private async verifiedPerson(email: string): Promise<{ userId: string | null; gap: string | null }> {
    const found = await this.findAccount(email);
    if (!found) return { userId: null, gap: `No active account has the email ${email}.` };
    const identity = this.deps.identity;
    if (!identity?.accountOf) return { userId: found.userId, gap: 'svc-identity cannot be asked for the verification level here.' };
    let state: Awaited<ReturnType<NonNullable<RecipientStatePort['accountOf']>>>;
    try {
      state = await identity.accountOf(found.userId);
    } catch {
      throw new BankError(
        'svc-identity did not answer the verification check. Nothing was changed.',
        'bank.business_directory_unavailable',
      );
    }
    if (state === 'not_found' || state.status !== 'active') return { userId: found.userId, gap: `The account for ${email} is not active.` };
    if (KYC_RANK[state.kycTier] < KYC_RANK.full) {
      return { userId: found.userId, gap: `The account for ${email} is verified to “${state.kycTier}”, below the full level cards need.` };
    }
    return { userId: found.userId, gap: null };
  }

  /**
   * Create a cardholder behind the KYC and KYB gate, after screening. Every name is screened first; an unset list
   * refuses and stores nothing. A cardholder whose gate fails or whose name matches is stored in review with the gap
   * named, and the create refuses with its code. The same request key returns the first answer.
   */
  async createCardholder(actor: string, input: CardholderInput): Promise<Cardholder> {
    const key = input.requestKey.trim();
    const name = input.name.trim();
    const country = input.country.trim().toUpperCase();
    const owners = (input.beneficialOwners ?? []).map((o) => ({ name: o.name.trim(), email: o.email.trim().toLowerCase() }));
    const email = input.kind === 'individual' ? (input.email ?? '').trim().toLowerCase() : null;
    if (
      key.length < 8 ||
      key.length > 128 ||
      name.length === 0 ||
      name.length > 120 ||
      !/^[A-Z]{2}$/.test(country) ||
      (input.kind === 'individual' && !email) ||
      (input.kind === 'individual' && owners.length > 0) ||
      owners.length > 10 ||
      owners.some((o) => o.name === '' || o.email === '')
    ) {
      throw new BankError(
        'A cardholder needs a request key, a name and a two-letter country; a person an email, a business its beneficial owners (bank.card_programme_invalid)',
        'bank.card_programme_invalid',
      );
    }
    const prior = await this.cardholderByKey(key);
    if (prior) return this.replay(prior, { kind: input.kind, name, email, country, owners });
    await this.assertMayChange(actor);

    const list = readCardholderSanctions(this.deps.sanctions());
    if (list === null) {
      throw new BankError(
        'The cardholder sanctions list is not set, so no cardholder can be screened or created. Nothing was saved (bank.cardholder_screening_unset)',
        'bank.cardholder_screening_unset',
      );
    }
    const listed = [name, ...owners.map((o) => o.name)].find((n) => list.has(fold(n))) ?? null;

    let userId: string | null = null;
    let gap: string | null = null;
    if (input.kind === 'individual') {
      const person = await this.verifiedPerson(email!);
      userId = person.userId;
      gap = person.gap;
    } else if (owners.length === 0) {
      gap = 'No beneficial owner on file: a business cardholder needs at least one verified beneficial owner (KYB).';
    } else {
      for (const o of owners) {
        const person = await this.verifiedPerson(o.email);
        if (person.gap) {
          gap = `Beneficial owner ${o.name}: ${person.gap}`;
          break;
        }
      }
    }
    const gapCode = listed ? 'bank.cardholder_under_review' : gap ? 'bank.cardholder_unverified' : null;
    const gapWords = listed ? `Screening match: ${listed} is on the sanctions list.` : gap;
    const id = randomUUID();
    await transaction(this.sql, async (tx) => {
      const inserted = await tx`
        INSERT INTO bank.card_cardholders (id, request_key, kind, name, email, country, user_id, beneficial_owners, status, gap, gap_code, screening, screened_at, test, created_by)
        VALUES (${id}, ${key}, ${input.kind}, ${name}, ${email}, ${country}, ${userId}, ${tx.json(owners as never)},
                ${gapCode ? 'review' : 'verified'}, ${gapWords}, ${gapCode}, ${listed ? 'listed' : 'clear'}, ${this.clock()}, ${this.test}, ${actor})
        ON CONFLICT (request_key) DO NOTHING RETURNING id
      `;
      if (inserted.length > 0) {
        await this.audit(tx, actor, 'cardholder.create', name, null, {
          kind: input.kind,
          status: gapCode ? 'review' : 'verified',
          gap: gapWords,
        });
      }
    });
    const stored = (await this.cardholderByKey(key))!;
    return this.replay(stored, { kind: input.kind, name, email, country, owners });
  }

  private replay(
    row: CardholderRow,
    asked: { kind: string; name: string; email: string | null; country: string; owners: Array<{ name: string; email: string }> },
  ): Cardholder {
    if (
      row.kind !== asked.kind ||
      row.name !== asked.name ||
      row.email !== asked.email ||
      row.country !== asked.country ||
      JSON.stringify(row.beneficial_owners) !== JSON.stringify(asked.owners)
    ) {
      throw new BankError('That request key was used for a different cardholder (bank.cardholder_conflict)', 'bank.cardholder_conflict');
    }
    if (row.status === 'review') {
      const code = row.gap_code === 'bank.cardholder_under_review' ? 'bank.cardholder_under_review' : 'bank.cardholder_unverified';
      throw new BankError(`${row.gap} The cardholder is in the review queue (${code})`, code);
    }
    return toCardholder(row);
  }

  private async cardholderByKey(key: string): Promise<CardholderRow | null> {
    const [r] = await this.sql<CardholderRow[]>`SELECT * FROM bank.card_cardholders WHERE request_key = ${key}`;
    return r ?? null;
  }

  private async cardholderRow(id: string): Promise<CardholderRow> {
    const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const [r] = ok ? await this.sql<CardholderRow[]>`SELECT * FROM bank.card_cardholders WHERE id = ${id}` : [];
    if (!r) throw new BankError('No such cardholder (bank.cardholder_not_found)', 'bank.cardholder_not_found');
    return r;
  }

  /** The directory: by name, email or a card's last four digits; empty lists the newest. */
  async cardholders(query?: string) {
    const q = (query ?? '').trim();
    const rows =
      q === ''
        ? await this.sql<CardholderRow[]>`SELECT * FROM bank.card_cardholders ORDER BY created_at DESC LIMIT ${LIST}`
        : await this.sql<CardholderRow[]>`
            SELECT h.* FROM bank.card_cardholders h
             WHERE h.name ILIKE ${`%${likeSafe(q)}%`} OR h.email ILIKE ${`%${likeSafe(q)}%`}
                OR (h.user_id IS NOT NULL AND EXISTS (
                      SELECT 1 FROM bank.cards k WHERE k.user_id = h.user_id AND k.pan_tail LIKE ${`%${likeSafe(q)}%`}))
             ORDER BY h.created_at DESC LIMIT ${LIST}
          `;
    return Promise.all(rows.map(async (r) => ({ ...toCardholder(r), cards: await this.cardsOf(r.user_id) })));
  }

  async reviewQueue() {
    const rows = await this.sql<
      CardholderRow[]
    >`SELECT * FROM bank.card_cardholders WHERE status = 'review' ORDER BY created_at DESC LIMIT ${LIST}`;
    return rows.map(toCardholder);
  }

  private async cardsOf(userId: string | null) {
    if (userId === null) return [];
    const rows = await this.sql<Array<{ id: string; pan_tail: string; status: string; asset_id: string; simulated: boolean }>>`
      SELECT id, pan_tail, status, asset_id, simulated FROM bank.cards WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${LIST}
    `;
    return rows.map((c) => ({ id: c.id, panTail: c.pan_tail, status: c.status, assetId: c.asset_id, test: c.simulated }));
  }

  /** One cardholder with their cards and their card funds beside the partner's own figures (J-bank-26 #5). */
  async cardholder(id: string) {
    const r = await this.cardholderRow(id);
    const funds = r.user_id === null ? [] : await this.deps.cards.cardholderFunds(r.user_id);
    return {
      ...toCardholder(r),
      cards: await this.cardsOf(r.user_id),
      funds: funds.map((f) => {
        const appFigure = f.appHeld + f.appCaptured;
        const partnerFigure = f.partnerHeld === null || f.partnerCaptured === null ? null : f.partnerHeld + f.partnerCaptured;
        const difference = partnerFigure === null ? null : partnerFigure - appFigure;
        return {
          assetId: f.assetId,
          appHeld: formatAmount(f.appHeld),
          appCaptured: formatAmount(f.appCaptured),
          appFigure: formatAmount(appFigure),
          partnerHeld: f.partnerHeld === null ? null : formatAmount(f.partnerHeld),
          partnerCaptured: f.partnerCaptured === null ? null : formatAmount(f.partnerCaptured),
          partnerFigure: partnerFigure === null ? null : formatAmount(partnerFigure),
          difference: difference === null ? null : formatSigned(difference),
          status: difference === null ? ('not_known' as const) : difference === 0n ? ('matches' as const) : ('break' as const),
          test: f.test,
        };
      }),
    };
  }

  private async verifiedHolder(id: string): Promise<CardholderRow & { user_id: string }> {
    const r = await this.cardholderRow(id);
    if (r.status === 'review') {
      throw new BankError(`${r.name} is in the review queue: ${r.gap} (bank.cardholder_under_review)`, 'bank.cardholder_under_review');
    }
    if (r.kind !== 'individual' || r.user_id === null) {
      throw new BankError(
        `${r.name} is a business: its cards are held by its people, each a cardholder of their own (bank.cardholder_unverified)`,
        'bank.cardholder_unverified',
      );
    }
    return r as CardholderRow & { user_id: string };
  }

  // ── Decision log, authorisation detail and the report ──────────────────────

  async decisionLog() {
    const rows = await this.sql<
      Array<{
        id: string;
        card_id: string;
        pan_tail: string;
        asset_id: string;
        amount: string;
        channel: string;
        merchant_category: string | null;
        decision: 'approved' | 'declined';
        decline_code: string | null;
        status: string;
        decided_at: Date;
        simulated: boolean;
      }>
    >`
      SELECT a.id, a.card_id, k.pan_tail, k.asset_id, a.amount::text AS amount, a.channel, a.merchant_category, a.decision, a.decline_code,
             a.status, a.decided_at, k.simulated
        FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id
       ORDER BY a.decided_at DESC, a.id DESC LIMIT ${LIST}
    `;
    return rows.map((r) => ({
      id: r.id,
      cardId: r.card_id,
      panTail: r.pan_tail,
      assetId: r.asset_id,
      amount: formatAmount(parseAmount(r.amount)),
      channel: r.channel,
      merchantCategory: r.merchant_category,
      decision: r.decision,
      declineCode: r.decline_code,
      status: r.status,
      decidedAt: r.decided_at.toISOString(),
      test: r.simulated,
    }));
  }

  /** One authorisation: its lifecycle, capture variance and the trace of why it was decided. */
  async authorization(id: string) {
    const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const [a] = ok
      ? await this.sql<
          Array<{
            id: string;
            card_id: string;
            authorization_ref: string;
            pan_tail: string;
            asset_id: string;
            amount: string;
            channel: string;
            merchant_category: string | null;
            decision: 'approved' | 'declined';
            decline_code: string | null;
            status: string;
            money_book: string;
            partner_hold_ref: string | null;
            decided_at: Date;
            simulated: boolean;
          }>
        >`
          SELECT a.id, a.card_id, a.authorization_ref, k.pan_tail, k.asset_id, a.amount::text AS amount, a.channel, a.merchant_category,
                 a.decision, a.decline_code, a.status, a.money_book, a.partner_hold_ref, a.decided_at, k.simulated
            FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id WHERE a.id = ${id}
        `
      : [];
    if (!a) throw new BankError('No such card authorisation (bank.ops_authorization_not_found)', 'bank.ops_authorization_not_found');
    const settlements = await this.sql.unsafe<
      Array<{
        kind: 'capture' | 'reversal';
        amount: string;
        status: string;
        partner_ref: string | null;
        money_book: string;
        settled_at: Date | null;
        created_at: Date;
      }>
    >(`SELECT ${SETTLEMENT_SQL_COLUMNS} FROM bank.card_settlements WHERE authorization_id = $1 ORDER BY sequence`, [a.id]);
    const [trace] = await this.sql<
      Array<{ steps: TraceStep[] }>
    >`SELECT steps FROM bank.card_authorization_traces WHERE authorization_id = ${a.id}`;
    const authorised = parseAmount(a.amount);
    const done = settlements.filter((s) => s.status === 'settled');
    const captured = done.filter((s) => s.kind === 'capture').reduce((t, s) => t + parseAmount(s.amount), 0n);
    const returned = done.filter((s) => s.kind === 'reversal').reduce((t, s) => t + parseAmount(s.amount), 0n);
    const open = a.decision === 'approved' && a.status === 'settled' ? authorised - captured - returned : 0n;
    const lifecycle = [
      {
        event: a.decision === 'approved' ? 'authorised' : 'declined',
        amount: formatAmount(authorised),
        at: a.decided_at.toISOString(),
        detail: a.decline_code,
      },
      ...settlements.map((s) => ({
        event:
          s.kind === 'capture'
            ? 'captured'
            : s.partner_ref?.endsWith(':expired')
              ? 'expired: given back by the partner when its hold time ran out'
              : 'given back',
        amount: formatAmount(parseAmount(s.amount)),
        at: (s.settled_at ?? s.created_at).toISOString(),
        detail: s.status === 'settled' ? s.partner_ref : `${s.status}${s.partner_ref ? `, ${s.partner_ref}` : ''}`,
      })),
    ];
    return {
      id: a.id,
      cardId: a.card_id,
      authorizationRef: a.authorization_ref,
      panTail: a.pan_tail,
      assetId: a.asset_id,
      amount: formatAmount(authorised),
      channel: a.channel,
      merchantCategory: a.merchant_category,
      decision: a.decision,
      declineCode: a.decline_code,
      heldBy: a.money_book,
      partnerHoldRef: a.partner_hold_ref,
      test: a.simulated,
      lifecycle,
      variance:
        a.decision === 'approved'
          ? {
              authorised: formatAmount(authorised),
              captured: formatAmount(captured),
              returned: formatAmount(returned),
              stillHeld: formatAmount(open),
              captureVariance: formatSigned(captured - authorised),
            }
          : null,
      trace: trace?.steps ?? null,
    };
  }

  /** Authorisations decided today (UTC) per asset: what the screen shows and what the export signs. */
  async report() {
    const now = this.clock();
    const day = now.toISOString().slice(0, 10);
    const rows = await this.sql<Array<{ asset_id: string; approved: number; volume: string; declined: number }>>`
      SELECT k.asset_id,
             count(*) FILTER (WHERE a.decision = 'approved')::int AS approved,
             COALESCE(SUM(a.amount) FILTER (WHERE a.decision = 'approved'), 0)::text AS volume,
             count(*) FILTER (WHERE a.decision = 'declined')::int AS declined
        FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id
       WHERE a.decided_at >= ${new Date(`${day}T00:00:00.000Z`)}
       GROUP BY k.asset_id ORDER BY k.asset_id
    `;
    const assets = rows.map((r) => ({
      assetId: r.asset_id,
      approved: r.approved,
      approvedVolume: formatAmount(parseAmount(r.volume)),
      declined: r.declined,
    }));
    return {
      day,
      asOf: now.toISOString(),
      test: this.test,
      assets,
      totals: { approved: assets.reduce((t, a) => t + a.approved, 0), declined: assets.reduce((t, a) => t + a.declined, 0) },
    };
  }

  /** The report as a signed file: its text, its freshness time, the SHA-256 of the text and its signature. */
  async exportReport(actor: string) {
    const secret = this.deps.exportSecret;
    if (!secret)
      throw new BankError(
        'svc-bank has no signing secret, so no export can be signed (bank.card_report_signing_unset)',
        'bank.card_report_signing_unset',
      );
    const r = await this.report();
    const text = [
      `INTAFACED card programme report${r.test ? ' (TEST: simulated card programme)' : ''}`,
      `Authorisations decided on ${r.day} (UTC)`,
      `As of (UTC): ${r.asOf}`,
      'asset,approved,approved_volume,declined',
      ...r.assets.map((a) => `${oneLine(a.assetId)},${a.approved},${a.approvedVolume},${a.declined}`),
      `total,${r.totals.approved},,${r.totals.declined}`,
      '',
    ].join('\n');
    await this.audit(this.sql, actor, 'report.export', `authorisations ${r.day}`, null, { asOf: r.asOf, totals: r.totals });
    return { fileName: `card-programme-${r.day}.csv`, asOf: r.asOf, text, ...signReceipt(text, secret, EXPORT_INFO) };
  }

  // ── Bulk issue, reassign, the simulator ────────────────────────────────────

  /** Each row of a bulk file checked: `cardholder_id,asset,per_authorisation_limit`, one card per row. */
  async validateBulk(text: string): Promise<{ batchId: string; rows: BulkRow[]; ok: boolean }> {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '');
    const body = lines[0]?.toLowerCase().startsWith('cardholder') ? lines.slice(1) : lines;
    if (body.length === 0 || body.length > 500) {
      throw new BankError('A bulk card file has 1 to 500 rows (bank.card_bulk_invalid)', 'bank.card_bulk_invalid');
    }
    const rows: BulkRow[] = [];
    for (const [i, line] of body.entries()) {
      const [cardholderId = '', asset = '', limit = '', ...extra] = line.split(',').map((c) => c.trim());
      const row: BulkRow = { row: i + 1, cardholderId, assetId: asset.toUpperCase(), perAuthorizationLimit: limit, error: null };
      if (extra.length > 0) row.error = 'Too many columns: a row is cardholder id, asset, per-authorisation limit.';
      else if (!/^\d+(\.\d{1,18})?$/.test(limit) || !/[1-9]/.test(limit))
        row.error = `The per-authorisation limit “${limit}” is not a positive amount.`;
      else if (!/^[A-Z0-9]{2,16}$/.test(row.assetId)) row.error = `“${asset}” is not an asset.`;
      else {
        try {
          await this.verifiedHolder(cardholderId);
        } catch (err) {
          row.error = err instanceof BankError ? err.message : 'The cardholder could not be read.';
        }
      }
      rows.push(row);
    }
    const canonical = rows.map((r) => `${r.cardholderId.toLowerCase()},${r.assetId},${r.perAuthorizationLimit}`).join('\n');
    return { batchId: createHash('sha256').update(canonical).digest('hex'), rows, ok: rows.every((r) => r.error === null) };
  }

  /**
   * Issue a bulk file: nothing issues while any row is bad. Each row's card id comes from the file's hash and the row, so
   * issuing the same file again returns the same cards, never more.
   */
  async issueBulk(actor: string, text: string) {
    const checked = await this.validateBulk(text);
    if (!checked.ok) {
      const bad = checked.rows.filter((r) => r.error);
      throw new BankError(
        `Nothing was issued: ${bad.map((r) => `row ${r.row}: ${r.error}`).join(' ')} (bank.card_bulk_invalid)`,
        'bank.card_bulk_invalid',
      );
    }
    await this.assertMayChange(actor);
    await this.sql`
      INSERT INTO bank.card_bulk_batches (id, rows, created_by) VALUES (${checked.batchId}, ${checked.rows.length}, ${actor})
      ON CONFLICT (id) DO NOTHING
    `;
    const issued: Array<{ row: number; cardId: string; panTail: string; cardholderId: string }> = [];
    for (const r of checked.rows) {
      const holder = await this.verifiedHolder(r.cardholderId);
      const cardId = uuidFromKey(`card-bulk:${checked.batchId}:${r.row}`);
      const card = await this.deps.cards.issue({
        cardId,
        userId: holder.user_id,
        assetId: r.assetId,
        perAuthorizationLimit: parseAmount(r.perAuthorizationLimit),
      });
      await this.sql`
        INSERT INTO bank.card_bulk_cards (batch_id, row_no, cardholder_id, card_id) VALUES (${checked.batchId}, ${r.row}, ${holder.id}, ${card.id})
        ON CONFLICT (batch_id, row_no) DO NOTHING
      `;
      issued.push({ row: r.row, cardId: card.id, panTail: card.panTail, cardholderId: holder.id });
    }
    await this.audit(this.sql, actor, 'cards.bulk_issue', checked.batchId, null, { rows: issued.length });
    const [count] = await this.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM bank.card_bulk_cards WHERE batch_id = ${checked.batchId}`;
    return { batchId: checked.batchId, cards: issued, cardsInBatch: Number(count?.n ?? 0), test: this.test };
  }

  async reassign(actor: string, input: { cardId: string; toCardholderId: string }) {
    const holder = await this.verifiedHolder(input.toCardholderId);
    await this.assertMayChange(actor);
    const moved = await transaction(this.sql, async (tx) => {
      const { fromUserId, card } = await this.deps.cards.reassignOwner(tx, input.cardId, holder.user_id);
      await tx`
        INSERT INTO bank.card_reassignments (id, card_id, from_user_id, to_cardholder_id, actor)
        VALUES (${randomUUID()}, ${card.id}, ${fromUserId}, ${holder.id}, ${actor})
      `;
      await this.audit(
        tx,
        actor,
        'card.reassign',
        `card ${card.panTail}`,
        { userId: fromUserId },
        { cardholder: holder.name, userId: holder.user_id },
      );
      return card;
    });
    return { cardId: moved.id, panTail: moved.panTail, cardholderId: holder.id };
  }

  /**
   * The card event simulator (TEST): one authorisation, capture or reversal on a simulated card, through the same path a
   * real issuer's message takes. Refused outside a dev or test stack and on a card that is not simulated.
   */
  async simulate(actor: string, event: SimulatorEvent) {
    const card = await this.deps.cards.card(event.cardId);
    if (!this.deps.simulatorAllowed || !card.simulated) {
      throw new BankError(
        'The card event simulator runs only on a dev or test stack, on a simulated card (bank.card_sim_not_live)',
        'bank.card_sim_not_live',
      );
    }
    await this.assertMayChange(actor);
    let answer: Record<string, unknown>;
    if (event.kind === 'authorize') {
      const a = await this.deps.cards.authorize({
        cardId: card.id,
        authorizationRef: event.authorizationRef,
        amount: parseAmount(event.amount),
        ...(event.channel ? { channel: event.channel } : {}),
        ...(event.merchantCategory ? { merchantCategory: event.merchantCategory } : {}),
        ...(event.threeDs ? { threeDs: event.threeDs } : {}),
      });
      answer = { authorizationId: a.id, decision: a.decision, declineCode: a.declineCode };
    } else if (event.kind === 'capture') {
      const c = await this.deps.cards.capture({
        cardId: card.id,
        authorizationRef: event.authorizationRef,
        amount: parseAmount(event.amount),
      });
      answer = { captured: formatAmount(c.captured), returned: formatAmount(c.returned) };
    } else {
      const r = await this.deps.cards.reverse({ cardId: card.id, authorizationRef: event.authorizationRef });
      answer = { returned: formatAmount(r.returned) };
    }
    await this.audit(this.sql, actor, `simulator.${event.kind}`, `card ${card.panTail} ${event.authorizationRef}`, null, answer);
    return { test: true as const, kind: event.kind, ...answer };
  }

  /** How many authorisations the SCA low-value exemption let through without a challenge. */
  async exemptionCount(): Promise<number> {
    const [row] = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bank.card_authorization_traces t
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.steps) s WHERE s->>'detail' LIKE 'SCA low-value exemption:%')
    `;
    return Number(row?.n ?? 0);
  }

  /** Everything the card programme desk shows on its first paint. */
  async desk() {
    const programme = this.deps.cards.programme();
    const [settings, checklist, rules, staff, audit, reviewQueue, cardholders, decisionLog, report, exemptions] = await Promise.all([
      this.settings(),
      this.checklist(),
      this.rules(),
      this.staff(),
      this.auditLog(),
      this.reviewQueue(),
      this.cardholders(),
      this.decisionLog(),
      this.report(),
      this.exemptionCount(),
    ]);
    return {
      test: programme.simulated,
      programme: { id: programme.id, displayName: programme.displayName, simulated: programme.simulated },
      settings,
      checklist,
      rules,
      staff,
      audit,
      reviewQueue,
      cardholders,
      decisionLog,
      report,
      exemptions,
      simulator: this.deps.simulatorAllowed && programme.simulated,
      screeningListSet: readCardholderSanctions(this.deps.sanctions()) !== null,
    };
  }
}

function likeSafe(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function formatSigned(v: Amount): string {
  return v < 0n ? `-${formatAmount(-v)}` : formatAmount(v);
}
