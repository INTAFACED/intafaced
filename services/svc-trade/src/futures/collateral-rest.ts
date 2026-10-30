import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, requireScope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { EdgeTrust } from '../edge-trust.js';
import { HAIRCUT_UNSET } from './haircut-credit.js';
import { checkCollateralClassForMargin, COLLATERAL_CLASSES, UNSUPPORTED_COLLATERAL_CLASS } from './margin-mode.js';
import { privateRead } from '../route-inventory.js';

export interface CollateralFigures {
  free: Amount;
  posted: Amount;
  committed: Amount;
  haircutBps: number | null;
  credit: Amount | null;
  buyingPower: Amount | null;
}

export interface CollateralRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  /** The assets futures margin is posted in: the settle asset of every listed futures market. */
  settleAssets(): Promise<string[]>;
  /** The account's cash in one asset as the opening-order check reads it (`PositionService.collateralFigures`). */
  figures(userId: string, asset: string): Promise<CollateralFigures>;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, message });
}

const fmt = (value: Amount | null): string | null => (value === null ? null : formatAmount(value));

/**
 * What counts as futures margin for this account (D-margin-02): cash in each settle asset with the owner's haircut and
 * the buying power it leaves, and the classes that are refused with their code. Read-only: no ledger write port.
 */
export function registerCollateralRest(app: FastifyInstance, deps: CollateralRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

  app.get('/api/v1/futures/collateral', privateRead, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return sendError(reply, 401, 'trade.unauthenticated', 'signed principal required');
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      if (error instanceof AuthError) return sendError(reply, 403, 'trade.permission_denied', error.message);
      throw error;
    }

    const assets = [...new Set(await deps.settleAssets())].sort();
    const rows = [];
    for (const asset of assets) {
      const f = await deps.figures(principal.userId, asset);
      rows.push({
        asset,
        collateralClass: 'cash',
        counts: true,
        haircutBps: f.haircutBps,
        // Blank is "not set", never 0: the opening order refuses on the same code.
        haircutReason: f.haircutBps === null ? HAIRCUT_UNSET : null,
        free: formatAmount(f.free),
        posted: formatAmount(f.posted),
        committed: formatAmount(f.committed),
        credit: fmt(f.credit),
        buyingPower: fmt(f.buyingPower),
        buyingPowerReason: f.buyingPower === null ? HAIRCUT_UNSET : null,
      });
    }
    const refused = COLLATERAL_CLASSES.filter((c) => c !== 'cash').map((collateralClass) => {
      const check = checkCollateralClassForMargin(collateralClass);
      return {
        collateralClass,
        counts: false,
        code: check.ok ? null : (check.code ?? UNSUPPORTED_COLLATERAL_CLASS),
        message: check.ok ? null : (check.reason ?? null),
      };
    });
    return reply.send({ assets: rows, refusedClasses: refused });
  });
}
