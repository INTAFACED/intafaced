// TEST DATA ONLY. Nothing here is a real report or figure.
import { NOT_MINE, DAY, USER_ID, iso, ok, page, refuse } from '../../mock/shared.mjs';

const KINDS = ['payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees'];

/** Report files. Answers the seven kinds, columns, generated-at and expire. */
export function createReportsMock(ctx) {
  const { scenario, now, state } = ctx;
  const quiet = scenario === 'quiet' || scenario === 'new';
  const jobs = (state.reportJobs = quiet
    ? []
    : [
        {
          jobId: 'f1000000-0000-4000-8000-000000000001',
          kind: 'payments',
          filters: { from: iso(now - 30 * DAY), to: iso(now) },
          columns: ['payment_id', 'amount'],
          status: 'ready',
          failureCode: null,
          fileName: 'payments.csv',
          sizeBytes: '20480',
          rowCount: 120,
          sha256: 'ab'.repeat(32),
          requestedBy: USER_ID,
          asOf: iso(now - 3600_000),
          generatedAt: iso(now - 3600_000),
          expiresAt: null,
          createdAt: iso(now - 3700_000),
          completedAt: iso(now - 3600_000),
        },
        {
          jobId: 'f1000000-0000-4000-8000-000000000002',
          kind: 'fees',
          filters: {},
          columns: [],
          status: 'ready',
          failureCode: null,
          fileName: 'fees.csv',
          sizeBytes: '4096',
          rowCount: 30,
          sha256: 'cd'.repeat(32),
          requestedBy: 'TEST-user-finance',
          asOf: iso(now - DAY),
          generatedAt: iso(now - DAY),
          expiresAt: iso(now + 6 * DAY),
          createdAt: iso(now - DAY),
          completedAt: iso(now - DAY),
        },
        {
          jobId: 'f1000000-0000-4000-8000-000000000003',
          kind: 'disputes',
          filters: { status: 'open' },
          columns: [],
          status: 'failed',
          failureCode: 'pay.export_row_ceiling',
          fileName: null,
          sizeBytes: null,
          rowCount: null,
          sha256: null,
          requestedBy: USER_ID,
          asOf: null,
          generatedAt: null,
          expiresAt: null,
          createdAt: iso(now - 2 * DAY),
          completedAt: null,
        },
        {
          jobId: 'f1000000-0000-4000-8000-000000000004',
          kind: 'refunds',
          filters: {},
          columns: [],
          status: 'expired',
          failureCode: null,
          fileName: null,
          sizeBytes: null,
          rowCount: 8,
          sha256: null,
          requestedBy: USER_ID,
          asOf: iso(now - 9 * DAY),
          generatedAt: iso(now - 9 * DAY),
          expiresAt: iso(now - 2 * DAY),
          createdAt: iso(now - 9 * DAY),
          completedAt: iso(now - 9 * DAY),
        },
      ]);
  return {
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'merchantOps.exports.list':
          return ok(
            route,
            page(
              jobs.filter(
                (j) =>
                  (!input.kind || j.kind === input.kind) &&
                  (!input.status || j.status === input.status) &&
                  (!input.search || j.jobId === input.search) &&
                  (!input.from || j.createdAt >= input.from) &&
                  (!input.to || j.createdAt < input.to),
              ),
              input,
            ),
          );
        case 'merchantOps.exports.create': {
          if (!KINDS.includes(input.kind)) return refuse(route, 400, 'pay.export_filter_invalid');
          const prior = jobs.find((j) => j.requestId === input.requestId);
          if (prior) return ok(route, prior);
          const job = {
            jobId: `f2${String(jobs.length).padStart(6, '0')}-0000-4000-8000-000000000000`,
            requestId: input.requestId,
            kind: input.kind,
            filters: input.filters ?? {},
            columns: input.columns ?? [],
            status: 'queued',
            failureCode: null,
            fileName: null,
            sizeBytes: null,
            rowCount: null,
            sha256: null,
            requestedBy: USER_ID,
            asOf: null,
            generatedAt: null,
            expiresAt: null,
            createdAt: iso(Date.now()),
            completedAt: null,
          };
          jobs.unshift(job);
          setTimeout(
            () =>
              Object.assign(job, {
                status: 'ready',
                fileName: `${input.kind}.csv`,
                sizeBytes: '1024',
                rowCount: 12,
                sha256: 'ef'.repeat(32),
                asOf: iso(Date.now()),
                generatedAt: iso(Date.now()),
                completedAt: iso(Date.now()),
              }),
            1500,
          );
          return ok(route, job);
        }
        case 'merchantOps.exports.expire': {
          const job = jobs.find((j) => j.jobId === input.jobId);
          if (!job) return refuse(route, 404, 'pay.export_not_found');
          if (job.status === 'running') return refuse(route, 409, 'pay.export_in_progress');
          Object.assign(job, { status: 'expired', expiresAt: iso(Date.now()), fileName: null, sizeBytes: null });
          return ok(route, job);
        }
        case 'merchantOps.exports.download': {
          const job = jobs.find((j) => j.jobId === input.jobId);
          if (!job) return refuse(route, 404, 'pay.export_not_found');
          if (job.status !== 'ready') return refuse(route, 409, 'pay.export_not_ready');
          return ok(route, {
            fileName: job.fileName,
            contentType: 'text/csv; charset=utf-8',
            content: 'id,amount,asset\nTEST-1,10.5,USDT\n',
            sha256: 'cd'.repeat(32),
            rowCount: 1,
          });
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
