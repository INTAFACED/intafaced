import { randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  ALERT_KINDS,
  ALERT_SETTING,
  EXPORT_FIELDS,
  TOP_CAMPAIGNS,
  TREND_DAYS,
  WATCH_LIST_LIMIT,
  type AlertKind,
  type BudgetSplit,
  type CodeBatch,
  type CodeBatchResult,
  type ExportDataset,
  type ExportFile,
  type ExportJob,
  type ExportRequestResult,
  type WatchAlert,
  type WatchCampaign,
  type WatchOverview,
  type WatchVoucher,
} from '@intafaced/contracts/campaigns-watch';
import type { CampaignState, RewardState, VoucherState } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError, codeHashOf, lastFourOf, normalCode } from './codes.js';
import { effectiveState, type CampaignService } from './campaigns.js';

/**
 * The operator's watch desk for running campaigns (J-campaigns-17; CM-campaign-admin-01, -02, CM-campaign-types-03).
 *
 * - Every figure is counted from this service's own rows on each read. A budget is a limit: `reserved` is what open
 *   rewards hold of it, `spent` what booked ones took, `left` the limit less both, so the three always add up to the limit.
 *   Nothing here moves value or calls the ledger.
 * - Code batches. A generate makes `count` random codes (80 bits each) and stores each as its SHA-256 hash and last four
 *   characters only; the plain codes are in the answer to that one call and nowhere else, so a second generate under the
 *   same reference returns the batch without them. An import stores a CSV's codes the same way. Both refuse while the
 *   owner's batch limit is blank (`campaigns.code_batch_limit_unset`) or over it (`campaigns.code_batch_limit_exceeded`),
 *   and refuse any code that repeats in the batch or is already issued, storing nothing. A batch's vouchers wait as
 *   `generated` until it is published to customers, in one transaction with its publication row.
 * - Deactivating a voucher stops its claim (the generic refusal, as any code that cannot be claimed) and every later use
 *   (`campaigns.voucher_deactivated`); what it already paid stays paid.
 * - Exports. The same export (campaign, dataset and fields) asked for while its job is open or its link is valid returns
 *   that job, so one job runs. The file carries the selected fields only, in the dataset's own order, and its link works
 *   for the owner's validity (`CAMPAIGNS_EXPORT_LINK_SECONDS`; blank refuses every export); after it the download refuses
 *   `campaigns.export_expired` and the sweep deletes the file.
 */

type Sql = postgres.Sql;

/** Reward states that hold budget but are not booked yet; and those that booked it. The rest hold none. */
const RESERVED: readonly RewardState[] = ['held', 'qualified', 'posting', 'pending_funding', 'pending_retry', 'unknown'];
const SPENT: readonly RewardState[] = ['posted', 'owed', 'locked', 'settling'];
const HOLDS_NOTHING: readonly RewardState[] = ['failed', 'forfeited', 'withheld'];
/** Campaigns that went live: what the desk watches. */
const RUNNING: readonly CampaignState[] = ['scheduled', 'active', 'paused', 'ended', 'closed'];

const ALERT_TITLE: Record<AlertKind, string> = {
  budget_low: 'Budget running low',
  redemptions_spike: 'Redemptions spike',
};

/** Crockford's base32 without I, L, O and U: no two characters read alike. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const INSERT_CHUNK = 1000;

/** A code of 16 random characters in four groups (80 bits): `XXXX-XXXX-XXXX-XXXX`. */
export function newCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i]! & 31];
  }
  return out;
}

/** One CSV cell: quoted when it needs it, and a leading formula character neutralised so a spreadsheet never runs it. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The selected fields in the dataset's own order: the same selection in another order is the same export. */
export function canonicalFields(dataset: ExportDataset, fields: readonly string[]): string[] {
  return (EXPORT_FIELDS[dataset] as readonly string[]).filter((f) => fields.includes(f));
}

export const exportKeyOf = (campaignId: string, dataset: ExportDataset, fields: readonly string[]) =>
  `export:${campaignId}:${dataset}:${canonicalFields(dataset, fields).join(',')}`;

export type WatchLimits = {
  codeBatchMax: number | null;
  exportLinkSeconds: number | null;
  alerts: Record<AlertKind, number | null>;
};

export interface WatchServiceOptions {
  sql: Sql;
  campaigns: Pick<CampaignService, 'voucherTerms'>;
  /** The owner's values, read per call; each blank refuses what needs it. */
  limits: () => WatchLimits;
  now?: () => Date;
}

type BatchRow = {
  id: string;
  campaign_id: string;
  reference: string;
  source: CodeBatch['source'];
  count: number;
  state: CodeBatch['state'];
  created_by: string;
  created_at: Date;
  published_by: string | null;
  published_at: Date | null;
};

type JobRow = {
  id: string;
  export_key: string;
  campaign_id: string;
  dataset: ExportDataset;
  fields: string[];
  state: ExportJob['state'];
  requested_by: string;
  requested_at: Date;
  validity_seconds: number;
  ready_at: Date | null;
  expires_at: Date | null;
  rows: number | null;
  file: string | null;
};

type VoucherRow = {
  id: string;
  code_last4: string;
  state: VoucherState;
  batch_id: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  created_at: Date;
};

const toBatch = (b: BatchRow): CodeBatch => ({
  id: b.id,
  campaignId: b.campaign_id,
  reference: b.reference,
  source: b.source,
  count: b.count,
  state: b.state,
  createdBy: b.created_by,
  createdAt: b.created_at.toISOString(),
  publishedBy: b.published_by,
  publishedAt: b.published_at ? b.published_at.toISOString() : null,
});

const toJob = (j: JobRow): ExportJob => ({
  id: j.id,
  campaignId: j.campaign_id,
  dataset: j.dataset,
  fields: j.fields,
  state: j.state,
  requestedBy: j.requested_by,
  requestedAt: j.requested_at.toISOString(),
  readyAt: j.ready_at ? j.ready_at.toISOString() : null,
  expiresAt: j.expires_at ? j.expires_at.toISOString() : null,
  rows: j.rows,
});

const toWatchVoucher = (v: VoucherRow): WatchVoucher => ({
  id: v.id,
  codeLastFour: v.code_last4,
  state: v.state,
  batchId: v.batch_id,
  claimedBy: v.claimed_by,
  claimedAt: v.claimed_at ? v.claimed_at.toISOString() : null,
  issuedAt: v.created_at.toISOString(),
});

/** The split of one budget: `left` is the limit less what is reserved and spent, so the three add up to the limit. */
export function splitOf(asset: string, limit: string, reserved: string, spent: string): BudgetSplit {
  const l = parseAmount(limit);
  const r = parseAmount(reserved);
  const s = parseAmount(spent);
  return { asset, limit: formatAmount(l), reserved: formatAmount(r), spent: formatAmount(s), left: formatAmount(l - r - s) };
}

const SELECT_BATCH = (sql: Sql) => sql`
  SELECT b.*, p.published_by, p.published_at FROM campaigns.code_batches b
  LEFT JOIN campaigns.code_publications p ON p.batch_id = b.id`;

export class WatchService {
  private readonly sql: Sql;
  private readonly campaigns: Pick<CampaignService, 'voucherTerms'>;
  private readonly limits: () => WatchLimits;
  private readonly now: () => Date;

  constructor(options: WatchServiceOptions) {
    this.sql = options.sql;
    this.campaigns = options.campaigns;
    this.limits = options.limits;
    this.now = options.now ?? (() => new Date());
  }

  /** Every running campaign's KPIs, the redemption trend, the top campaigns and the alerts, counted on this read. */
  async overview(): Promise<WatchOverview> {
    const now = this.now();
    const rows = await this.sql<
      {
        id: string;
        name: string;
        state: CampaignState;
        starts_at: Date | null;
        ends_at: Date | null;
        budget_asset: string | null;
        budget_limit: string | null;
        reserved: string;
        spent: string;
        redemptions: number;
        participants: number;
      }[]
    >`
      SELECT c.id, c.name, c.state, c.starts_at, c.ends_at, c.budget_asset, c.budget_limit::text AS budget_limit,
        COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i WHERE i.campaign_id = c.id AND i.state IN ${this.sql(RESERVED)}), 0)::text AS reserved,
        COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i WHERE i.campaign_id = c.id AND i.state IN ${this.sql(SPENT)}), 0)::text AS spent,
        (SELECT count(*)::int FROM campaigns.reward_intents i WHERE i.campaign_id = c.id AND i.state NOT IN ${this.sql(HOLDS_NOTHING)}) AS redemptions,
        (SELECT count(*)::int FROM campaigns.participations p WHERE p.campaign_id = c.id) AS participants
      FROM campaigns.campaigns c WHERE c.state IN ${this.sql(RUNNING)}
      ORDER BY c.created_at DESC, c.id`;
    const ids = rows.map((r) => r.id);
    const [vouchers] = ids.length
      ? await this.sql<{ issued: number; claimed: number }[]>`
          SELECT count(*) FILTER (WHERE state <> 'generated')::int AS issued, count(*) FILTER (WHERE claimed_by IS NOT NULL)::int AS claimed
          FROM campaigns.vouchers WHERE campaign_id IN ${this.sql(ids)}`
      : [{ issued: 0, claimed: 0 }];

    const budgets = new Map<string, { limit: bigint; reserved: bigint; spent: bigint }>();
    for (const r of rows) {
      if (!r.budget_asset || r.budget_limit === null) continue;
      const b = budgets.get(r.budget_asset) ?? { limit: 0n, reserved: 0n, spent: 0n };
      b.limit += parseAmount(r.budget_limit);
      b.reserved += parseAmount(r.reserved);
      b.spent += parseAmount(r.spent);
      budgets.set(r.budget_asset, b);
    }

    // The trend: rewards and redemptions written each UTC day, today and the 13 before it, with days of none at zero.
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const since = new Date(today - (TREND_DAYS - 1) * 86_400_000);
    const byDay = await this.sql<{ day: string; n: number }[]>`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n FROM campaigns.reward_intents
      WHERE created_at >= ${since} AND state NOT IN ${this.sql(HOLDS_NOTHING)} GROUP BY 1`;
    const counted = new Map(byDay.map((d) => [d.day, d.n]));
    const trend = Array.from({ length: TREND_DAYS }, (_, i) => {
      const day = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return { day, redemptions: counted.get(day) ?? 0 };
    });

    const top = [...rows]
      .sort((a, b) => b.redemptions - a.redemptions || b.participants - a.participants || a.name.localeCompare(b.name))
      .slice(0, TOP_CAMPAIGNS)
      .map((r) => ({
        campaignId: r.id,
        name: r.name,
        state: effectiveState(r, now),
        redemptions: r.redemptions,
        participants: r.participants,
      }));

    const alerts = await this.alerts(rows, now);
    return {
      asOf: now.toISOString(),
      kpis: {
        running: rows.length,
        live: rows.filter((r) => effectiveState(r, now) === 'active').length,
        participants: rows.reduce((n, r) => n + r.participants, 0),
        vouchersIssued: vouchers!.issued,
        vouchersClaimed: vouchers!.claimed,
        redemptions: rows.reduce((n, r) => n + r.redemptions, 0),
      },
      budgets: [...budgets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([asset, b]) => splitOf(asset, formatAmount(b.limit), formatAmount(b.reserved), formatAmount(b.spent))),
      trend,
      top,
      campaigns: rows.slice(0, WATCH_LIST_LIMIT).map((r) => ({ campaignId: r.id, name: r.name, state: effectiveState(r, now) })),
      alerts,
    };
  }

  private async alerts(
    rows: readonly {
      id: string;
      name: string;
      state: CampaignState;
      starts_at: Date | null;
      ends_at: Date | null;
      budget_asset: string | null;
      budget_limit: string | null;
      reserved: string;
      spent: string;
    }[],
    now: Date,
  ): Promise<WatchAlert[]> {
    const limits = this.limits().alerts;
    const settings = await this.sql<{ kind: AlertKind; enabled: boolean }[]>`SELECT kind, enabled FROM campaigns.alert_settings`;
    const enabled = new Map(settings.map((s) => [s.kind, s.enabled]));
    const out: WatchAlert[] = [];
    for (const kind of ALERT_KINDS) {
      const threshold = limits[kind];
      const on = threshold !== null && enabled.get(kind) === true;
      const firing: WatchAlert['firing'] = [];
      if (on && kind === 'budget_low') {
        for (const r of rows) {
          if (effectiveState(r, now) !== 'active' || !r.budget_asset || r.budget_limit === null) continue;
          const split = splitOf(r.budget_asset, r.budget_limit, r.reserved, r.spent);
          const limit = parseAmount(split.limit);
          if (limit > 0n && parseAmount(split.left) * 100n < BigInt(threshold) * limit) {
            firing.push({ campaignId: r.id, name: r.name, detail: `${split.left} of ${split.limit} ${split.asset} left` });
          }
        }
      }
      if (on && kind === 'redemptions_spike') {
        const [hour] = await this.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM campaigns.reward_intents
          WHERE created_at > ${new Date(now.getTime() - 3_600_000)} AND state NOT IN ${this.sql(HOLDS_NOTHING)}`;
        if (hour!.n > threshold) firing.push({ campaignId: null, name: 'Every campaign', detail: `${hour!.n} in the last hour` });
      }
      out.push({
        kind,
        title: ALERT_TITLE[kind],
        threshold: threshold === null ? null : String(threshold),
        setting: ALERT_SETTING[kind],
        enabled: on,
        firing,
      });
    }
    return out;
  }

  /** Switches one alert on or off. On refuses while its owner threshold is blank: blank never means "no limit". */
  async setAlert(input: { kind: AlertKind; enabled: boolean; actor: string }): Promise<WatchAlert> {
    if (input.enabled && this.limits().alerts[input.kind] === null) {
      throw new CampaignsError(
        'campaigns.alert_threshold_unset',
        `The ${ALERT_TITLE[input.kind].toLowerCase()} alert cannot be switched on: its threshold (${ALERT_SETTING[input.kind]}) is not set`,
      );
    }
    await transaction(this.sql, async (tx) => {
      await tx`
        INSERT INTO campaigns.alert_settings (kind, enabled, changed_by, changed_at) VALUES (${input.kind}, ${input.enabled}, ${input.actor}, ${this.now()})
        ON CONFLICT (kind) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.actor}, 'campaign.alert.set', ${input.kind}, ${tx.json({ enabled: input.enabled })})`;
    });
    return (await this.overview()).alerts.find((a) => a.kind === input.kind)!;
  }

  /** One campaign's participation, vouchers, redemptions, publications, code batches and exports, each with its row count. */
  async campaign(input: { id: string }): Promise<WatchCampaign> {
    const now = this.now();
    const [c] = await this.sql<
      {
        id: string;
        name: string;
        type: WatchCampaign['campaign']['type'];
        state: CampaignState;
        starts_at: Date | null;
        ends_at: Date | null;
        budget_asset: string | null;
        budget_limit: string | null;
        reserved: string;
        spent: string;
      }[]
    >`
      SELECT c.id, c.name, c.type, c.state, c.starts_at, c.ends_at, c.budget_asset, c.budget_limit::text AS budget_limit,
        COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i WHERE i.campaign_id = c.id AND i.state IN ${this.sql(RESERVED)}), 0)::text AS reserved,
        COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i WHERE i.campaign_id = c.id AND i.state IN ${this.sql(SPENT)}), 0)::text AS spent
      FROM campaigns.campaigns c WHERE c.id = ${input.id}`;
    if (!c) throw new CampaignsError('campaign.unknown', 'No such campaign');
    const id = c.id;
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
    const [participants, participantRows, voucherCount, byState, voucherRows, redemptionCount, redemptionRows] = await Promise.all([
      n(this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.participations WHERE campaign_id = ${id}`),
      this.sql<{ account_id: string; created_at: Date }[]>`
        SELECT account_id, created_at FROM campaigns.participations WHERE campaign_id = ${id}
        ORDER BY created_at DESC, account_id LIMIT ${WATCH_LIST_LIMIT}`,
      n(this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.vouchers WHERE campaign_id = ${id}`),
      this.sql<{ state: VoucherState; n: number }[]>`
        SELECT state, count(*)::int AS n FROM campaigns.vouchers WHERE campaign_id = ${id} GROUP BY state ORDER BY state`,
      this.sql<VoucherRow[]>`
        SELECT id, code_last4, state, batch_id, claimed_by, claimed_at, created_at FROM campaigns.vouchers WHERE campaign_id = ${id}
        ORDER BY created_at DESC, id DESC LIMIT ${WATCH_LIST_LIMIT}`,
      n(this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.reward_intents WHERE campaign_id = ${id}`),
      this.sql<{ reward_key: string; account_id: string; asset: string; amount: string; state: RewardState; created_at: Date }[]>`
        SELECT reward_key, account_id, asset, amount::text AS amount, state, created_at FROM campaigns.reward_intents
        WHERE campaign_id = ${id} ORDER BY created_at DESC, reward_key LIMIT ${WATCH_LIST_LIMIT}`,
    ]);
    const [publicationCount, publicationRows, batches, jobs] = await Promise.all([
      n(this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.code_publications WHERE campaign_id = ${id}`),
      this.sql<{ id: string; batch_id: string; reference: string; vouchers: number; published_by: string; published_at: Date }[]>`
        SELECT p.id, p.batch_id, b.reference, p.vouchers, p.published_by, p.published_at
        FROM campaigns.code_publications p JOIN campaigns.code_batches b ON b.id = p.batch_id
        WHERE p.campaign_id = ${id} ORDER BY p.published_at DESC, p.id LIMIT ${WATCH_LIST_LIMIT}`,
      this.sql<
        BatchRow[]
      >`${SELECT_BATCH(this.sql)} WHERE b.campaign_id = ${id} ORDER BY b.created_at DESC, b.id LIMIT ${WATCH_LIST_LIMIT}`,
      this.sql<JobRow[]>`
        SELECT * FROM campaigns.export_jobs WHERE campaign_id = ${id} ORDER BY requested_at DESC, id LIMIT ${WATCH_LIST_LIMIT}`,
    ]);
    return {
      asOf: now.toISOString(),
      campaign: { id, name: c.name, type: c.type, state: effectiveState(c, now) },
      budget: c.budget_asset && c.budget_limit !== null ? splitOf(c.budget_asset, c.budget_limit, c.reserved, c.spent) : null,
      participation: {
        count: participants,
        rows: participantRows.map((p) => ({ accountId: p.account_id, joinedAt: p.created_at.toISOString() })),
      },
      vouchers: {
        count: voucherCount,
        byState: byState.map((s) => ({ state: s.state, count: s.n })),
        rows: voucherRows.map(toWatchVoucher),
      },
      redemptions: {
        count: redemptionCount,
        rows: redemptionRows.map((r) => ({
          rewardKey: r.reward_key,
          accountId: r.account_id,
          asset: r.asset,
          amount: formatAmount(parseAmount(r.amount)),
          state: r.state,
          createdAt: r.created_at.toISOString(),
        })),
      },
      publications: {
        count: publicationCount,
        rows: publicationRows.map((p) => ({
          id: p.id,
          batchId: p.batch_id,
          reference: p.reference,
          vouchers: p.vouchers,
          publishedBy: p.published_by,
          publishedAt: p.published_at.toISOString(),
        })),
      },
      batches: batches.map(toBatch),
      exports: jobs.map(toJob),
    };
  }

  // ── Code batches ─────────────────────────────────────────────────────────────────────────────────────────────────

  private batchLimit(n: number): void {
    const max = this.limits().codeBatchMax;
    if (max === null) {
      throw new CampaignsError(
        'campaigns.code_batch_limit_unset',
        'No codes can be made or imported: the most codes in one batch (CAMPAIGNS_CODE_BATCH_MAX) is not set',
      );
    }
    if (n > max) {
      throw new CampaignsError('campaigns.code_batch_limit_exceeded', `A batch holds at most ${max} codes; this one has ${n}`);
    }
  }

  /**
   * Makes a batch of `count` codes and returns them, once. Under the same reference again it returns the batch with no
   * codes: they were never stored.
   */
  async generate(input: { campaignId: string; reference: string; count: number; actor: string }): Promise<CodeBatchResult> {
    const had = await this.batchByReference(input.campaignId, input.reference);
    if (had) return this.again(had, 'generated', input.count);
    this.batchLimit(input.count);
    const codes: string[] = [];
    const result = await this.makeBatch(input, 'generated', input.count, async (tx, insert) => {
      // A hash already stored (a chance of about one in 2^80 per code) is drawn again, so the batch has `count` codes.
      const seen = new Set<string>();
      while (codes.length < input.count) {
        const fresh: string[] = [];
        while (fresh.length < Math.min(INSERT_CHUNK, input.count - codes.length)) {
          const code = newCode();
          if (!seen.has(code)) {
            seen.add(code);
            fresh.push(code);
          }
        }
        const stored = await insert(tx, fresh, codes.length);
        for (const code of fresh) if (stored.has(codeHashOf(code))) codes.push(code);
      }
    });
    return result.created ? { ...result, codes } : result;
  }

  /** Stores a CSV's codes as their hashes and last four characters. A code repeated in it or already issued refuses all. */
  async importCodes(input: { campaignId: string; reference: string; codes: readonly string[]; actor: string }): Promise<CodeBatchResult> {
    const had = await this.batchByReference(input.campaignId, input.reference);
    if (had) return this.again(had, 'imported', input.codes.length);
    this.batchLimit(input.codes.length);
    const normal = input.codes.map(normalCode);
    const first = new Map<string, number>();
    const repeated: number[] = [];
    normal.forEach((c, i) => {
      if (first.has(c)) repeated.push(i + 1);
      else first.set(c, i + 1);
    });
    if (repeated.length > 0) {
      throw new CampaignsError(
        'campaigns.code_import_duplicate',
        `The file repeats ${repeated.length} code${repeated.length === 1 ? '' : 's'} (row ${repeated.slice(0, 5).join(', ')}${repeated.length > 5 ? ', …' : ''}); nothing was imported`,
      );
    }
    return this.makeBatch(input, 'imported', normal.length, async (tx, insert) => {
      const hashes = normal.map(codeHashOf);
      const taken = await tx<{ code_hash: string }[]>`
        SELECT code_hash FROM campaigns.vouchers WHERE code_hash = ANY(${tx.array(hashes)}::text[])`;
      if (taken.length > 0) {
        const takenSet = new Set(taken.map((t) => t.code_hash));
        const rows = hashes.flatMap((h, i) => (takenSet.has(h) ? [i + 1] : []));
        throw new CampaignsError(
          'campaigns.voucher_code_taken',
          `${rows.length} code${rows.length === 1 ? ' in the file is' : 's in the file are'} already issued (row ${rows.slice(0, 5).join(', ')}${rows.length > 5 ? ', …' : ''}); nothing was imported`,
        );
      }
      for (let i = 0; i < normal.length; i += INSERT_CHUNK) {
        const chunk = normal.slice(i, i + INSERT_CHUNK);
        const stored = await insert(tx, chunk, i);
        // The hash is unique across campaigns: a code issued since the check is not stored, and nothing is.
        if (stored.size !== chunk.length) {
          throw new CampaignsError(
            'campaigns.voucher_code_taken',
            'A code in the file was issued while it was imported; nothing was imported',
          );
        }
      }
    });
  }

  private async batchByReference(campaignId: string, reference: string): Promise<BatchRow | null> {
    const [b] = await this.sql<BatchRow[]>`${SELECT_BATCH(this.sql)} WHERE b.campaign_id = ${campaignId} AND b.reference = ${reference}`;
    return b ?? null;
  }

  private again(had: BatchRow, source: CodeBatch['source'], count: number): CodeBatchResult {
    if (had.source !== source || had.count !== count) {
      throw new CampaignsError(
        'campaigns.code_batch_reference_taken',
        `This campaign already has a batch named ${had.reference} (${had.source}, ${had.count} codes); name this one differently`,
      );
    }
    return { batch: toBatch(had), codes: null, created: false };
  }

  private async makeBatch(
    input: { campaignId: string; reference: string; actor: string },
    source: CodeBatch['source'],
    count: number,
    fill: (tx: Sql, insert: (tx: Sql, codes: readonly string[], offset: number) => Promise<Set<string>>) => Promise<void>,
  ): Promise<CodeBatchResult> {
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`codes:batch:${input.campaignId}:${input.reference}`}))`;
      const [raced] = await tx<BatchRow[]>`
        ${SELECT_BATCH(tx)} WHERE b.campaign_id = ${input.campaignId} AND b.reference = ${input.reference}`;
      if (raced) return this.again(raced, source, count);
      const { row, face, feeSaver } = await this.campaigns.voucherTerms(tx, input.campaignId);
      const batchId = `cbt_${randomUUID()}`;
      await tx`
        INSERT INTO campaigns.code_batches (id, campaign_id, reference, source, count, created_by, created_at)
        VALUES (${batchId}, ${row.id}, ${input.reference}, ${source}, ${count}, ${input.actor}, ${this.now()})`;
      const insert = async (t: Sql, codes: readonly string[], offset: number) => {
        const rows = codes.map((code, i) => ({
          id: `vch_${randomUUID()}`,
          campaign_id: row.id,
          code: null,
          code_hash: codeHashOf(code),
          code_last4: lastFourOf(code),
          issue_key: `voucher:batch:${batchId}:${offset + i + 1}`,
          revision: row.revision,
          face_asset: face.asset,
          face_amount: face.amount,
          kind: feeSaver ? 'fee_saver' : 'cash',
          fee_discount_bps: feeSaver?.discountBps ?? null,
          state: 'generated',
          issued_by: input.actor,
          claim_by: row.vouchers?.claimBy ?? null,
          use_by: row.vouchers?.useBy ?? null,
          batch_id: batchId,
        }));
        const stored = await t<{ code_hash: string }[]>`
          INSERT INTO campaigns.vouchers ${t(rows)} ON CONFLICT (code_hash) DO NOTHING RETURNING code_hash`;
        return new Set(stored.map((s) => s.code_hash));
      };
      await fill(tx, insert);
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.actor}, ${`campaign.codes.${source === 'generated' ? 'generate' : 'import'}`}, ${row.id},
          ${tx.json({ batch: batchId, reference: input.reference, count })})`;
      const [made] = await tx<BatchRow[]>`${SELECT_BATCH(tx)} WHERE b.id = ${batchId}`;
      return { batch: toBatch(made!), codes: null, created: true };
    });
  }

  /** Publishes a batch's codes to customers: its generated vouchers become claimable, with one publication row. Once. */
  async publish(input: { batchId: string; actor: string }): Promise<CodeBatch> {
    return transaction(this.sql, async (tx) => {
      const [b] = await tx<{ id: string; campaign_id: string; state: CodeBatch['state'] }[]>`
        SELECT id, campaign_id, state FROM campaigns.code_batches WHERE id = ${input.batchId} FOR UPDATE`;
      if (!b) throw new CampaignsError('campaigns.code_batch_unknown', 'No such code batch');
      if (b.state === 'generated') {
        const moved = await tx`
          UPDATE campaigns.vouchers SET state = 'published', updated_at = now() WHERE batch_id = ${b.id} AND state = 'generated'`;
        await tx`
          INSERT INTO campaigns.code_publications (id, batch_id, campaign_id, vouchers, published_by, published_at)
          VALUES (${`cpb_${randomUUID()}`}, ${b.id}, ${b.campaign_id}, ${moved.count}, ${input.actor}, ${this.now()})`;
        await tx`UPDATE campaigns.code_batches SET state = 'published' WHERE id = ${b.id}`;
        await tx`
          INSERT INTO campaigns.audit_log (actor, action, target, detail)
          VALUES (${input.actor}, 'campaign.codes.publish', ${b.campaign_id}, ${tx.json({ batch: b.id, vouchers: moved.count })})`;
      }
      const [made] = await tx<BatchRow[]>`${SELECT_BATCH(tx)} WHERE b.id = ${b.id}`;
      return toBatch(made!);
    });
  }

  /** Deactivates one voucher: no claim and no use from now on. A second call returns it as it is. */
  async deactivate(input: { voucherId: string; actor: string }): Promise<WatchVoucher> {
    return transaction(this.sql, async (tx) => {
      const [v] = await tx<(VoucherRow & { campaign_id: string })[]>`
        SELECT id, campaign_id, code_last4, state, batch_id, claimed_by, claimed_at, created_at FROM campaigns.vouchers
        WHERE id = ${input.voucherId} FOR UPDATE`;
      if (!v) throw new CampaignsError('campaigns.voucher_unknown', 'No such voucher');
      if (v.state === 'deactivated') return toWatchVoucher(v);
      if (!['generated', 'published', 'active', 'claimed', 'partially_used'].includes(v.state)) {
        throw new CampaignsError(
          'campaign.invalid_transition',
          `A voucher that is ${v.state.replace('_', ' ')} has nothing left to deactivate`,
        );
      }
      const [done] = await tx<VoucherRow[]>`
        UPDATE campaigns.vouchers SET state = 'deactivated', deactivated_by = ${input.actor}, deactivated_at = ${this.now()}, updated_at = now()
        WHERE id = ${v.id} RETURNING id, code_last4, state, batch_id, claimed_by, claimed_at, created_at`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.actor}, 'campaign.voucher.deactivate', ${v.campaign_id}, ${tx.json({ voucher: v.id, was: v.state })})`;
      return toWatchVoucher(done!);
    });
  }

  // ── Exports ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Asks for an export; the same one while its job is open or its link valid returns that job. A new job runs now. */
  async requestExport(input: {
    campaignId: string;
    dataset: ExportDataset;
    fields: readonly string[];
    actor: string;
  }): Promise<ExportRequestResult> {
    const validity = this.limits().exportLinkSeconds;
    if (validity === null) {
      throw new CampaignsError(
        'campaigns.export_validity_unset',
        'No export can be made: how long its link works (CAMPAIGNS_EXPORT_LINK_SECONDS) is not set',
      );
    }
    const fields = canonicalFields(input.dataset, input.fields);
    const key = exportKeyOf(input.campaignId, input.dataset, fields);
    const now = this.now();
    const outcome = await transaction(this.sql, async (tx) => {
      const [c] = await tx<{ id: string }[]>`SELECT id FROM campaigns.campaigns WHERE id = ${input.campaignId}`;
      if (!c) throw new CampaignsError('campaign.unknown', 'No such campaign');
      await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const [open] = await tx<JobRow[]>`
        SELECT * FROM campaigns.export_jobs WHERE export_key = ${key}
          AND (state IN ('queued', 'running') OR (state = 'ready' AND expires_at > ${now}))
        ORDER BY requested_at DESC LIMIT 1`;
      if (open) return { id: open.id, created: false };
      const id = `exp_${randomUUID()}`;
      await tx`
        INSERT INTO campaigns.export_jobs (id, export_key, campaign_id, dataset, fields, requested_by, requested_at, validity_seconds)
        VALUES (${id}, ${key}, ${input.campaignId}, ${input.dataset}, ${tx.array(fields)}, ${input.actor}, ${now}, ${validity})`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.actor}, 'campaign.export.request', ${input.campaignId}, ${tx.json({ job: id, dataset: input.dataset, fields })})`;
      return { id, created: true };
    });
    if (outcome.created) await this.runExport(outcome.id);
    const [job] = await this.sql<JobRow[]>`SELECT * FROM campaigns.export_jobs WHERE id = ${outcome.id}`;
    return { job: toJob(job!), created: outcome.created };
  }

  /** Runs one queued job, once: a conditional update takes it, so two runners never both build it. */
  async runExport(id: string): Promise<void> {
    const [job] = await this.sql<JobRow[]>`
      UPDATE campaigns.export_jobs SET state = 'running' WHERE id = ${id} AND state = 'queued' RETURNING *`;
    if (!job) return;
    try {
      const rows = await this.datasetRows(job.campaign_id, job.dataset);
      const lines = [job.fields.join(','), ...rows.map((r) => job.fields.map((f) => csvCell(r[f] ?? null)).join(','))];
      const at = this.now();
      await this.sql`
        UPDATE campaigns.export_jobs SET state = 'ready', file = ${`${lines.join('\n')}\n`}, rows = ${rows.length}, ready_at = ${at},
          expires_at = ${new Date(at.getTime() + job.validity_seconds * 1000)}
        WHERE id = ${id} AND state = 'running'`;
    } catch (err) {
      await this.sql`UPDATE campaigns.export_jobs SET state = 'failed' WHERE id = ${id} AND state = 'running'`;
      throw err;
    }
  }

  private async datasetRows(campaignId: string, dataset: ExportDataset): Promise<Record<string, string | number | null>[]> {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    if (dataset === 'participants') {
      const rows = await this.sql<{ account_id: string; created_at: Date }[]>`
        SELECT account_id, created_at FROM campaigns.participations WHERE campaign_id = ${campaignId} ORDER BY created_at, account_id`;
      return rows.map((r) => ({ accountId: r.account_id, joinedAt: iso(r.created_at) }));
    }
    if (dataset === 'redemptions') {
      const rows = await this.sql<
        { reward_key: string; account_id: string; asset: string; amount: string; state: string; created_at: Date; posted_at: Date | null }[]
      >`
        SELECT reward_key, account_id, asset, amount::text AS amount, state, created_at, posted_at FROM campaigns.reward_intents
        WHERE campaign_id = ${campaignId} ORDER BY created_at, reward_key`;
      return rows.map((r) => ({
        rewardKey: r.reward_key,
        accountId: r.account_id,
        asset: r.asset,
        amount: formatAmount(parseAmount(r.amount)),
        state: r.state,
        createdAt: iso(r.created_at),
        postedAt: iso(r.posted_at),
      }));
    }
    const rows = await this.sql<VoucherRow[]>`
      SELECT id, code_last4, state, batch_id, claimed_by, claimed_at, created_at FROM campaigns.vouchers
      WHERE campaign_id = ${campaignId} ORDER BY created_at, id`;
    return rows.map((r) => ({
      voucherId: r.id,
      codeLastFour: r.code_last4,
      state: r.state,
      batchId: r.batch_id,
      claimedBy: r.claimed_by,
      claimedAt: iso(r.claimed_at),
    }));
  }

  /** An export's file while its link is valid; after it, `campaigns.export_expired`. */
  async download(input: { id: string; actor: string }): Promise<ExportFile> {
    const [job] = await this.sql<JobRow[]>`SELECT * FROM campaigns.export_jobs WHERE id = ${input.id}`;
    if (!job) throw new CampaignsError('campaigns.export_unknown', 'No such export');
    if (job.state !== 'ready') {
      throw new CampaignsError('campaigns.export_not_ready', `This export is ${job.state}, so it has no file to download`);
    }
    if (!job.expires_at || job.expires_at <= this.now() || job.file === null) {
      throw new CampaignsError('campaigns.export_expired', 'This export’s link has passed its validity; ask for the export again');
    }
    await this.sql`
      INSERT INTO campaigns.audit_log (actor, action, target, detail)
      VALUES (${input.actor}, 'campaign.export.download', ${job.campaign_id}, ${this.sql.json({ job: job.id })})`;
    return { filename: `${job.campaign_id}-${job.dataset}-${job.id}.csv`, body: job.file, rows: job.rows ?? 0 };
  }

  /** Deletes every expired export's file and runs any job left queued (its runner stopped before it took it). */
  async sweepExports(): Promise<number> {
    const now = this.now();
    const gone = await this.sql`UPDATE campaigns.export_jobs SET file = NULL WHERE file IS NOT NULL AND expires_at <= ${now}`;
    const stuck = await this.sql<{ id: string }[]>`
      SELECT id FROM campaigns.export_jobs WHERE state = 'queued' AND requested_at < ${new Date(now.getTime() - 30_000)} LIMIT 20`;
    for (const s of stuck) await this.runExport(s.id);
    return gone.count;
  }
}
