import {
  queryWarehouseSurface,
  resolveEtlWatermark,
  resolveWarehouseReplicaConfig,
  type CubeFactRow,
  type WarehouseLagProbe,
  type WarehouseSurfaceResult,
} from '@intafaced/contracts';
import { adminBffGate } from '@/lib/admin-bff-gate';

/**
 * Admin read path for ops.analytics Stage-1 warehouse surface (Class N).
 *
 * Honest empty/lag only — never invents trading volume. Fixture facts may be
 * POSTed for operator dry-runs.
 *
 * Live-cube law (D26-P1-O4 admin door):
 *   · ANALYTICS_REPLICA_*_URL are read and assertAnalyticsReplicaRole runs.
 *   · ANALYTICS_REPLICA_LAG_SECONDS alone is lagSource=configured — never live.
 *   · Optional lag probe (injectable) stamps lagMeasuredAt.
 *   · ANALYTICS_ETL_WATERMARK_AT absent/junk → mayLabelLive false.
 *
 * Law: docs/adr/2026-08-07-ops-analytics-warehouse-read-replica.md
 */

export const dynamic = 'force-dynamic';

/**
 * Optional production probe hook. Default: none (unit tests inject; wiring a
 * real `pg` pool is out of this residual — contracts own the probe interface +
 * ANALYTICS_REPLICA_LAG_SQL).
 */
let lagProbe: WarehouseLagProbe | null = null;

/** Test / host wiring only — not a public HTTP surface. */
export function setWarehouseLagProbeForTests(probe: WarehouseLagProbe | null): void {
  lagProbe = probe;
}

function parseFacts(body: unknown): readonly CubeFactRow[] | null {
  if (body == null || typeof body !== 'object') return null;
  const facts = (body as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return null;
  return facts as CubeFactRow[];
}

function surfaceResponse(result: WarehouseSurfaceResult): Response {
  const status = result.status === 'ok' ? 200 : result.status === 'empty' ? 200 : result.status === 'refuse' ? 400 : 503;
  return Response.json(result, { status });
}

async function runSurface(facts: readonly CubeFactRow[]): Promise<Response> {
  const etl = resolveEtlWatermark(process.env);
  const resolved = await resolveWarehouseReplicaConfig({
    env: process.env,
    probe: lagProbe,
  });

  if (resolved.status === 'refuse') {
    return Response.json(
      {
        status: 'refuse' as const,
        reason: resolved.reason,
        mayLabelLive: false as const,
        lagSource: 'unknown' as const,
        lagMeasuredAt: null,
        etlWatermark: etl.state,
        etlWatermarkAt: etl.at,
        etlNote: etl.note,
      },
      { status: 400 },
    );
  }

  const result = queryWarehouseSurface({
    replicaConfigured: resolved.replicaConfigured,
    lagSeconds: resolved.lagSeconds,
    lagMeasuredAt: resolved.lagMeasuredAt,
    lagSource: resolved.lagSource,
    facts,
    etlWatermark: etl.state,
    etlWatermarkAt: etl.at,
  });
  return surfaceResponse(result);
}

/**
 * GET — warehouse status with env-configured replica posture and no facts
 * (honest empty / unavailable). Never invents volume series.
 */
export async function GET(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;
  return runSurface([]);
}

/**
 * POST — same surface, optional fixture facts for operator dry-run.
 * Body: `{ "facts": CubeFactRow[] }`. Empty/missing facts → empty, not invent.
 */
export async function POST(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const facts = parseFacts(body) ?? [];
  return runSurface(facts);
}
