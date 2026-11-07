import { BankError } from '../errors.js';
import { ActivityAccountUnknownError, ActivityService, ActivityUnavailableError, type ActivityItem } from '../activity/activity-service.js';
import type { SpaceService } from '../spaces/space-service.js';
import { lineTotals, signStatement, statementCsv, statementLines, statementPdf, type LineTotal } from './statement-file.js';

/**
 * `bank.statements.export` — a signed file of the caller's own posted lines.
 * CSV for any range up to 366 days. PDF for a single UTC calendar month.
 * With `spaceId`, only the lines of that one of the caller's own named spaces
 * (BK-pots-02). Neither file states a balance.
 *
 * `report` (PF-statements-01) chooses what the file holds: `statement` and
 * `ledger` every posted line, `trades` only trade lines and fee lines (a
 * fill's own fee is taken from what it delivers, so its line is net of it). `balances`, a holding snapshot at a past date, needs a
 * past-balance read the ledger does not offer yet and refuses
 * `bank.statement_balances_unavailable`.
 */

/** What a statement file holds. */
export const STATEMENT_REPORTS = ['statement', 'ledger', 'trades', 'balances'] as const;
export type StatementReport = (typeof STATEMENT_REPORTS)[number];
/**
 * The activity kinds a `trades` file reads: trade lines, conversions (a Convert is a trade the person made, listed under
 * its own kind in Activity), and fee lines (kept only when they belong to an order).
 */
const TRADE_KINDS = ['trade', 'convert', 'fee'] as const;

/** A trade or conversion line, or a fee the ledger links to one of the person's orders; a withdrawal or listing fee is not a trade. */
const isTradeLine = (item: ActivityItem) =>
  item.kind === 'trade' || item.kind === 'convert' || (item.kind === 'fee' && item.orderId !== undefined);

const MAX_ROWS = 5_000;
const MAX_SPAN_MS = 366 * 24 * 60 * 60 * 1000;

export interface StatementFile {
  readonly format: 'csv' | 'pdf';
  readonly filename: string;
  readonly contentType: string;
  readonly bodyBase64: string;
  readonly sha256: string;
  readonly signature: string;
  readonly rowCount: number;
  /**
   * Per asset, the net of the file's lines (J-bank-16 #1), the same fold `activity.totals` makes over the same range. A
   * background job's stored file is handed back without it; its PDF still prints the totals.
   */
  readonly totals?: LineTotal[];
  readonly generatedAt: string;
  readonly proof: {
    readonly holderUserId: string;
    readonly from: string;
    readonly to: string;
    readonly assetId: string | null;
    /** The one space the statement covers, or null for the whole account. */
    readonly spaceId: string | null;
    /** What the file holds: a trades file leaves every other line out, so its proof says so. */
    readonly report: Exclude<StatementReport, 'balances'>;
    readonly rowCount: number;
    readonly generatedAt: string;
    readonly sha256: string;
  };
}

/** What a person asks a statement file for. */
export interface StatementRequest {
  readonly from: string;
  readonly to: string;
  readonly assetId?: string;
  readonly spaceId?: string;
  readonly format: 'csv' | 'pdf';
  readonly report?: StatementReport;
}

/** A request that passed every check: the report it names, and the caller's own space when it names one. */
export interface StatementPlan {
  readonly from: string;
  readonly to: string;
  readonly format: 'csv' | 'pdf';
  readonly report: Exclude<StatementReport, 'balances'>;
  readonly assetId: string | undefined;
  readonly space: { readonly id: string; readonly name: string; readonly assetId: string } | null;
}

export class StatementService {
  constructor(
    private readonly activity: ActivityService,
    private readonly secret: string | undefined,
    private readonly spaces?: Pick<SpaceService, 'find'>,
  ) {}

  async export(userId: string, input: StatementRequest & { now?: Date }): Promise<StatementFile> {
    return this.render(userId, await this.plan(userId, input), input.now ?? new Date());
  }

  /**
   * Every refusal a file could meet before a line is read: the report, the secret, the range, one month per PDF, and the
   * caller's own space. A background export (PF-statements-02) runs this when it is asked, so a request that would be
   * refused is refused then, and never sits in the queue.
   */
  async plan(userId: string, input: StatementRequest): Promise<StatementPlan> {
    const report = input.report ?? 'statement';
    if (report === 'balances') {
      throw new BankError(
        'A balance snapshot needs a past-balance read from the ledger, which is not built yet',
        'bank.statement_balances_unavailable',
      );
    }
    if (!this.secret) {
      throw new BankError('Statements are not available until the service secret is set', 'bank.statement_unavailable');
    }
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      throw new BankError('The statement end is before the start', 'bank.statement_range');
    }
    if (toMs - fromMs > MAX_SPAN_MS) {
      throw new BankError('A statement covers at most 366 days', 'bank.statement_range');
    }
    if (input.format === 'pdf') {
      const from = new Date(fromMs);
      const to = new Date(toMs);
      if (from.getUTCFullYear() !== to.getUTCFullYear() || from.getUTCMonth() !== to.getUTCMonth()) {
        throw new BankError('A PDF statement covers one UTC calendar month', 'bank.statement_pdf_one_month');
      }
    }
    // One space: the caller's own named space, read here so another person's reads as not found. Its asset narrows the
    // read; a different asset asked for alongside it is refused rather than quietly replaced.
    let space: { id: string; name: string; assetId: string } | null = null;
    if (input.spaceId !== undefined) {
      if (!this.spaces) {
        throw new BankError('Space statements are not available on this service', 'bank.statement_unavailable');
      }
      const found = await this.spaces.find(input.spaceId);
      if (!found || found.userId !== userId || found.kind !== 'named') {
        throw new BankError(`Space ${input.spaceId} not found`, 'bank.space_not_found');
      }
      if (input.assetId !== undefined && input.assetId !== found.assetId) {
        throw new BankError(`Space "${found.name}" holds ${found.assetId}, not ${input.assetId}`, 'bank.asset_mismatch');
      }
      space = { id: found.id, name: found.name, assetId: found.assetId };
    }
    return { from: input.from, to: input.to, format: input.format, report, assetId: space?.assetId ?? input.assetId, space };
  }

  /**
   * `bank.activity.totals` (J-bank-16 #1): per asset, the net of every posted line between two times, read the same way
   * a statement reads them and folded by the same `lineTotals`, so the activity list and the statement agree. Past the
   * statement's line cap it refuses `bank.statement_too_large` rather than total part of the range.
   */
  async totals(userId: string, input: { from: string; to: string; assetId?: string }): Promise<{ totals: LineTotal[]; lines: number }> {
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      throw new BankError('The end is before the start', 'bank.statement_range');
    }
    if (toMs - fromMs > MAX_SPAN_MS) throw new BankError('A total covers at most 366 days', 'bank.statement_range');
    let items: ActivityItem[];
    try {
      items = await this.activity.collect(userId, { from: input.from, to: input.to, assetId: input.assetId, limit: MAX_ROWS + 1 });
    } catch (err) {
      if (err instanceof ActivityUnavailableError) {
        throw new BankError('Activity is not available, so no total can be worked out', 'bank.statement_unavailable');
      }
      throw err;
    }
    if (items.length > MAX_ROWS) {
      throw new BankError(`A total covers at most ${MAX_ROWS} lines. Narrow the dates.`, 'bank.statement_too_large');
    }
    return { totals: lineTotals(items), lines: items.length };
  }

  /** The file for a planned request, as of `now`: the same plan and the same `now` over the same lines give the same bytes. */
  async render(userId: string, plan: StatementPlan, now: Date): Promise<StatementFile> {
    if (!this.secret) {
      throw new BankError('Statements are not available until the service secret is set', 'bank.statement_unavailable');
    }
    const { report, space, assetId } = plan;
    const input = { from: plan.from, to: plan.to, format: plan.format, spaceId: space?.id };
    let items: ActivityItem[];
    try {
      items = await this.activity.collect(userId, {
        from: input.from,
        to: input.to,
        assetId,
        ...(space ? { accountId: space.id } : {}),
        ...(report === 'trades' ? { kind: [...TRADE_KINDS] } : {}),
        limit: MAX_ROWS + 1,
      });
    } catch (err) {
      if (err instanceof ActivityUnavailableError) {
        throw new BankError('Activity is not available, so a statement cannot be built', 'bank.statement_unavailable');
      }
      if (err instanceof ActivityAccountUnknownError) {
        throw new BankError(`Space ${input.spaceId} not found`, 'bank.space_not_found');
      }
      throw err;
    }
    // The cap is checked on what was read, before the trades filter: collect stops at MAX_ROWS + 1 lines, so a filtered
    // count under the cap could still be missing older lines.
    if (items.length > MAX_ROWS) {
      throw new BankError(`A statement holds at most ${MAX_ROWS} lines. Narrow the dates.`, 'bank.statement_too_large');
    }
    if (report === 'trades') items = items.filter(isTradeLine);
    const generatedAt = now.toISOString();
    const bytes =
      input.format === 'csv'
        ? Buffer.from(statementCsv(items), 'utf8')
        : statementPdf(
            statementLines({
              holderUserId: userId,
              from: input.from,
              to: input.to,
              generatedAt,
              rows: items,
              report,
              ...(space ? { space: { id: space.id, name: space.name } } : {}),
            }),
          );
    const signed = signStatement(this.secret, bytes);
    const day = generatedAt.slice(0, 10);
    const scope = `${space ? `space-${space.id.slice(0, 8)}-` : ''}${report === 'trades' ? 'trades-' : ''}`;
    const filename =
      input.format === 'csv'
        ? `intafaced-${scope || 'activity-'}${day}.csv`
        : `intafaced-${scope}${report === 'trades' ? 'history' : 'statement'}-${input.from.slice(0, 7)}.pdf`;
    return {
      format: input.format,
      filename,
      contentType: input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      bodyBase64: bytes.toString('base64'),
      sha256: signed.sha256,
      signature: signed.signature,
      rowCount: items.length,
      totals: lineTotals(items),
      generatedAt,
      proof: {
        holderUserId: userId,
        from: input.from,
        to: input.to,
        assetId: assetId ?? null,
        spaceId: space?.id ?? null,
        report,
        rowCount: items.length,
        generatedAt,
        sha256: signed.sha256,
      },
    };
  }
}
