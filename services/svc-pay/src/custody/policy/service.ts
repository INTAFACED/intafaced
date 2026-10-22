import { transaction } from '@intafaced/db';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { WITHDRAWAL_STATES_NOT_COUNTED } from '../../limits/allowance.js';
import { evaluatePolicy, validateRules, type PolicyProblem, type PolicyTx, type UsedInWindow } from './engine.js';
import { CustodyPolicyError } from './errors.js';
import type { PolicyDecisionView, PolicyDraftInput, PolicyRule, PolicySimulateInput, PolicyVersionView } from './schemas.js';

interface Row {
  version: number;
  status: 'draft' | 'published' | 'superseded';
  rules: PolicyRule[];
  note: string;
  edited_by: string;
  edited_at: Date;
  published_by: string | null;
  published_at: Date | null;
}

const LOCK = 'pay.custody_policy';

function view(r: Row): PolicyVersionView {
  return {
    version: r.version,
    status: r.status,
    rules: r.rules,
    note: r.note,
    editedBy: r.edited_by,
    editedAt: r.edited_at.toISOString(),
    publishedBy: r.published_by,
    publishedAt: r.published_at?.toISOString() ?? null,
  };
}

/** The published rules in force, read on the caller's connection (the withdrawal claim's own transaction). */
export async function loadPublishedPolicy(q: Sql): Promise<{ version: number; rules: PolicyRule[] } | null> {
  const rows = await q<Row[]>`SELECT version, rules FROM pay.custody_policy_versions WHERE status = 'published'`;
  const row = rows[0];
  return row ? { version: row.version, rules: row.rules } : null;
}

/**
 * What a customer has moved of one asset in the last `windowSeconds`, for cumulative rules. Same deny-list as the
 * D-148 allowance (limits/allowance.ts): every withdrawal that can still move value counts, including pending and held
 * ones; the claim being retried is excluded.
 */
export function withdrawalsUsedInWindow(q: Sql, exceptClientRef = ''): UsedInWindow {
  return async ({ initiator, assetId, windowSeconds }): Promise<Amount> => {
    const rows = await q<Array<{ used: string }>>`
      SELECT COALESCE(SUM(amount), 0)::text AS used
        FROM pay.withdrawals
       WHERE user_id = ${initiator} AND asset_id = ${assetId}
         AND status::text NOT IN ${q([...WITHDRAWAL_STATES_NOT_COUNTED])}
         AND updated_at > now() - make_interval(secs => ${windowSeconds})
         AND client_ref <> ${exceptClientRef}
    `;
    return parseAmount(rows[0]?.used ?? '0');
  };
}

/**
 * Custody transaction policy (W-custody-ops-07): draft, validate, publish (four eyes), list and simulate.
 *
 * One open draft at a time; a published version is immutable (database trigger), so a change is a new draft and a
 * new version. The founder who publishes must not be the one who last edited the draft. Publishing a version that is
 * already published returns it unchanged. Simulate reads only.
 */
export class CustodyPolicyService {
  constructor(private readonly deps: { readonly sql: Sql }) {}

  validate(rules: readonly PolicyRule[]): { valid: boolean; problems: PolicyProblem[] } {
    const problems = validateRules(rules);
    return { valid: problems.length === 0, problems };
  }

  async list(limit: number): Promise<PolicyVersionView[]> {
    const rows = await this.deps.sql<Row[]>`SELECT * FROM pay.custody_policy_versions ORDER BY version DESC LIMIT ${limit}`;
    return rows.map(view);
  }

  async current(): Promise<PolicyVersionView> {
    const rows = await this.deps.sql<Row[]>`SELECT * FROM pay.custody_policy_versions WHERE status = 'published'`;
    if (!rows[0])
      throw new CustodyPolicyError('custody_policy.unset', 'no custody policy is published; every withdrawal it guards refuses');
    return view(rows[0]);
  }

  async saveDraft(actor: string, input: PolicyDraftInput): Promise<PolicyVersionView> {
    const problems = validateRules(input.rules);
    if (problems.length > 0) throw new CustodyPolicyError('custody_policy.draft_invalid', 'the draft has invalid rules', problems);
    return transaction(this.deps.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const [draft] = await tx<Row[]>`SELECT * FROM pay.custody_policy_versions WHERE status = 'draft'`;
      if ((draft?.version ?? null) !== input.expectedDraftVersion) {
        throw new CustodyPolicyError(
          'custody_policy.draft_differs',
          `the open draft is ${draft ? `version ${draft.version}` : 'none'}, not ${input.expectedDraftVersion ?? 'none'}`,
        );
      }
      const rules = tx.json(input.rules as never);
      const rows = draft
        ? await tx<
            Row[]
          >`UPDATE pay.custody_policy_versions SET rules = ${rules}, note = ${input.note}, edited_by = ${actor}, edited_at = now()
                           WHERE version = ${draft.version} RETURNING *`
        : await tx<Row[]>`INSERT INTO pay.custody_policy_versions (version, rules, status, edited_by, note)
                           SELECT COALESCE(MAX(version), 0) + 1, ${rules}, 'draft', ${actor}, ${input.note} FROM pay.custody_policy_versions
                           RETURNING *`;
      return view(rows[0]!);
    });
  }

  async publish(actor: string, version: number): Promise<PolicyVersionView> {
    return transaction(this.deps.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
      const [row] = await tx<Row[]>`SELECT * FROM pay.custody_policy_versions WHERE version = ${version}`;
      if (!row) throw new CustodyPolicyError('custody_policy.version_not_found', `no policy version ${version}`);
      if (row.status !== 'draft') return view(row);
      if (row.edited_by === actor) {
        throw new CustodyPolicyError('custody_policy.same_founder', 'a second founder must publish a draft; you edited it last');
      }
      const problems = validateRules(row.rules);
      if (problems.length > 0) throw new CustodyPolicyError('custody_policy.draft_invalid', 'the draft has invalid rules', problems);
      await tx`UPDATE pay.custody_policy_versions SET status = 'superseded' WHERE status = 'published'`;
      const [done] = await tx<
        Row[]
      >`UPDATE pay.custody_policy_versions SET status = 'published', published_by = ${actor}, published_at = now()
                                     WHERE version = ${version} RETURNING *`;
      return view(done!);
    });
  }

  /** How a version (default: the published one) would decide a transaction. Writes nothing. */
  async simulate(input: PolicySimulateInput): Promise<PolicyDecisionView> {
    const rows =
      input.version === undefined
        ? await this.deps.sql<Row[]>`SELECT * FROM pay.custody_policy_versions WHERE status = 'published'`
        : await this.deps.sql<Row[]>`SELECT * FROM pay.custody_policy_versions WHERE version = ${input.version}`;
    const row = rows[0];
    if (!row) {
      throw input.version === undefined
        ? new CustodyPolicyError('custody_policy.unset', 'no custody policy is published')
        : new CustodyPolicyError('custody_policy.version_not_found', `no policy version ${input.version}`);
    }
    let amount: Amount;
    try {
      amount = parseAmount(input.amount);
    } catch {
      throw new CustodyPolicyError('custody_policy.draft_invalid', 'amount must be a decimal string');
    }
    const tx: PolicyTx = {
      initiator: input.userId,
      assetId: input.assetId,
      amount,
      network: input.network,
      destinationKind: input.destinationKind,
      destinationRef: input.destinationRef,
      txType: input.txType,
    };
    const decision = await evaluatePolicy(row.rules, tx, withdrawalsUsedInWindow(this.deps.sql));
    return {
      version: row.version,
      outcome: decision.outcome,
      ruleId: decision.ruleId,
      matchedRuleIds: [...decision.matchedRuleIds],
      approval: decision.approval ? { ...decision.approval, members: [...decision.approval.members] } : null,
    };
  }
}
