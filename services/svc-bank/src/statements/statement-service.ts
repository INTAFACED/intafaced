import { BankError } from '../errors.js';
import { ActivityService, ActivityUnavailableError, type ActivityItem } from '../activity/activity-service.js';
import { signStatement, statementCsv, statementLines, statementPdf } from './statement-file.js';

/**
 * `bank.statements.export` — a signed file of the caller's own posted lines.
 * CSV for any range up to 366 days. PDF for a single UTC calendar month.
 * Neither file states a balance.
 */

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
    readonly rowCount: number;
    readonly generatedAt: string;
    readonly sha256: string;
  };
}

export class StatementService {
  constructor(
    private readonly activity: ActivityService,
    private readonly secret: string | undefined,
  ) {}

  async export(
    userId: string,
    input: { from: string; to: string; assetId?: string; format: 'csv' | 'pdf'; now?: Date },
  ): Promise<StatementFile> {
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
    let items: ActivityItem[];
    try {
      items = await this.activity.collect(userId, {
        from: input.from,
        to: input.to,
        assetId: input.assetId,
        limit: MAX_ROWS + 1,
      });
    } catch (err) {
      if (err instanceof ActivityUnavailableError) {
        throw new BankError('Activity is not available, so a statement cannot be built', 'bank.statement_unavailable');
      }
      throw err;
    }
    if (items.length > MAX_ROWS) {
      throw new BankError(`A statement holds at most ${MAX_ROWS} lines. Narrow the dates.`, 'bank.statement_too_large');
    }
    const generatedAt = (input.now ?? new Date()).toISOString();
    const bytes =
      input.format === 'csv'
        ? Buffer.from(statementCsv(items), 'utf8')
        : statementPdf(statementLines({ holderUserId: userId, from: input.from, to: input.to, generatedAt, rows: items }));
    const signed = signStatement(this.secret, bytes);
    const day = generatedAt.slice(0, 10);
    const filename = input.format === 'csv' ? `intafaced-activity-${day}.csv` : `intafaced-statement-${input.from.slice(0, 7)}.pdf`;
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
        assetId: input.assetId ?? null,
        rowCount: items.length,
        generatedAt,
        sha256: signed.sha256,
      },
    };
  }
}
