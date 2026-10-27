/**
 * Operator doors for risk agreements, margin terms and derivatives eligibility (D-account-07).
 *
 *   admin.agreements.get / .publish       the owner's versioned text per jurisdiction (four-eyes, append-only)
 *   admin.agreements.list / .export       the compliance view of acceptances (admin:read; the export is audited)
 *   admin.eligibilityRules.get / .set     the owner's suitability questions, pass mark and minimum verification tier
 *
 * A published version is never edited: a change is a new version, and acceptances stay linked to the version and the
 * jurisdiction text id the user saw. Every write is four-eyes (`approvalId` names a second operator's approval, bound
 * to the action, the target and the exact payload, and consumed once), idempotent on `clientRequestId`, and writes a
 * `trade.operator_audit` row. The content is the owner's: this file carries no agreement wording, no question and no
 * threshold, and a blank part refuses. No ledger posting happens here and no ledger write recipe is imported.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  consumeApproval,
  csvLine,
  decodeCursor,
  encodeCursor,
  loadRequest,
  payloadHash,
  readExportCap,
  requireClientRequestId,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  storeRequest,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';
import {
  ELIGIBILITY_TIERS,
  validateEligibilityRules,
  type EligibilityQuestion,
  type EligibilityTier,
} from '../futures/derivatives-eligibility.js';
import { agreementTextId, AGREEMENT_KINDS, isAgreementKind, type AgreementKind } from '../futures/risk-agreements.js';

export interface AgreementsAdminDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly now: () => Date;
}

export interface AgreementTextInput {
  readonly region: string;
  readonly title: string;
  readonly body: string;
}

export interface AgreementTextView {
  readonly region: string;
  readonly textId: string;
  readonly title: string;
  readonly bodySha256: string;
}

export type AgreementPublication =
  | { readonly kind: AgreementKind; readonly version: null; readonly reason: 'no_agreement_published' }
  | {
      readonly kind: AgreementKind;
      readonly version: number;
      readonly reason: null;
      readonly publishedAt: string;
      readonly operatorId: string;
      readonly approverId: string;
      readonly texts: readonly AgreementTextView[];
    };

export interface AgreementAdminView {
  readonly kind: AgreementKind;
  readonly current: (AgreementPublication & { reason: null }) | null;
  /** Full text of the current version, for the operator's review. */
  readonly currentTexts: readonly (AgreementTextView & { readonly body: string })[];
  readonly history: readonly { readonly version: number; readonly publishedAt: string; readonly regions: readonly string[] }[];
  readonly reason: 'no_agreement_published' | null;
}

export interface AcceptanceRowView {
  readonly userId: string;
  readonly kind: AgreementKind;
  readonly version: number;
  readonly region: string;
  readonly textId: string;
  readonly acceptedAt: string;
}

export interface AcceptancePage {
  readonly rows: readonly AcceptanceRowView[];
  readonly nextCursor: string | null;
}

export interface EligibilityRulesView {
  readonly version: number | null;
  readonly reason: 'trade.identity_level_unset' | null;
  readonly questions: readonly EligibilityQuestion[];
  readonly passMark: number | null;
  readonly minKycTier: EligibilityTier | null;
  readonly publishedAt: string | null;
  readonly operatorId: string | null;
  readonly approverId: string | null;
}

const REGION_PATTERN = /^[A-Z0-9_-]{1,16}$/;
const MAX_TEXTS = 64;
const MAX_BODY_CHARS = 200_000;
const MAX_QUESTIONS = 100;

function requireApprovalId(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new TradeOpsError('approval_required', 'approvalId is required: this write needs a second operator (1-128 chars)');
  }
  return trimmed;
}

function requireKind(kind: unknown): AgreementKind {
  if (!isAgreementKind(kind)) {
    throw new TradeOpsError('agreement_kind_unknown', `kind must be one of ${AGREEMENT_KINDS.join(', ')}`);
  }
  return kind;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Owner text, normalised and checked. A blank title or body is the owner leaving the jurisdiction blank: refused. */
function normalizeTexts(kind: AgreementKind, version: number, texts: readonly AgreementTextInput[]) {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_TEXTS) {
    throw new TradeOpsError('agreement_text_blank', `texts needs 1 to ${MAX_TEXTS} jurisdiction texts`);
  }
  const seen = new Set<string>();
  const out = texts.map((t) => {
    const region = (t.region ?? '').trim().toUpperCase();
    if (!REGION_PATTERN.test(region)) {
      throw new TradeOpsError('agreement_region_invalid', 'region must be 1-16 characters of A-Z, 0-9, _ or -');
    }
    if (seen.has(region)) throw new TradeOpsError('agreement_region_invalid', `region ${region} is listed twice`);
    seen.add(region);
    const title = (t.title ?? '').trim();
    const body = (t.body ?? '').trim();
    if (title === '' || body === '') {
      throw new TradeOpsError(
        'agreement_text_blank',
        `region ${region} has a blank title or body; leave the region out to keep it refused`,
      );
    }
    if (body.length > MAX_BODY_CHARS) {
      throw new TradeOpsError('agreement_text_too_long', `region ${region} body is over ${MAX_BODY_CHARS} characters`);
    }
    return { region, textId: agreementTextId(kind, version, region), title, body, bodySha256: sha256(body) };
  });
  return out.sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
}

export class AgreementsAdmin {
  constructor(private readonly deps: AgreementsAdminDeps) {}

  // ── Agreement text ─────────────────────────────────────────────────────────

  async agreementGet(principal: Principal, kindInput: unknown): Promise<AgreementAdminView> {
    requireOperator(principal);
    const kind = requireKind(kindInput);
    const versions = await this.deps.sql<{ version: number; published_at: Date; operator_id: string; approver_id: string }[]>`
      SELECT version::int AS version, published_at, operator_id, approver_id
        FROM trade.risk_agreement_versions WHERE kind = ${kind} ORDER BY version DESC`;
    const texts = await this.deps.sql<
      { version: number; region: string; text_id: string; title: string; body: string; body_sha256: string }[]
    >`
      SELECT version::int AS version, region, text_id, title, body, body_sha256
        FROM trade.risk_agreement_texts WHERE kind = ${kind} ORDER BY version DESC, region`;
    const head = versions[0];
    const history = versions.map((v) => ({
      version: v.version,
      publishedAt: v.published_at.toISOString(),
      regions: texts.filter((t) => t.version === v.version).map((t) => t.region),
    }));
    if (!head) return { kind, current: null, currentTexts: [], history, reason: 'no_agreement_published' };
    const currentRows = texts.filter((t) => t.version === head.version);
    return {
      kind,
      current: {
        kind,
        version: head.version,
        reason: null,
        publishedAt: head.published_at.toISOString(),
        operatorId: head.operator_id,
        approverId: head.approver_id,
        texts: currentRows.map((t) => ({ region: t.region, textId: t.text_id, title: t.title, bodySha256: t.body_sha256 })),
      },
      currentTexts: currentRows.map((t) => ({
        region: t.region,
        textId: t.text_id,
        title: t.title,
        bodySha256: t.body_sha256,
        body: t.body,
      })),
      history,
      reason: null,
    };
  }

  /**
   * Publish the next version of an agreement. `expectedVersion` is the version the operator last saw ('0' when
   * nothing is published): a stale value refuses `agreement_stale`. An existing version is never touched.
   */
  async agreementPublish(
    principal: Principal,
    input: {
      readonly kind: AgreementKind;
      readonly texts: readonly AgreementTextInput[];
      readonly expectedVersion: string;
      readonly reason: string;
      readonly approvalId: string;
      readonly clientRequestId: string;
    },
  ): Promise<AgreementPublication> {
    requireOperatorWrite(principal);
    const kind = requireKind(input.kind);
    const approvalId = requireApprovalId(input.approvalId);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const current = await this.currentVersion(this.deps.sql, kind);
    const next = current + 1;
    const texts = normalizeTexts(kind, next, input.texts);
    // The fingerprint names the texts without the version they will land on, so a retry after the write finds it.
    const fingerprint = payloadHash({
      kind: 'agreement_publish',
      agreement: kind,
      expectedVersion: input.expectedVersion,
      texts: texts.map((t) => ({ region: t.region, title: t.title, bodySha256: t.bodySha256 })),
    });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'agreement_publish', fingerprint);
    if (prior) return prior as AgreementPublication;
    if (input.expectedVersion !== String(current)) {
      throw new TradeOpsError('agreement_stale', `expectedVersion ${input.expectedVersion} is stale; current is ${current}`);
    }
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: 'trade.agreement_publish',
      targetId: `agreement:${kind}`,
      expectedVersion: String(current),
      payloadHash: payloadHash({
        actionType: 'trade.agreement_publish',
        kind,
        expectedVersion: String(current),
        texts: texts.map((t) => ({ region: t.region, title: t.title, bodySha256: t.bodySha256 })),
        reason,
      }),
      operationId: clientRequestId,
    });
    const at = this.deps.now();
    let result: AgreementPublication | undefined;
    try {
      await this.deps.sql.begin(async (tx) => {
        const q = tx as unknown as Sql;
        await q`INSERT INTO trade.risk_agreement_versions (kind, version, operator_id, approver_id, approval_id, reason, published_at)
          VALUES (${kind}, ${next}, ${principal.userId}, ${consumed.approverId}, ${approvalId}, ${reason}, ${at.toISOString()})`;
        for (const t of texts) {
          await q`INSERT INTO trade.risk_agreement_texts (kind, version, region, text_id, title, body, body_sha256)
            VALUES (${kind}, ${next}, ${t.region}, ${t.textId}, ${t.title}, ${t.body}, ${t.bodySha256})`;
        }
        result = {
          kind,
          version: next,
          reason: null,
          publishedAt: at.toISOString(),
          operatorId: principal.userId,
          approverId: consumed.approverId,
          texts: texts.map((t) => ({ region: t.region, textId: t.textId, title: t.title, bodySha256: t.bodySha256 })),
        };
        await storeRequest(q, clientRequestId, 'agreement_publish', fingerprint, result);
        await writeOperatorAudit(
          q,
          {
            kind: 'agreement.publish',
            operatorId: principal.userId,
            accountId: null,
            objectId: `agreement:${kind}`,
            approverId: consumed.approverId,
            reason,
            detail: { agreement: kind, version: next, regions: texts.map((t) => t.region), bodies: texts.map((t) => t.bodySha256) },
          },
          at,
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new TradeOpsError('agreement_stale', 'another operator published a newer version first');
      }
      throw error;
    }
    return result!;
  }

  private async currentVersion(sql: Sql, kind: AgreementKind): Promise<number> {
    const [row] = await sql<{ version: number | null }[]>`
      SELECT max(version)::int AS version FROM trade.risk_agreement_versions WHERE kind = ${kind}`;
    return row?.version ?? 0;
  }

  // ── Compliance view ────────────────────────────────────────────────────────

  async list(
    principal: Principal,
    input: {
      readonly kind?: AgreementKind | null;
      readonly version?: number | null;
      readonly region?: string | null;
      readonly userId?: string | null;
      readonly from?: string | null;
      readonly to?: string | null;
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<AcceptancePage> {
    requireOperator(principal);
    const { rows, nextCursor } = await this.page(input, input.limit);
    return { rows, nextCursor };
  }

  /** CSV of the same filter. Capped by `TRADE_OPERATOR_EXPORT_CAP`; a blank cap refuses. The export is audited. */
  async export(
    principal: Principal,
    input: {
      readonly kind?: AgreementKind | null;
      readonly version?: number | null;
      readonly region?: string | null;
      readonly userId?: string | null;
      readonly from?: string | null;
      readonly to?: string | null;
      readonly reason: string;
    },
  ): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
    requireOperator(principal);
    const reason = requireReason(input.reason);
    const cap = readExportCap();
    if (cap === null)
      throw new TradeOpsError('export_cap_unset', 'TRADE_OPERATOR_EXPORT_CAP is unset; the export refuses rather than guess a size');
    const { rows, nextCursor } = await this.page({ ...input, cursor: null }, cap);
    const lines = [csvLine(['userId', 'kind', 'version', 'region', 'textId', 'acceptedAt'])];
    for (const r of rows) lines.push(csvLine([r.userId, r.kind, String(r.version), r.region, r.textId, r.acceptedAt]));
    const at = this.deps.now();
    await writeOperatorAudit(
      this.deps.sql,
      {
        kind: 'agreement.export',
        operatorId: principal.userId,
        accountId: null,
        objectId: 'agreement_acceptances',
        approverId: null,
        reason,
        detail: {
          kind: input.kind ?? null,
          version: input.version ?? null,
          region: input.region ?? null,
          rows: rows.length,
          truncated: nextCursor !== null,
        },
      },
      at,
    );
    return { csv: `${lines.join('\n')}\n`, rowCount: rows.length, truncated: nextCursor !== null };
  }

  private async page(
    filter: {
      readonly kind?: AgreementKind | null;
      readonly version?: number | null;
      readonly region?: string | null;
      readonly userId?: string | null;
      readonly from?: string | null;
      readonly to?: string | null;
      readonly cursor?: string | null;
    },
    limit: number,
  ): Promise<{ rows: AcceptanceRowView[]; nextCursor: string | null }> {
    const sql = this.deps.sql;
    if (filter.kind != null) requireKind(filter.kind);
    const cursor = decodeCursor(filter.cursor);
    for (const [label, value] of [
      ['from', filter.from],
      ['to', filter.to],
    ] as const) {
      if (value != null && Number.isNaN(new Date(value).getTime()))
        throw new TradeOpsError('filter_invalid', `${label} must be an ISO instant`);
    }
    const key = sql`(user_id::text || '|' || kind || '|' || version::text)`;
    const rows = await sql<{ user_id: string; kind: AgreementKind; version: number; region: string; text_id: string; accepted_at: Date }[]>`
      SELECT user_id::text, kind, version::int AS version, region, text_id, accepted_at
        FROM trade.risk_agreement_acceptances
       WHERE true
         ${filter.kind != null ? sql`AND kind = ${filter.kind}` : sql``}
         ${filter.version != null ? sql`AND version = ${filter.version}` : sql``}
         ${filter.region != null ? sql`AND region = ${filter.region.trim().toUpperCase()}` : sql``}
         ${filter.userId != null ? sql`AND user_id = ${filter.userId}` : sql``}
         ${filter.from != null ? sql`AND accepted_at >= ${new Date(filter.from).toISOString()}` : sql``}
         ${filter.to != null ? sql`AND accepted_at < ${new Date(filter.to).toISOString()}` : sql``}
         ${cursor ? sql`AND (accepted_at, ${key}) > (${cursor.at}::timestamptz, ${cursor.id})` : sql``}
       ORDER BY accepted_at ASC, ${key} ASC
       LIMIT ${limit + 1}`;
    const more = rows.length > limit;
    const slice = more ? rows.slice(0, limit) : rows;
    const views = slice.map((r) => ({
      userId: r.user_id,
      kind: r.kind,
      version: r.version,
      region: r.region,
      textId: r.text_id,
      acceptedAt: r.accepted_at.toISOString(),
    }));
    const last = views[views.length - 1];
    return {
      rows: views,
      nextCursor: more && last ? encodeCursor(last.acceptedAt, `${last.userId}|${last.kind}|${last.version}`) : null,
    };
  }

  // ── Eligibility rules ──────────────────────────────────────────────────────

  async eligibilityRulesGet(principal: Principal): Promise<EligibilityRulesView> {
    requireOperator(principal);
    return this.readRules(this.deps.sql);
  }

  async eligibilityRulesSet(
    principal: Principal,
    input: {
      readonly questions: readonly EligibilityQuestion[];
      readonly passMark: number;
      readonly minKycTier: EligibilityTier;
      readonly expectedVersion: string;
      readonly reason: string;
      readonly approvalId: string;
      readonly clientRequestId: string;
    },
  ): Promise<EligibilityRulesView> {
    requireOperatorWrite(principal);
    const approvalId = requireApprovalId(input.approvalId);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    if (input.questions.length > MAX_QUESTIONS) {
      throw new TradeOpsError('eligibility_rules_incomplete', `at most ${MAX_QUESTIONS} questions`);
    }
    const checked = validateEligibilityRules(input);
    if (!checked.ok) throw new TradeOpsError('eligibility_rules_incomplete', checked.reason);
    if (!(ELIGIBILITY_TIERS as readonly string[]).includes(input.minKycTier)) {
      throw new TradeOpsError('eligibility_rules_incomplete', 'minKycTier is required');
    }
    const content = { questions: input.questions, passMark: input.passMark, minKycTier: input.minKycTier };
    const fingerprint = payloadHash({ kind: 'eligibility_rules_set', expectedVersion: input.expectedVersion, ...content });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'eligibility_rules_set', fingerprint);
    if (prior) return prior as EligibilityRulesView;
    const current = await this.readRules(this.deps.sql);
    const version = String(current.version ?? 0);
    if (version !== input.expectedVersion) {
      throw new TradeOpsError('eligibility_rules_stale', `expectedVersion ${input.expectedVersion} is stale; current is ${version}`);
    }
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: 'trade.derivatives_eligibility_rules_set',
      targetId: 'derivatives_eligibility_rules',
      expectedVersion: version,
      payloadHash: payloadHash({ actionType: 'trade.derivatives_eligibility_rules_set', expectedVersion: version, ...content, reason }),
      operationId: clientRequestId,
    });
    const next = Number(version) + 1;
    const at = this.deps.now();
    let result: EligibilityRulesView | undefined;
    try {
      await this.deps.sql.begin(async (tx) => {
        const q = tx as unknown as Sql;
        await q`INSERT INTO trade.derivatives_eligibility_rules (
          version, questions, pass_mark, min_kyc_tier, operator_id, approver_id, approval_id, reason, created_at
        ) VALUES (
          ${next}, ${q.json(input.questions as never)}, ${input.passMark}, ${input.minKycTier},
          ${principal.userId}, ${consumed.approverId}, ${approvalId}, ${reason}, ${at.toISOString()}
        )`;
        result = await this.readRules(q);
        await storeRequest(q, clientRequestId, 'eligibility_rules_set', fingerprint, result);
        await writeOperatorAudit(
          q,
          {
            kind: 'derivatives_eligibility_rules.set',
            operatorId: principal.userId,
            accountId: null,
            objectId: 'derivatives_eligibility_rules',
            approverId: consumed.approverId,
            reason,
            // The scoring key stays out of the audit feed: only the count, the mark, the tier and a content hash.
            detail: {
              version: next,
              questionCount: input.questions.length,
              passMark: input.passMark,
              minKycTier: input.minKycTier,
              contentSha256: payloadHash(input.questions),
            },
          },
          at,
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new TradeOpsError('eligibility_rules_stale', 'another operator published newer rules first');
      }
      throw error;
    }
    return result!;
  }

  private async readRules(sql: Sql): Promise<EligibilityRulesView> {
    const [row] = await sql<
      {
        version: number;
        questions: EligibilityQuestion[];
        pass_mark: number;
        min_kyc_tier: EligibilityTier;
        operator_id: string;
        approver_id: string;
        created_at: Date;
      }[]
    >`SELECT version::int AS version, questions, pass_mark, min_kyc_tier, operator_id, approver_id, created_at
        FROM trade.derivatives_eligibility_rules ORDER BY version DESC LIMIT 1`;
    if (!row) {
      return {
        version: null,
        reason: 'trade.identity_level_unset',
        questions: [],
        passMark: null,
        minKycTier: null,
        publishedAt: null,
        operatorId: null,
        approverId: null,
      };
    }
    return {
      version: row.version,
      reason: null,
      questions: row.questions,
      passMark: row.pass_mark,
      minKycTier: row.min_kyc_tier,
      publishedAt: row.created_at.toISOString(),
      operatorId: row.operator_id,
      approverId: row.approver_id,
    };
  }
}
