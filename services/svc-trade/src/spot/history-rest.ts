/**
 * Public REST routes for historical tick, book and trade data downloads (RC-cex-spot-05; J-cex-spot-15 #10):
 *
 *   GET /api/v1/history/schemas                 — documented NDJSON schemas, compression, checksum algorithm, provenance
 *   GET /api/v1/history/datasets                — published dataset manifests with completeness, gaps, checksum & corrections
 *   GET /api/v1/history/datasets/:id/download   — gzipped NDJSON bytes + X-Content-SHA256 header
 *
 * Public, read-only, rate-limited at svc-edge. No account identifier or order id is ever exposed.
 */
import type { FastifyInstance } from 'fastify';
import {
  HISTORY_KINDS,
  TRADE_HISTORY_BOOK_INTERVAL_UNSET,
  TRADE_HISTORY_DATASET_NOT_FOUND,
  historyKindSchema,
} from '@intafaced/contracts/trade-history';
import { badRequest } from '../ccxt-errors.js';
import { publicRead } from '../route-inventory.js';
import { publishedHistorySchemas, type HistoryDatasetsPort } from './history-datasets.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerHistoryRestRoutes(app: FastifyInstance, history: HistoryDatasetsPort | undefined): void {
  app.get('/api/v1/history/schemas', publicRead, async (_req, reply) => {
    return reply.code(200).send(publishedHistorySchemas());
  });

  app.get<{ Querystring: { symbol?: string; kind?: string; day?: string } }>('/api/v1/history/datasets', publicRead, async (req, reply) => {
    const rawKind = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
    let kind: (typeof HISTORY_KINDS)[number] | undefined;
    if (rawKind !== '') {
      const parsed = historyKindSchema.safeParse(rawKind);
      if (!parsed.success) {
        const res = badRequest(`kind must be one of: ${HISTORY_KINDS.join(', ')}`, 'trade.validation_failed');
        return reply.code(res.status).send(res.body);
      }
      kind = parsed.data;
    }

    const rawDay = typeof req.query.day === 'string' ? req.query.day.trim() : '';
    if (rawDay !== '' && !DAY_RE.test(rawDay)) {
      const res = badRequest('day must be YYYY-MM-DD (UTC)', 'trade.validation_failed');
      return reply.code(res.status).send(res.body);
    }

    const rawSymbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const symbol = rawSymbol !== '' ? rawSymbol : undefined;
    const day = rawDay !== '' ? rawDay : undefined;

    const bookIntervalMs = history?.bookIntervalMs ?? null;
    if (kind === 'book_snapshots' && bookIntervalMs === null) {
      return reply.code(400).send({
        code: 'NotSupported',
        message: 'Historical book snapshot interval (TRADE_HISTORY_BOOK_INTERVAL_MS) is not set',
        intafacedCode: TRADE_HISTORY_BOOK_INTERVAL_UNSET,
      });
    }

    const datasets = history ? await history.listDatasets({ symbol, kind, day }) : [];
    return reply.code(200).send({
      datasets,
      bookIntervalMs,
      bookSnapshotsStatus: bookIntervalMs !== null ? 'configured' : 'unset',
      bookSnapshotsCode: bookIntervalMs !== null ? null : TRADE_HISTORY_BOOK_INTERVAL_UNSET,
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/history/datasets/:id/download', publicRead, async (req, reply) => {
    const id = req.params.id?.trim() ?? '';
    const file = history ? await history.downloadDataset(id) : null;
    if (!file) {
      return reply.code(404).send({
        code: 'OrderNotFound',
        message: 'Historical dataset not found',
        intafacedCode: TRADE_HISTORY_DATASET_NOT_FOUND,
      });
    }
    return reply
      .code(200)
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-sha256', file.sha256)
      .header('cache-control', 'public, max-age=300')
      .send(file.payloadGzip);
  });
}
