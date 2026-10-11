import { adminBffGate } from '@/lib/admin-bff-gate';
import { readFreeze, setFreeze } from '@/lib/control-plane-client';

/**
 * The console's route to the switch that halts ALL value movement (§4.2, §14.6).
 *
 * Separate from `/api/kill-switch` because it is a separate authority. Module
 * halts travel on `ADMIN_OPERATOR_TOKEN` (`admin:write`); this travels on
 * `ADMIN_TREASURY_TOKEN` (`admin:treasury`), and a console configured with only
 * the first cannot stop the money plane. `svc-edge` enforces the split
 * independently — this route respects it, it does not decide it.
 *
 * Every answer from below is passed through with its own status, including the
 * failures. An operator told the platform is halted when it is not walks away
 * from a book that is still accepting writes.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;
  const result = await readFreeze();
  return Response.json(result, { status: result.ok ? 200 : result.status });
}

export async function POST(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'a JSON body is required' }, { status: 400 });
  }

  const input = body as { frozen?: unknown; reason?: unknown };

  if (typeof input.frozen !== 'boolean') {
    return Response.json({ error: 'frozen must be a boolean' }, { status: 400 });
  }

  // Only a freeze needs a reason. A thaw clears it, because "why it is frozen"
  // is meaningless once it is not — svc-ledger's `writeFreeze` makes the same
  // argument on its own side.
  if (input.frozen && (typeof input.reason !== 'string' || input.reason.trim().length < 12)) {
    return Response.json(
      { error: 'a freeze needs a reason of at least 12 characters — halting the money plane must be explicable' },
      { status: 400 },
    );
  }

  const result = await setFreeze(input.frozen, input.frozen ? (input.reason as string).trim() : undefined);
  return Response.json(result, { status: result.ok ? 200 : result.status });
}
