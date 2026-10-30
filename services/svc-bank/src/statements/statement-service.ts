import { BankError } from '../errors.js';
import { ActivityAccountUnknownError, ActivityService, ActivityUnavailableError, type ActivityItem } from '../activity/activity-service.js';
import type { SpaceService } from '../spaces/space-service.js';
import { signStatement, statementCsv, statementLines, statementPdf } from './statement-file.js';

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
/** The activity kinds a `trades` file reads: trade lines, and fee lines (kept only when they belong to an order). */
const TRADE_KINDS = ['trade', 'fee'] as const;

/** A trade line, or a fee the ledger links to one of the person's orders; a withdrawal or listing fee is not a trade. */
const isTradeLine = (item: ActivityItem) => item.kind === 'trade' || (item.kind === 'fee' && item.orderId !== undefined);

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

export class StatementService {
  constructor(
    private readonly activity: ActivityService,
    private readonly secret: string | undefined,
    private readonly spaces?: Pick<SpaceService, 'find'>,
  ) {}

  async export(
    userId: string,
    input: {
      from: string;
      to: string;
      assetId?: string;
      spaceId?: string;
      format: 'csv' | 'pdf';
      report?: StatementReport;
      now?: Date;
    },
  ): Promise<StatementFile> {
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
    const assetId = space?.assetId ?? input.assetId;
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
    if (report === 'trades') items = items.filter(isTradeLine);
    if (items.length > MAX_ROWS) {
      throw new BankError(`A statement holds at most ${MAX_ROWS} lines. Narrow the dates.`, 'bank.statement_too_large');
    }
    const generatedAt = (input.now ?? new Date()).toISOString();
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
